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
  const { createAgent } = await import(
    pathToFileURL(join(installed, "adapters.js"))
  );
  const { HermesGatewayAgent, getHermesGatewayCapabilities } = await import(
    pathToFileURL(join(installed, "hermes/index.js"))
  );
  const hermes = createAgent({ kernel: "hermes", transport: "acp" });
  assert.ok(hermes instanceof HermesGatewayAgent);
  assert.equal(
    getHermesGatewayCapabilities().features["controls.compact"].status,
    "unsupported",
  );
  await hermes.close();
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
  const cwd = join(consumer, "opencode-v2-controls");
  await mkdir(cwd, { recursive: true });
  const runtime = createNativeRuntime(
    {
      id: "opencode-v2",
      kernel: "opencode",
      cwd,
      options: {
        command: process.execPath,
        args: [resolve("test/fixtures/acp-v2-server.mjs")],
      },
    },
    cwd,
  );
  const host = await startAgentHostServer({
    runtimes: [runtime],
    stateDirectory: cwd,
    token: "installed-v2-token",
    port: 0,
  });
  const client = new AgentHostClient({
    baseUrl: host.url,
    token: "installed-v2-token",
  });
  try {
    const discovered = await client.discover("opencode-v2");
    assert.equal(discovered.native.initialization.agentInfo.version, "2.0.29");
    assert.equal(
      discovered.capabilities.features["sessions.delete"].status,
      "supported",
    );
    const session = client.session({
      sessionId: "native-v2",
      runtimeId: "opencode-v2",
    });
    assert.equal(
      (await (await session.run("hello")).wait({ pollMs: 10 })).status,
      "completed",
    );
    assert.equal(
      (await (await session.compact()).wait({ pollMs: 10 })).status,
      "completed",
    );
    assert.equal(
      (await client.nativeSessions("opencode-v2").history("native-v2")).source,
      "native",
    );
    assert.equal(
      (await client.nativeSessions("opencode-v2").delete("native-v2")).deleted,
      true,
    );
  } finally {
    await host.close();
  }
  console.log(
    "PASS installed Hermes canonical adapter and OpenCode 2 ACP discovery/history/delete/compaction (protocol fixture)",
  );
}
