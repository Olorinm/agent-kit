import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createDockerProvider } from "../dist/index.js";

// Needs a Docker daemon and, for the first build, the node:24-trixie-slim base image.
// Run with AGENT_ENVIRONMENT_DOCKER_TEST=1; it is skipped everywhere else, CI included.
const skip = process.env.AGENT_ENVIRONMENT_DOCKER_TEST !== "1" && "set AGENT_ENVIRONMENT_DOCKER_TEST=1 to run against a local Docker daemon";
const collect = async stream => { let stdout = "", stderr = ""; for await (const c of stream) if (c.stream === "stdout") stdout += c.text; else stderr += c.text; return { stdout, stderr }; };
// Stands where Agent Host would: counts its starts on disk and serves that count as the unprivileged user.
const start = `#!/bin/sh
set -eu
echo start >> /home/user/starts
chown -R user:user /home/user
exec runuser -u user -- node -e 'require("node:http").createServer((q,s)=>s.end(require("node:fs").readFileSync("/home/user/starts","utf8").trim().split("\\n").length+" "+process.getuid()+" "+process.env.GREETING)).listen(37420,"0.0.0.0")'
`;
test("a real Docker daemon runs the whole environment lifecycle", { skip, timeout: 600000 }, async t => {
  const provider = createDockerProvider({ id: "test-" + randomBytes(4).toString("hex") });
  let id;
  t.after(() => { if (id) execFileSync("docker", ["rm", "--force", "--volumes", `agent-environment-${provider.id}-${id}`], { stdio: "ignore" }); });
  const answer = async () => {
    const { url, headers } = await provider.httpEndpoint(id, 37420);
    for (let i = 0; ; i++) {
      try { return await (await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).text(); }
      catch (error) { if (i === 40) throw error; await sleep(250); }
    }
  };
  ({ id } = await provider.create({ template: "node24", timeoutSeconds: 600, onTimeout: "pause", env: { GREETING: "hello there" }, metadata: { owner: "integration" }, modelServices: ["openai"] }));
  assert.deepEqual(await provider.info(id), { provider: provider.id, id, state: "running", template: "node24", metadata: { owner: "integration" } });
  assert.deepEqual((await provider.list({ owner: "integration" })).map(x => x.id), [id]);
  assert.deepEqual(await provider.list({ owner: "someone else" }), []);

  let exit;
  const identity = await collect(provider.exec(id, ["sh", "-c", "id -un; pwd; echo $GREETING $EXTRA; id -un user; echo oops >&2; exit 7"], { cwd: "/opt/agent-environment", env: { EXTRA: "more" }, onExit: e => exit = e.exitCode }));
  assert.deepEqual([identity, exit], [{ stdout: "root\n/opt/agent-environment\nhello there more\nuser\n", stderr: "oops\n" }, 7]);
  assert.match((await collect(provider.exec(id, ["node", "--version"]))).stdout, /^v24\./);

  const data = Uint8Array.from([0, 255, 128, 42, 10]);
  await provider.writeFile(id, "/home/user/workspace/中文/data.bin", data);
  assert.deepEqual(await provider.readFile(id, "/home/user/workspace/中文/data.bin"), data);
  assert.deepEqual((await provider.listFiles(id, "/home/user/workspace")).map(x => [x.path, x.size]), [["/home/user/workspace/中文/data.bin", 5]]);
  assert.equal((await collect(provider.exec(id, ["stat", "-c", "%U %a", "/home/user/workspace/中文/data.bin"]))).stdout, "root 644\n");
  await assert.rejects(provider.readFile(id, "/absent"), { code: "file_not_found" });

  await assert.rejects(collect(provider.exec(id, ["sh", "-c", "sleep 300 & exec sleep 300"], { timeoutSeconds: 1 })), { code: "execution_uncertain" });
  assert.equal(provider.hasUncertainExecution(id), true);
  await assert.rejects(provider.pause(id), { code: "execution_uncertain" });
  provider.resetExecutionUncertainty(id);
  assert.equal((await collect(provider.exec(id, ["sh", "-c", "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done"]))).stdout.includes("sleep 300"), false);

  await provider.writeFile(id, "/opt/agent-environment/start.sh", start);
  assert.equal(await answer(), "1 1001 hello there");
  await provider.pause(id);
  assert.equal((await provider.info(id)).state, "paused");
  await assert.rejects(provider.httpEndpoint(id, 37420), { code: "environment_not_running" });
  await assert.rejects(collect(provider.exec(id, ["true"])), { code: "environment_not_running" });
  assert.equal((await provider.resume(id, 600, { modelServices: ["openai"] })).state, "running");
  assert.equal(await answer(), "2 1001 hello there");
  assert.deepEqual(await provider.readFile(id, "/home/user/workspace/中文/data.bin"), data);
  assert.equal((await collect(provider.exec(id, ["stat", "-c", "%U", "/home/user/workspace/中文/data.bin"]))).stdout, "user\n");

  await provider.destroy(id);
  assert.equal((await provider.info(id)).state, "missing");
  assert.deepEqual(await provider.list(), []);
});
