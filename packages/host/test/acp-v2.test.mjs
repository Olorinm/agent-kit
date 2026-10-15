import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AcpAgent } from "../dist/acp/index.js";
import { MemoryBindingStore } from "../dist/index.js";
import { StdioJsonRpcClient } from "../dist/transport/stdio-json-rpc-client.js";

const request = {
  sessionId: "host",
  cwd: process.cwd(),
  instructions: "stable",
  context: "current",
  input: "/review",
  bindingFingerprint: "fixture-stable",
};
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-v2-"));
  const log = join(directory, "rpc.jsonl");
  const agent = new AcpAgent({
    command: process.execPath,
    args: [resolve("test/fixtures/acp-v2-server.mjs")],
    compaction: "opencode",
    ...options,
    env: { ACP_V2_LOG: log, ...options.env },
  });
  t.after(async () => {
    await agent.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    agent,
    log,
    entries: async () =>
      (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
  };
}
const run = (agent, input = {}) =>
  Array.fromAsync(agent.run({ ...request, ...input }));

test("stdio delivers a same-chunk notification before its response without blocking handler RPCs", async (t) => {
  const { agent } = await setup(t);
  const client = await agent.connect();
  const observed = [];
  let done;
  const completed = new Promise((resolve) => {
    done = resolve;
  });
  client.addNotificationHandler(async (notification) => {
    if (notification.method !== "fixture/notice") return;
    await client.request("fixture/ping", {});
    done();
  });
  const remove = client.addNotificationHandler((notification) => {
    if (notification.method === "fixture/notice") observed.push("notice");
  });
  await client.request("fixture/order", {});
  remove();
  assert.deepEqual(observed, ["notice"]);
  await completed;
});

test("stdio isolates throwing and rejecting notification subscribers without dropping receipts", async (t) => {
  const diagnostics = [];
  let diagnosticsComplete;
  const completed = new Promise((resolve) => {
    diagnosticsComplete = resolve;
  });
  const client = StdioJsonRpcClient.start({
    command: process.execPath,
    args: [resolve("test/fixtures/acp-v2-server.mjs")],
    onStderr: (message) => {
      diagnostics.push(message);
      if (diagnostics.length === 2) diagnosticsComplete();
      throw new Error("diagnostic_observer_failure");
    },
  });
  t.after(() => client.close());
  const observed = [];
  client.addNotificationHandler(() => {
    throw new Error("sync_subscriber_failure");
  });
  client.addNotificationHandler(async () => {
    await client.request("fixture/ping", {});
    throw new Error("async_subscriber_failure");
  });
  const remove = client.addNotificationHandler((notification) => {
    observed.push(notification.method);
  });
  await client.request("fixture/order", {});
  remove();
  assert.deepEqual(observed, ["fixture/notice"]);
  await completed;
  assert.equal(diagnostics.length, 2);
  assert.match(client.stderr(), /sync_subscriber_failure/);
  assert.match(client.stderr(), /async_subscriber_failure/);
  assert.match(client.stderr(), /diagnostic handler failed/);
  assert.equal(client.isClosed(), false);
  await client.request("fixture/ping", {});
});

test("OpenCode 2 preserves native child attribution, commands, context annotations and turn usage", async (t) => {
  const { agent, entries } = await setup(t);
  const events = await run(agent);
  assert.equal(events.at(-1).outcome.status, "completed");
  assert.equal(
    events.find((event) => event.type === "model.response").text,
    "/review",
  );
  assert.equal(
    events.filter((event) => event.type === "assistant.delta").length,
    1,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "native.notification" &&
        event.notification.method === "opencode/session/child_update",
    ),
  );
  assert.deepEqual(
    events.find((event) => event.type === "usage"),
    {
      type: "usage",
      runId: events[0].runId,
      scope: "turn",
      native: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
      inputTokens: 12,
      outputTokens: 7,
    },
  );
  const client = await agent.connect();
  assert.equal(agent.getInitialization(client).agentInfo.version, "2.0.29");
  assert.deepEqual(
    agent
      .getSessionCommands(client, "native-v2")
      .map((command) => command.name),
    ["compact", "review"],
  );
  assert.equal(
    agent.getOperationSupport(client).compactionTransport,
    "opencode-acp",
  );
  const log = await entries();
  assert.deepEqual(
    log.find((entry) => entry.method === "initialize").params.clientCapabilities
      .session,
    { compaction: {} },
  );
  assert.deepEqual(
    log.find((entry) => entry.method === "session/prompt").params.prompt[0],
    {
      type: "text",
      text: "stable\n\ncurrent",
      annotations: { audience: ["assistant"] },
    },
  );
});

test("OpenCode 2 preserves grants on resume, history and fork and deletes through ACP", async (t) => {
  const bindings = new MemoryBindingStore();
  const first = await setup(t, { bindings });
  await run(first.agent, { additionalDirectories: ["/shared/granted"] });
  await first.agent.close();
  const { agent, entries } = await setup(t, { bindings });
  const events = await run(agent, {
    additionalDirectories: ["/shared/granted"],
  });
  assert.equal(
    events.find((event) => event.type === "session.bound").resumed,
    true,
  );
  const history = await agent.sessions.history("host", { cwd: process.cwd() });
  assert.ok(
    history.items.some((item) => item.content?.text === "historical answer"),
  );
  const fork = await agent.sessions.fork("host", "copy", {
    cwd: process.cwd(),
  });
  assert.equal(fork.nativeSessionId, "native-fork");
  await agent.sessions.delete("host");
  assert.equal(await bindings.get("host"), undefined);
  const log = await entries();
  for (const method of ["session/resume", "session/load", "session/fork"])
    assert.deepEqual(
      log.find((entry) => entry.method === method).params.additionalDirectories,
      ["/shared/granted"],
    );
  assert.ok(log.some((entry) => entry.method === "session/delete"));
});

test("ACP caches configuration updates while no Host turn is active", async (t) => {
  const { agent, entries } = await setup(t);
  await run(agent);
  await (
    await agent.connect()
  ).request("fixture/config-change", { sessionId: "native-v2" });
  const events = await run(agent, { effort: "high" });
  assert.equal(events.at(-1).outcome.status, "completed");
  assert.ok(
    (await entries()).some(
      (entry) =>
        entry.method === "session/set_config_option" &&
        entry.params.configId === "thinking" &&
        entry.params.value === "high",
    ),
  );
});

for (const receipt of ["completed", "missing", "foreign", "failed"])
  test(`OpenCode 2 compaction requires its own native receipt: ${receipt}`, async (t) => {
    const { agent, entries } = await setup(t, {
      env: { ACP_V2_RECEIPT: receipt },
    });
    await run(agent);
    const events = await run(agent, { input: "", mode: "compact" });
    const outcome = events.at(-1).outcome;
    assert.equal(
      outcome.status,
      receipt === "completed" ? "completed" : "failed",
    );
    if (receipt === "failed") assert.equal(outcome.outcomeUnknown, false);
    if (["missing", "foreign"].includes(receipt))
      assert.equal(outcome.outcomeUnknown, true);
    assert.deepEqual(
      (await entries())
        .filter((entry) => entry.method === "session/prompt")
        .at(-1).params.prompt,
      [{ type: "text", text: "/compact" }],
    );
  });

test("Kimi rejects blob resources that its ACP implementation would silently discard", async (t) => {
  const { agent, entries } = await setup(t, { compaction: "kimi" });
  const events = await run(agent, {
    input: [
      {
        type: "resource",
        resource: {
          uri: "file:///sample.pdf",
          mimeType: "application/pdf",
          blob: "AA==",
        },
      },
    ],
  });
  assert.equal(events.at(-1).outcome.error, "native_blob_resource_unsupported");
  assert.equal(
    (await entries()).some((entry) => entry.method === "session/prompt"),
    false,
  );
});
