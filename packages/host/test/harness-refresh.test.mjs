import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createNativeRuntime,
  startAgentHostServer,
  configSchema,
  createConfiguredRuntimes,
} from "../dist/service/index.js";
import { AgentHostClient } from "../dist/service/client.js";
import { projectProgress } from "../dist/index.js";
import { createAgent } from "../dist/adapters.js";
import { AcpHostToolBridgeServer } from "../dist/acp/index.js";
import { HermesGatewayAgent, HermesAgent } from "../dist/hermes/index.js";
import { startOpenClawFixture } from "./fixtures/openclaw-gateway.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-refresh-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return root;
}

for (const kernel of ["opencode", "kimi", "hermes"])
  test(`ACP ${kernel} runtime fingerprints exclude live bridge state and retain owner configuration`, async (t) => {
    const cwd = await workspace(t);
    const provider = new AcpHostToolBridgeServer();
    t.after(() => provider.close());
    const config = {
      id: kernel,
      kernel,
      ...(kernel === "hermes" ? { transport: "acp" } : {}),
      cwd,
      model: "model-one",
      configurationRevision: "revision-one",
      options: {
        command: process.execPath,
        args: [resolve("test/fixtures/acp-server.mjs")],
        toolBridgeProvider: provider,
      },
    };
    const keyFor = async (value = config) => {
      const runtime = createNativeRuntime(value, cwd);
      try {
        return runtime.configurationKey;
      } finally {
        await runtime.close();
      }
    };
    const initialKey = await keyFor();
    await provider.prepare({
      scope: "fingerprint-test",
      bridge: {
        descriptors: [],
        async call() {
          throw new Error("unexpected_tool_call");
        },
      },
    });
    assert.equal(await keyFor(), initialKey);

    const cyclicProvider = {
      async prepare() {
        throw new Error("unexpected_bridge_prepare");
      },
      close() {},
    };
    cyclicProvider.self = cyclicProvider;
    assert.equal(
      await keyFor({
        ...config,
        options: { ...config.options, toolBridgeProvider: cyclicProvider },
      }),
      initialKey,
    );
    assert.equal(config.options.toolBridgeProvider, provider);
    for (const changed of [
      { ...config, model: "model-two" },
      { ...config, configurationRevision: "revision-two" },
      { ...config, options: { ...config.options, requestTimeoutMs: 45_000 } },
      {
        ...config,
        options: {
          ...config.options,
          clientInfo: { toolBridgeProvider: "ordinary-native-configuration" },
        },
      },
    ])
      assert.notEqual(await keyFor(changed), initialKey);
  });

test("ACP discovery reports actual history/delete support and preserves the native identity", async (t) => {
  const cwd = await workspace(t);
  for (const [kernel, fixture, expected] of [
    ["opencode", "acp-v2-server", true],
    ["kimi", "acp-control-server", false],
  ]) {
    const runtime = createNativeRuntime(
      {
        id: kernel,
        kernel,
        cwd,
        options: {
          command: process.execPath,
          args: [resolve(`test/fixtures/${fixture}.mjs`)],
        },
      },
      cwd,
    );
    try {
      const discovered = await runtime.discover();
      assert.equal(
        discovered.capabilities.features["sessions.delete"].status,
        expected ? "supported" : "unsupported",
      );
      if (expected) {
        assert.equal(
          discovered.capabilities.features["sessions.history"].status,
          "supported",
        );
        assert.equal(
          discovered.native.initialization.agentInfo.version,
          "2.0.29",
        );
      }
    } finally {
      await runtime.close();
    }
  }
});

for (const kernel of ["opencode", "kimi", "hermes"])
  test(`ACP ${kernel} discovery respects the configured resume policy after restart`, async (t) => {
    const cwd = await workspace(t);
    for (const resumeSessions of [true, false]) {
      const config = {
        id: `${kernel}-${resumeSessions}`,
        kernel,
        ...(kernel === "hermes" ? { transport: "acp" } : {}),
        cwd,
        options: {
          command: process.execPath,
          args: [resolve("test/fixtures/acp-server.mjs")],
          env: { ACP_TEST_RESOURCE: "1" },
          resumeSessions,
        },
      };
      const request = {
        sessionId: "resume-policy",
        runId: "first",
        input: "hello",
        instructions: "",
        tools: [],
        signal: new AbortController().signal,
        mode: "turn",
        onRequest: async () => undefined,
      };
      let runtime = createNativeRuntime(config, cwd);
      try {
        const discovered = await runtime.discover();
        assert.equal(discovered.native.loadSession, true);
        if (kernel === "kimi") {
          const documents = discovered.capabilities.features["input.documents"];
          assert.equal(documents.status, "supported");
          assert.match(documents.details, /text resources/);
          assert.match(
            documents.details,
            /binary blobs.*rejects them explicitly/,
          );
        }
        const resume = discovered.capabilities.features["sessions.resume"];
        assert.equal(
          resume.status,
          resumeSessions ? "supported" : "unsupported",
        );
        if (!resumeSessions)
          assert.equal(resume.reason, "configuration_required");
        const first = await Array.fromAsync(runtime.run(request));
        assert.equal(first.at(-1).outcome.status, "completed");
        await runtime.close();
        runtime = createNativeRuntime(config, cwd);
        const reopened = await Array.fromAsync(
          runtime.run({ ...request, runId: "reopened" }),
        );
        if (resumeSessions) {
          assert.equal(reopened.at(-1).outcome.status, "completed");
          assert.equal(
            reopened.find((event) => event.type === "session.bound").resumed,
            true,
          );
        } else {
          assert.deepEqual(reopened.at(-1).outcome, {
            status: "failed",
            error: "native_resume_disabled",
          });
        }
      } finally {
        await runtime.close();
      }
    }
  });

test("ACP context occupancy and non-USD costs never become invented token usage or dollars", () => {
  for (const currency of ["USD", "EUR"]) {
    const update = {
      sessionUpdate: "usage_update",
      used: 1400,
      size: 200000,
      cost: { amount: 0.02, currency },
    };
    const native = {
      type: "native.notification",
      runId: "r",
      threadId: "s",
      turnId: "t",
      notification: { method: "session/update", params: { update } },
    };
    const [preserved, usage] = projectProgress(native);
    assert.equal(preserved, native);
    assert.equal(usage.native, update);
    assert.equal(usage.scope, "session");
    assert.equal(usage.inputTokens, undefined);
    assert.equal(usage.outputTokens, undefined);
    assert.equal(usage.costUsd, currency === "USD" ? 0.02 : undefined);
  }
});

test("OpenClaw discovery confirms advertised operations while retaining approval configuration requirements", async (t) => {
  const cwd = await workspace(t);
  const gateway = await startOpenClawFixture({
    features: {
      methods: ["chat.send", "sessions.fork", "exec.approval.resolve"],
      events: ["chat"],
    },
  });
  const runtime = createNativeRuntime(
    { id: "openclaw", kernel: "openclaw", cwd, options: gateway },
    cwd,
  );
  try {
    const { capabilities } = await runtime.discover();
    for (const name of ["controls.steer", "sessions.fork"]) {
      assert.equal(capabilities.features[name].status, "supported");
      assert.equal(capabilities.features[name].reason, undefined);
      assert.ok(capabilities.features[name].details);
    }
    assert.equal(
      capabilities.features["sessions.history"].status,
      "conditional",
    );
    assert.equal(
      capabilities.features["sessions.history"].reason,
      "native_negotiation_required",
    );
    assert.equal(
      capabilities.features["interactions.approval"].status,
      "conditional",
    );
    assert.equal(
      capabilities.features["interactions.approval"].reason,
      "configuration_required",
    );
  } finally {
    await runtime.close();
    await gateway.close();
  }
});

for (const kernel of ["hermes", "openclaw"]) {
  test(`HTTP ${kernel} fastMode preserves native values and enforces owner-selected choices`, async (t) => {
    const cwd = await workspace(t);
    const gateway =
      kernel === "openclaw" ? await startOpenClawFixture() : undefined;
    const home = join(cwd, "hermes-home");
    const defaults = kernel === "openclaw" ? true : "normal";
    const selected = kernel === "openclaw" ? false : "cold";
    const runtime = createNativeRuntime(
      {
        id: kernel,
        kernel,
        cwd,
        fastMode: defaults,
        allowedSettings: { fastMode: { values: [selected, "ultrafast"] } },
        options: gateway
          ? { url: gateway.url, token: "fixture" }
          : {
              command: process.execPath,
              args: [resolve("test/fixtures/hermes-gateway.mjs")],
              env: { HERMES_HOME: home },
            },
      },
      cwd,
    );
    const host = await startAgentHostServer({
      runtimes: [runtime],
      stateDirectory: join(cwd, "host"),
      token: "refresh-test-token",
      port: 0,
    });
    const client = new AgentHostClient({
      baseUrl: host.url,
      token: "refresh-test-token",
    });
    try {
      for (const settings of [
        undefined,
        { fastMode: selected },
        { fastMode: "ultrafast" },
      ]) {
        const run = await client.start({
          runtimeId: kernel,
          sessionId: "native-mode",
          input: "hello",
          settings,
        });
        const result = await run.wait({ pollMs: 10 });
        assert.equal(
          result.status,
          "completed",
          JSON.stringify(result.outcome),
        );
      }
      await assert.rejects(
        client.start({
          runtimeId: kernel,
          sessionId: "native-mode",
          input: "hello",
          settings: { fastMode: "not-authorized" },
        }),
        /setting_not_allowed/,
      );
      const actual = gateway
        ? gateway.calls
            .filter((r) => r.method === "chat.send")
            .map((r) => r.params.fastMode)
        : (await readFile(join(home, "methods.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map(JSON.parse)
            .filter((r) => r.method === "config.set" && r.params.key === "fast")
            .map((r) => r.params.value);
      assert.deepEqual(actual, [defaults, selected, "ultrafast"]);
    } finally {
      await host.close();
      await gateway?.close();
    }
  });
}

test("Hermes transport selection keeps canonical ACP distinct from TUI settings and controls", async (t) => {
  const cwd = await workspace(t);
  const agent = createAgent({ kernel: "hermes", transport: "acp" });
  assert.ok(agent instanceof HermesGatewayAgent);
  await agent.close();
  const legacy = createAgent({
    kernel: "hermes",
    options: { command: "hermes" },
  });
  assert.ok(legacy instanceof HermesAgent);
  await legacy.close();
  const config = configSchema.parse({
    runtimes: [{ id: "canonical", kernel: "hermes", transport: "acp", cwd }],
  });
  const [runtime] = createConfiguredRuntimes(config, join(cwd, "host.json"));
  try {
    assert.equal(runtime.capabilities.kernel, "hermes");
    assert.equal(
      runtime.capabilities.features["controls.compact"].status,
      "unsupported",
    );
    assert.equal(runtime.supportsCompaction, false);
    assert.equal(runtime.steer, undefined);
    assert.equal(runtime.inputs.images, "negotiated");
  } finally {
    await runtime.close();
  }
  for (const key of ["provider", "effort", "fastMode"])
    assert.equal(
      configSchema.safeParse({
        runtimes: [
          { id: "bad", kernel: "hermes", transport: "acp", cwd, [key]: "auto" },
        ],
      }).success,
      false,
    );
  assert.throws(
    () =>
      createNativeRuntime(
        {
          id: "bad",
          kernel: "hermes",
          transport: "acp",
          cwd,
          allowedSettings: { fastMode: { values: ["auto"] } },
        },
        cwd,
      ),
    /setting_not_supported_by_transport/,
  );
});

for (const [kernel, fastMode] of [
  ["hermes", true],
  ["openclaw", "cold"],
])
  test(`${kernel} profile rejects invalid fastMode without unrelated validation failures`, () => {
    const profile = {
      id: kernel,
      kernel,
      cwd: process.cwd(),
      ...(kernel === "hermes"
        ? { command: "hermes" }
        : { gatewayUrl: "ws://localhost:9999" }),
    };
    assert.equal(configSchema.safeParse({ runtimes: [profile] }).success, true);
    const invalid = configSchema.safeParse({
      runtimes: [{ ...profile, fastMode }],
    });
    assert.equal(invalid.success, false);
    assert.deepEqual(
      invalid.error.issues.map((issue) => issue.path),
      [["runtimes", 0, "fastMode"]],
    );
  });
