import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

export async function testGapsPackage(consumer) {
  const installed = join(consumer, "node_modules/@olorinm/agent-host");
  const { createNativeRuntime, startAgentHostServer } = await import(
    pathToFileURL(join(installed, "dist/service/index.js"))
  );
  const { AgentHostClient } = await import(
    pathToFileURL(join(installed, "dist/service/client.js"))
  );
  const { describeInteraction, answerInteraction } = await import(
    pathToFileURL(join(installed, "dist/interactions.js"))
  );
  assert.deepEqual(
    answerInteraction(
      describeInteraction({ method: "permission", params: { input: {} } }),
      { choice: "deny" },
    ),
    { behavior: "deny", message: "Declined by user" },
  );
  const cwd = join(consumer, "shared-interfaces");
  await mkdir(cwd);
  const fixture = resolve("test/fixtures/codex-server.mjs");
  const runtime = createNativeRuntime(
    {
      id: "codex",
      kernel: "codex",
      cwd,
      options: { command: process.execPath, args: [fixture] },
      allowedSettings: { effort: { values: ["low", "high"] } },
    },
    cwd,
  );
  const server = await startAgentHostServer({
    stateDirectory: cwd,
    token: "installed-shared-interfaces-token",
    runtimes: [runtime],
  });
  try {
    const client = new AgentHostClient({
      baseUrl: server.url,
      token: "installed-shared-interfaces-token",
    });
    assert.equal((await client.discover("codex")).discovery, "native");
    let asked = 0;
    const task = await client
      .session({
        runtimeId: "codex",
        sessionId: "installed-common",
        settings: { effort: "low" },
      })
      .run("approval");
    const result = await task.wait({
      pollMs: 10,
      onInteraction: async (i) => {
        asked++;
        assert.equal(i.kind, "approval");
        return { choice: "decline" };
      },
    });
    assert.equal(result.status, "completed");
    assert.ok(asked);
    const sessions = client.nativeSessions("codex");
    assert.ok((await sessions.history("installed-common")).items.length);
    await sessions.fork("installed-common", "installed-fork");
    assert.equal((await sessions.delete("installed-fork")).deleted, true);
    await assert.rejects(
      client
        .session({
          runtimeId: "codex",
          sessionId: "bad-settings",
          settings: { effort: "unexposed" },
        })
        .run("hello"),
      /setting/,
    );
  } finally {
    await server.close();
  }
  const cli = join(installed, "dist/service/cli.js"),
    config = join(cwd, "personal.json");
  const exec = (args) =>
    execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  exec([
    "init",
    "--config",
    config,
    "--cwd",
    cwd,
    "--command",
    process.execPath,
    "--args",
    JSON.stringify([fixture]),
  ]);
  assert.equal(
    JSON.parse(exec(["doctor", "--config", config]))[0].local.available,
    true,
  );
  assert.equal(
    JSON.parse(await readFile(config, "utf8")).runtimes[0].kernel,
    "codex",
  );
  const events = exec([
    "run",
    "--config",
    config,
    "--json",
    "--session",
    "archive-personal",
    "hello",
  ])
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.at(-1).outcome.status, "completed");
  console.log(
    "PASS installed interaction helpers, discovery, selectable settings, native history/fork/delete and personal CLI (protocol fixtures)",
  );
}
