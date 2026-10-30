import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent, CodexAppServerClient, CodexRequestFailure, MemoryBindingStore, connectCodexTransport } from "../dist/codex/index.js";
import { createNativeRuntime, startAgentHostServer } from "../dist/service/index.js";
import { AgentHostClient } from "../dist/service/client.js";
import { WebSocketServer } from "ws";

const options = { command: process.execPath, args: [resolve("test/fixtures/codex-server.mjs")] };
async function setup(t) {
  const cwd = await mkdtemp(join(tmpdir(), "host-native-management-"));
  const log = join(cwd, "wire.jsonl");
  const runtime = createNativeRuntime({ id: "codex", kernel: "codex", cwd, options: { ...options, env: { CODEX_TEST_LOG: log } }, nativeAccess: { methods: ["thread/read", "skills/list"] } }, cwd);
  const server = await startAgentHostServer({ stateDirectory: cwd, token: "native-test-secret-token", runtimes: [runtime] });
  t.after(() => server.close());
  return { cwd, log, client: new AgentHostClient({ baseUrl: server.url, token: "native-test-secret-token" }) };
}
test("submissions are idempotent across concurrent clients and conflict before another execution", async t => {
  const { client } = await setup(t);
  const input = { runtimeId: "codex", sessionId: "one", requestKey: "trigger:1", input: "hello" };
  const [a, b] = await Promise.all([client.start(input), client.start(input)]);
  assert.equal(a.runId, b.runId);
  assert.equal((await client.findRun("codex", input.requestKey)).id, a.runId);
  await assert.rejects(client.start({ ...input, input: "changed" }), /request_key_conflict/);
  assert.equal((await client.runs()).length, 1);
  assert.equal((await a.wait()).status, "completed");
  assert.equal((await client.start(input)).runId, a.runId);
});


test("submission receipts and native bindings survive restart and administrative policy changes", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "host-native-restart-"));
  const config = { id: "codex", kernel: "codex", cwd, options };
  const launch = async nativeAccess => {
    const runtime = createNativeRuntime({ ...config, nativeAccess }, cwd);
    const server = await startAgentHostServer({ stateDirectory: cwd, token: "native-test-secret-token", runtimes: [runtime] });
    t.after(() => server.close());
    return { server, client: new AgentHostClient({ baseUrl: server.url, token: "native-test-secret-token" }) };
  };
  const first = await launch(undefined);
  const input = { runtimeId: "codex", sessionId: "persistent", requestKey: "durable-trigger", input: "first" };
  const original = await first.client.start(input);
  await original.wait();
  const binding = (await first.client.nativeSessions("codex").bindings()).bindings[0];
  await first.server.close();
  const second = await launch({ methods: ["thread/read"] });
  assert.equal((await second.client.findRun("codex", input.requestKey)).id, original.runId);
  assert.equal((await second.client.start(input)).runId, original.runId);
  const resumed = await second.client.start({ runtimeId: "codex", sessionId: "persistent", input: "resume" });
  assert.equal((await resumed.wait()).status, "completed");
  assert.deepEqual((await second.client.nativeSessions("codex").bindings()).bindings[0], binding);
  assert.equal((await second.client.runs()).length, 2);
});
test("native history reads do not block a live turn; structured input and pagination remain native", async t => {
  const { client, log } = await setup(t);
  const slow = await client.start({ runtimeId: "codex", sessionId: "live", input: "slow" });
  for (let n = 0; n < 100 && !(await client.nativeSessions("codex").bindings()).bindings.length; n++) await new Promise(r => setTimeout(r, 5));
  const history = await client.nativeSessions("codex").history("live", { limit: 2, cursor: "opaque", itemsView: "notLoaded" });
  assert.equal(history.items[0].id, "native-turn");
  await client.cancel(slow.runId);
  await slow.wait();
  const typed = { type: "skill", name: "test", path: "/test/SKILL.md" };
  await (await client.start({ runtimeId: "codex", sessionId: "typed", input: "task", inputItems: [typed], context: "external fact" })).wait();
  const wire = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const page = wire.find(m => m.method === "thread/turns/list");
  assert.equal(page.params.limit, 2); assert.equal(page.params.cursor, "opaque");
  assert.equal(page.params.itemsView, "notLoaded");
  const turn = wire.filter(m => m.method === "turn/start").at(-1);
  assert.deepEqual(turn.params.input.at(-1), typed);
  assert.deepEqual(turn.params.additionalContext.agent_host, { kind: "untrusted", value: "external fact" });
  assert.equal(turn.params.input.some(i => i.text === "external fact"), false);
});
test("unsupported turn pagination preserves the native error without substituting thread/read", async t => {
  const messages = [], handlers = new Set();
  const transport = {
    send(message) {
      messages.push(message);
      if (message.id === undefined) return;
      const reply = message.method === "thread/turns/list"
        ? { id: message.id, error: { code: -32601, message: "turn pagination unavailable", data: { feature: "thread/turns/list" } } }
        : { id: message.id, result: message.method === "initialize" ? { userAgent: "codex/0.165.0" }
          : { thread: { id: message.params.threadId, turns: [] } } };
      queueMicrotask(() => { for (const handler of handlers) handler(reply); });
    },
    onMessage(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    onClose() { return () => {}; }, close() {},
  };
  const native = CodexAppServerClient.attach(transport); await native.initialize();
  const bindings = new MemoryBindingStore();
  await bindings.set("bound", { threadId: "native-thread", fingerprint: "test" });
  const agent = new CodexAgent({ connect: async () => native, bindings });
  t.after(() => agent.close());
  await assert.rejects(agent.sessions.history("bound"), error => {
    assert.ok(error instanceof CodexRequestFailure);
    assert.equal(error.method, "thread/turns/list"); assert.equal(error.code, -32601);
    assert.deepEqual(error.data, { feature: "thread/turns/list" });
    return true;
  });
  assert.equal(messages.some(message => message.method === "thread/read"), false);
  assert.equal((await agent.sessions.read("bound")).thread.id, "native-thread");
  assert.deepEqual(messages.at(-1).params, { threadId: "native-thread", includeTurns: false });
});
test("an active source can fork before its unfinished turn and both native bindings remain usable", async t => {
  const { client, log } = await setup(t);
  const source = await client.start({ runtimeId: "codex", sessionId: "source", input: "wait" });
  let started;
  for (let n = 0; n < 100 && !started; n++) {
    started = (await client.events(source.runId)).events.find(({ event }) => event.type === "native.notification" && event.notification.method === "turn/started")?.event;
    if (!started) await new Promise(r => setTimeout(r, 5));
  }
  assert.ok(started, "the source has an actual in-progress native turn");
  const fork = await client.nativeSessions("codex").fork("source", "branch");
  assert.notEqual(fork.nativeSessionId, started.threadId);
  const wire = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(wire.find(m => m.method === "thread/fork").params.beforeTurnId, started.turnId);
  const branch = await client.start({ runtimeId: "codex", sessionId: "branch", input: "branch task" });
  assert.equal((await branch.wait()).status, "completed");
  await assert.rejects(client.nativeSessions("codex").fork("source", "invalid", { entryId: "one", beforeEntryId: "two" }), /fork_boundary_conflict/);
  await client.cancel(source.runId);
  assert.equal((await source.wait()).status, "cancelled");
  assert.equal((await (await client.start({ runtimeId: "codex", sessionId: "source", input: "continue" })).wait()).status, "completed");
});
test("owner initialization fields are retained before the first native request", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "host-native-initialize-"));
  const log = join(cwd, "wire.jsonl");
  const initialization = { clientInfo: { name: "mau_native_test", version: "1.0", title: "Mau" }, capabilities: { experimentalApi: true, futureCapability: { enabled: true } }, futureInitialization: { value: 42 } };
  const agent = new CodexAgent({ ...options, env: { CODEX_TEST_LOG: log }, initialization });
  t.after(() => agent.close());
  await agent.connect();
  const wire = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const sent = wire.find(m => m.method === "initialize").params;
  assert.deepEqual(sent.clientInfo, initialization.clientInfo);
  assert.deepEqual(sent.capabilities.futureCapability, initialization.capabilities.futureCapability);
  assert.deepEqual(sent.futureInitialization, initialization.futureInitialization);
});
test("adoption, native metadata operations and extension policy use explicit identities", async t => {
  const { client } = await setup(t);
  const sessions = client.nativeSessions("codex");
  await sessions.adopt("adopted", "existing-native");
  assert.equal((await sessions.read("adopted")).thread.id, "existing-native");
  assert.equal((await (await client.start({ runtimeId: "codex", sessionId: "adopted", input: "hello" })).wait()).status, "completed");
  await sessions.rename("adopted", "New title");
  await sessions.archive("adopted"); await sessions.unarchive("adopted");
  await assert.rejects(client.nativeRequest("codex", "command/exec", { command: ["true"] }), /native_method_not_allowed/);
  assert.equal((await client.nativeRequest("codex", "thread/read", { threadId: "existing-native" })).thread.id, "existing-native");
});
test("standalone tool delivery retains native source and cannot masquerade as mixed user input", async t => {
  const { client, log } = await setup(t);
  const toolOutput = { namespace: "mau", name: "send_to_session", output: "Authorized delegated task", retain: false };
  await (await client.start({ runtimeId: "codex", sessionId: "delegated", input: "", toolOutput })).wait();
  const wire = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const turn = wire.find(m => m.method === "turn/start");
  assert.deepEqual(turn.params.input, []); assert.deepEqual(turn.params.toolOutput, toolOutput);
  await assert.rejects(client.start({ runtimeId: "codex", sessionId: "mixed", input: "pretend user", toolOutput }), /invalid_request/);
  assert.equal((await client.sessions()).some(s => s.id === "mixed"), false);
});
test("native child tools keep child IDs and unrelated threads cannot inherit a root callback", async t => {
  const agent = new CodexAgent(options); t.after(() => agent.close());
  const calls = [];
  const events = await Array.fromAsync(agent.run({ sessionId: "root", cwd: process.cwd(), instructions: "", input: "child-tool", tools: [{ name: "native_probe", description: "test", inputSchema: { type: "object" }, execute: async (_, context) => { calls.push(context); return { success: true, contentItems: [] }; } }] }));
  assert.equal(calls.length, 1); assert.match(calls[0].threadId, /^child-/); assert.equal(calls[0].turnId, "child-turn");
  const answer = JSON.parse(events.find(e => e.type === "model.response").text);
  assert.equal(answer.denied.success, false); assert.equal(answer.accepted.success, true);
  assert.equal(events.at(-1).outcome.status, "completed");
});
test("a late child cannot borrow a subsequent parent run's tool grants", async t => {
  const { client } = await setup(t);
  const request = { runtimeId: "codex", sessionId: "parent", tools: [{ name: "native_probe", description: "test", inputSchema: { type: "object" } }] };
  assert.equal((await (await client.start({ ...request, input: "spawn-late-child" })).wait()).status, "completed");
  const later = await client.start({ ...request, input: "reuse-parent" });
  let pending;
  for (let n = 0; n < 100 && !pending; n++) {
    assert.equal((await client.calls(later.runId)).length, 0, "old child inherited the later run's product broker");
    pending = (await client.nativeRequests("codex")).requests.find(r => r.status === "pending" && r.params?.callId === "late-call");
    if (!pending) await new Promise(r => setTimeout(r, 5));
  }
  assert.ok(pending, "the old child remains available through the owner native extension");
  await client.resolveNativeRequest("codex", pending.id, { result: { success: true, contentItems: [] } });
  assert.equal((await later.wait()).status, "completed");
});
test("attached WebSocket transports preserve native errors and closing does not terminate the shared server", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(r => server.once("listening", r));
  t.after(() => { for (const peer of server.clients) peer.terminate(); server.close(); });
  server.on("connection", peer => peer.on("message", data => {
    const m = JSON.parse(String(data));
    if (m.method === "initialize") peer.send(JSON.stringify({ id: m.id, result: { userAgent: "codex/0.165.0", extra: { retained: true } } }));
    else if (m.id) peer.send(JSON.stringify({ id: m.id, error: { code: -32602, message: "native validation", data: { field: "kept" } } }));
  }));
  const endpoint = { type: "websocket", url: `ws://127.0.0.1:${server.address().port}` };
  const client = CodexAppServerClient.attach(await connectCodexTransport(endpoint));
  await client.initialize();
  assert.equal(client.initializeResponse.extra.retained, true);
  await assert.rejects(client.request("test"), e => e.code === -32602 && e.data.field === "kept");
  client.close();
  const next = CodexAppServerClient.attach(await connectCodexTransport(endpoint));
  await next.initialize(); next.close();
});

test("an unacknowledged turn cannot block an unrelated session's native tool", { timeout: 10_000 }, async t => {
  const handlers = new Set();
  const emit = message => { for (const handler of handlers) handler(message); };
  let releaseA, markAStarted, markBCalled, aAcknowledged = false;
  const aStarted = new Promise(resolve => { markAStarted = resolve; });
  const bCalled = new Promise(resolve => { markBCalled = resolve; });
  const transport = {
    send(message) {
      if (!message.method) {
        if (message.id === "B-tool") queueMicrotask(() => emit({ method: "turn/completed", params: { threadId: "thread-B", turn: { id: "turn-B", status: "completed" } } }));
        return;
      }
      if (message.id === undefined) return;
      if (message.method === "turn/start" && message.params.threadId === "thread-A") {
        releaseA = () => {
          if (aAcknowledged) return;
          aAcknowledged = true;
          emit({ id: message.id, result: { turn: { id: "turn-A" } } });
          emit({ method: "turn/completed", params: { threadId: "thread-A", turn: { id: "turn-A", status: "completed" } } });
        };
        markAStarted(); return;
      }
      const result = message.method === "initialize" ? { userAgent: "codex/0.165.0" }
        : message.method === "thread/start" ? { thread: { id: `thread-${message.params.developerInstructions}` } }
          : message.method === "thread/read" ? { thread: { id: message.params.threadId, source: "appServer" } }
            : message.method === "turn/start" ? { turn: { id: "turn-B" } } : {};
      queueMicrotask(() => {
        emit({ id: message.id, result });
        if (message.method === "turn/start") emit({ id: "B-tool", method: "item/tool/call", params: { threadId: "thread-B", turnId: "turn-B", callId: "B-call", tool: "probe", arguments: {} } });
      });
    },
    onMessage(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    onClose() { return () => {}; }, close() {},
  };
  const native = CodexAppServerClient.attach(transport); await native.initialize();
  const agent = new CodexAgent({ connect: async () => native });
  t.after(async () => { releaseA?.(); await agent.close(); });
  const tool = { name: "probe", description: "audit", inputSchema: {}, async execute() {
    assert.equal(aAcknowledged, false, "B's callback must complete while A's acknowledgement is withheld");
    markBCalled(); return { success: true, contentItems: [] };
  } };
  const run = label => Array.fromAsync(agent.run({ runId: label, sessionId: label, cwd: process.cwd(), instructions: label, input: "start", tools: [tool], signal: t.signal }));
  const a = run("A"); await aStarted;
  const b = run("B");
  let timer;
  try {
    await Promise.race([bCalled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("unrelated_callback_blocked_by_turn_ack")), 5000); })]);
    assert.equal((await b).at(-1).outcome.status, "completed");
    releaseA(); assert.equal((await a).at(-1).outcome.status, "completed");
  } finally { clearTimeout(timer); releaseA?.(); }
});
