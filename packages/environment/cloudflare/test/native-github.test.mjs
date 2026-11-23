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

test("native Git clone, push, fetch and gh api through a local gateway fixture", {
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
  const seen = new Set();
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
        seen.add("gh");
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":42}');
      } else {
        assert.equal(injected.headers.get("authorization"), "Basic " + btoa("x-access-token:outside-only"));
        const backend = exec("git", ["http-backend"], { cwd: home, encoding: "buffer", env: { ...env,
          GIT_PROJECT_ROOT: home, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
          REQUEST_METHOD: incoming.method, QUERY_STRING: url.search.slice(1),
          REMOTE_USER: "fixture", HTTP_GIT_PROTOCOL: incoming.headers["git-protocol"] ?? "",
          CONTENT_TYPE: incoming.headers["content-type"] ?? "", CONTENT_LENGTH: incoming.headers["content-length"] ?? "",
        } });
        incoming.pipe(backend.child.stdin);
        const { stdout } = await backend;
        const headerEnd = stdout.indexOf("\r\n\r\n");
        assert.ok(headerEnd > 0);
        const contentType = /^Content-Type: ([^\r\n]+)/im.exec(stdout.subarray(0, headerEnd).toString())?.[1];
        assert.ok(contentType);
        seen.add(url.pathname.split("/").pop());
        res.writeHead(200, { "content-type": contentType });
        res.end(stdout.subarray(headerEnd + 4));
      }
    } catch (error) { t.diagnostic(String(error)); res.writeHead(500); res.end("Test upstream failed"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const remote = `http://127.0.0.1:${server.address().port}/team/project.git`;
    await git("clone", "-q", remote, "working");
    assert.equal((await git("-C", "working", "rev-parse", "HEAD")).stdout.trim(), commit);
    await git("-C", "working", "commit", "-q", "--allow-empty", "-m", "a local-only change");
    await git("-C", "working", "push", "-q", "origin", "HEAD:refs/heads/review");
    await git("-C", "seed", "fetch", "-q", remote, "refs/heads/review");
    assert.equal((await git("-C", "seed", "rev-parse", "FETCH_HEAD")).stdout, (await git("-C", "working", "rev-parse", "HEAD")).stdout);
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
  assert.deepEqual(seen, new Set(["refs", "git-upload-pack", "git-receive-pack", "gh"]));
});
