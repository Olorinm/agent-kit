import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Load implementation and declarations only from the installed public archive. */
export async function testCapabilitiesPackage(consumer) {
  const installed = join(consumer, "node_modules/@olorinm/agent-host/dist");
  const { getKernelCapabilities } = await import(
    pathToFileURL(join(installed, "capabilities.js"))
  );
  const { createNativeRuntime, startAgentHostServer } = await import(
    pathToFileURL(join(installed, "service/index.js"))
  );
  const { AgentHostClient } = await import(
    pathToFileURL(join(installed, "service/client.js"))
  );
  assert.equal(
    getKernelCapabilities("pi").features["sessions.delete"].reason,
    "native_not_supported",
  );
  for (const kernel of ["opencode", "kimi"]) {
    const root = join(consumer, kernel + "-controls");
    await mkdir(root, { recursive: true });
    const config = {
      id: kernel,
      kernel,
      cwd: root,
      options: {
        command: resolve("test/fixtures/acp-control-server.mjs"),
        args: [],
        requestTimeoutMs: 5_000,
      },
    };
    let server;
    const launch = async () => {
      server = await startAgentHostServer({
        runtimes: [createNativeRuntime(config, root)],
        stateDirectory: root,
        token: "installed-controls-owner-token",
      });
      return new AgentHostClient({
        baseUrl: server.url,
        token: "installed-controls-owner-token",
      });
    };
    try {
      let client = await launch();
      assert.equal(
        (await client.inspect(kernel)).capabilities.features["controls.compact"]
          .status,
        "conditional",
      );
      const settings = { sessionId: "installed-product", runtimeId: kernel };
      assert.equal(
        (
          await (
            await client.session(settings).run("hello")
          ).wait({ pollMs: 10 })
        ).status,
        "completed",
      );
      await server.close();
      client = await launch();
      const task = await client.session(settings).compact();
      let binding;
      const result = await task.wait({
        pollMs: 10,
        signal: AbortSignal.timeout(10_000),
        onEvent: ({ event }) => {
          if (event.type === "session.bound") binding = event;
        },
      });
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(binding.resumed, true);
      assert.equal(binding.threadId, "native-control-session");
    } finally {
      await server?.close();
    }
  }
  console.log(
    "PASS installed capability API and OpenCode/Kimi HTTP compaction after restart (protocol fixtures)",
  );
}
