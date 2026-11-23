import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { injectServiceAuth } from "../src/credentials.mjs";
import { allowEgress } from "../src/egress.mjs";

const exec = promisify(execFile);
const available = name => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;

test("native HTTPS Git discovery and gh api through a local gateway fixture", {
  skip: process.platform === "win32" || !available("git") || !available("gh") ? "requires Git, gh and Unix sockets" : false,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), "github-gateway-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
    GH_CONFIG_DIR: join(home, "gh"), GH_NO_UPDATE_NOTIFIER: "1", HTTPS_PROXY: "http://127.0.0.1:1" };
  const git = (...args) => exec("git", args, { cwd: home, env });
  await git("init", "-q", "-b", "main", "seed");
  await git("-C", "seed", "commit", "-q", "--allow-empty", "-m", "test");
  await mkdir(join(home, "team"));
  await git("clone", "-q", "--bare", "seed", "team/project.git");
  const commit = (await git("-C", "seed", "rev-parse", "HEAD")).stdout.trim();
  const credential = { service: "github", mode: "token", accessToken: "outside-only" };
  const seen = [];
  const server = createServer(async (incoming, res) => {
    try {
      const api = incoming.headers.host === "api.github.com";
      const url = new URL(incoming.url, api ? "https://api.github.com" : "https://github.com");
      assert.ok(allowEgress(url.href, incoming.method, [], { github: "fixture" }));
      const request = new Request(url, { method: incoming.method, headers: incoming.headers });
      assert.doesNotMatch(request.headers.get("authorization") ?? "", /outside-only/);
      const injected = injectServiceAuth(request, "github", credential);
      if (api) {
        assert.match(request.headers.get("authorization") ?? "", /^(token|Bearer) gateway-managed$/i);
        assert.equal(injected.headers.get("authorization"), "Bearer outside-only");
        seen.push("gh");
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":42}');
      } else {
        assert.equal(injected.headers.get("authorization"), "Basic " + btoa("x-access-token:outside-only"));
        const backend = await exec("git", ["http-backend"], { cwd: home, encoding: "buffer", env: { ...env,
          GIT_PROJECT_ROOT: home, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
          REQUEST_METHOD: incoming.method, QUERY_STRING: url.search.slice(1),
        } });
        const headerEnd = backend.stdout.indexOf("\r\n\r\n");
        assert.ok(headerEnd > 0);
        seen.push("git");
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
        res.end(backend.stdout.subarray(headerEnd + 4));
      }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await git("-c", "protocol.version=0", "ls-remote", `http://127.0.0.1:${server.address().port}/team/project.git`, "refs/heads/main");
    assert.equal(result.stdout.trim(), commit + "\trefs/heads/main");
  } finally { await new Promise(resolve => server.close(resolve)); }
  const socket = join(home, "gh.sock");
  await mkdir(env.GH_CONFIG_DIR);
  await writeFile(join(env.GH_CONFIG_DIR, "config.yml"), "http_unix_socket: " + socket + "\n");
  await writeFile(join(env.GH_CONFIG_DIR, "hosts.yml"), "github.com:\n    oauth_token: gateway-managed\n    git_protocol: https\n");
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    const result = await exec("gh", ["api", "repos/team/project"], { cwd: home, env });
    assert.deepEqual(JSON.parse(result.stdout), { id: 42 });
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(seen, ["git","gh"]);
});
