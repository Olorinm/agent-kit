import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HermesGatewayAgent } from "../dist/hermes/index.js";
import { AcpHostToolBridgeServer } from "../dist/acp/index.js";
import { MemoryBindingStore } from "../dist/index.js";

// Protocol fixture only. Native canonical authority probes are recorded separately.
const request = {
  sessionId: "hermes-canonical",
  cwd: process.cwd(),
  instructions: "Stable",
  input: "hello",
};
test("Hermes canonical integration reuses ACP continuation and viewer teardown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-canonical-acp-"));
  const log = join(directory, "protocol.jsonl");
  const bindings = new MemoryBindingStore();
  const options = {
    command: process.execPath,
    args: [resolve("test/fixtures/acp-server.mjs")],
    bindings,
    env: { ACP_TEST_LOG: log },
  };
  const first = new HermesGatewayAgent(options);
  t.after(() => first.close());
  const initial = await Array.fromAsync(first.run(request));
  assert.equal(initial.at(-1).outcome.status, "completed");
  const binding = await bindings.get(request.sessionId);
  first.close();
  const reopened = new HermesGatewayAgent(options);
  t.after(() => reopened.close());
  const resumed = await Array.fromAsync(
    reopened.run({ ...request, input: "follow up" }),
  );
  assert.equal(resumed.at(-1).outcome.status, "completed");
  assert.equal(
    resumed.find((event) => event.type === "session.bound").resumed,
    true,
  );
  assert.equal(
    (await bindings.get(request.sessionId)).threadId,
    binding.threadId,
  );
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
  assert.equal(
    calls.some(
      (call) =>
        call.method === "session/load" || call.method === "session/resume",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.method === "gateway.stop" || call.method === "session/delete",
    ),
    false,
  );
});

test("Hermes canonical discovery keeps Gateway-only and TUI-only controls distinct", async () => {
  const { getHermesGatewayCapabilities } =
    await import("../dist/hermes/index.js");
  const capabilities = getHermesGatewayCapabilities("http");
  assert.equal(capabilities.kernel, "hermes");
  assert.equal(capabilities.mode, "http");
  for (const name of ["sessions.delete", "controls.steer", "controls.compact"])
    assert.equal(capabilities.features[name].status, "unsupported");
  for (const name of [
    "sessions.resume",
    "sessions.list",
    "sessions.history",
    "sessions.fork",
  ])
    assert.equal(capabilities.features[name].status, "conditional");
  assert.equal(
    capabilities.features["tools.product"].reason,
    "native_negotiation_required",
  );
});

test("Hermes product MCP specification survives viewer history, fork and Host replacement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-stable-mcp-"));
  const log = join(directory, "protocol.jsonl");
  const bindings = new MemoryBindingStore();
  const providers = [];
  const agents = [];
  const createAgent = () => {
    const provider = new AcpHostToolBridgeServer(
      "agent-host",
      "AGENT_HOST_TOOL",
      {
        connectionDirectory: join(directory, "connections"),
      },
    );
    const agent = new HermesGatewayAgent({
      command: process.execPath,
      args: [resolve("test/fixtures/acp-server.mjs")],
      bindings,
      env: { ACP_TEST_LOG: log },
      toolBridgeProvider: provider,
    });
    providers.push(provider);
    agents.push(agent);
    return agent;
  };
  t.after(async () => {
    for (const agent of agents) await agent.close();
    for (const provider of providers) provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  let calls = 0;
  const tools = [
    {
      name: "record",
      description: "Record a value",
      inputSchema: { type: "object" },
      async execute() {
        calls++;
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "recorded" }],
        };
      },
    },
  ];
  const run = async (agent, sessionId = request.sessionId) => {
    const events = await Array.fromAsync(
      agent.run({ ...request, input: "tool", tools, sessionId }),
    );
    assert.equal(
      events.at(-1).outcome.status,
      "completed",
      JSON.stringify(events.at(-1)),
    );
    return events;
  };
  const first = createAgent();
  await run(first);
  await first.sessions.history(request.sessionId);
  const child = await first.sessions.fork(request.sessionId, "child");
  await run(first, "child");
  await first.close();
  providers[0].close();
  const reopened = await run(createAgent(), "child");
  assert.equal(calls, 3);
  assert.equal(
    reopened.find((event) => event.type === "session.bound").threadId,
    child.nativeSessionId,
  );
  assert.equal(
    (await bindings.get("child")).configurationSessionId,
    request.sessionId,
  );
  const specs = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter(
      (call) =>
        ["session/new", "session/load"].includes(call.method) &&
        call.params.mcpServers?.length,
    )
    .map((call) => call.params.mcpServers);
  assert.equal(specs.length, 3);
  for (const spec of specs) assert.deepEqual(spec, specs[0]);
});
