import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { CodexAppServerClient, connectCodexTransport } from "@olorinm/agent-host/codex";
import { createNativeRuntime, startAgentHostServer } from "@olorinm/agent-host/server";
import { AgentHostClient } from "@olorinm/agent-host/client";

const inventory = JSON.parse(await readFile(new URL("../../docs/codex-native-protocol-manifest.json", import.meta.resolve("@olorinm/agent-host/codex")), "utf8"));
const protocol = inventory.versions.find((version) => version.label === "main");

// This test proves wire coverage, not the semantics/account eligibility of each method.
class RecordingTransport {
  sent = [];
  handlers = new Set();
  closed = false;
  send(message) {
    this.sent.push(structuredClone(message));
    if (message.id === undefined || !message.method) return;
    const result = message.method === "initialize"
      ? { userAgent: "codex/0.165.0", fixture: true }
      : { method: message.method, params: message.params ?? null, native: { arbitrary: [false, 0, null, "中文"] } };
    queueMicrotask(() => this.emit(message.method === "fixture/error"
      ? { id: message.id, error: { code: -32042, message: "native detail", data: { retry: false, cursor: "opaque" } } }
      : { id: message.id, result }));
  }
  emit(message) { for (const handler of this.handlers) handler(structuredClone(message)); }
  onMessage(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  onClose() { return () => {}; }
  close() { this.closed = true; }
}

async function setup(t, policy = { methods: "all", notifications: "all" }) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-native-wire-"));
  const transport = new RecordingTransport();
  const native = CodexAppServerClient.attach(transport);
  await native.initialize();
  const server = await startAgentHostServer({
    token: "native-coverage-fixture", stateDirectory: root,
    runtimes: [createNativeRuntime({ id: "codex", kernel: "codex", cwd: root,
      options: { connect: async () => native }, ...(policy ? { nativeAccess: policy } : {}) }, root)],
  });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { transport, native, client: new AgentHostClient({ baseUrl: server.url, token: "native-coverage-fixture" }) };
}

async function until(read, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, "native callback did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("every inventoried Codex request preserves arbitrary fields through the owner HTTP extension", async (t) => {
  const { client, transport } = await setup(t);
  const names = protocol.clientRequests.map((entry) => entry.method);
  assert.equal(new Set(names).size, names.length, "duplicate inventory entries");
  for (const method of names.filter((name) => name !== "initialize")) {
    const params = { futureField: { kind: "unchanged", nested: [null, true, 3, "中文"] }, threadId: "native-thread" };
    const result = await client.nativeRequest("codex", method, params);
    assert.deepEqual(result, { method, params, native: { arbitrary: [false, 0, null, "中文"] } }, method);
    assert.deepEqual(transport.sent.at(-1).params, params, method);
  }
  assert.equal(transport.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(transport.sent.filter((message) => message.method === "initialized").length, 1);
  await assert.rejects(client.nativeRequest("codex", "initialize", {}), /native_initialization_owned_by_host/);
  await assert.rejects(client.nativeNotify("codex", "initialized"), /native_initialization_owned_by_host/);
  await client.nativeNotify("codex", "fixture/futureNotification", { nested: [null, "kept"] });
  assert.deepEqual(transport.sent.at(-1), { method: "fixture/futureNotification", params: { nested: [null, "kept"] } });
});

test("every Codex notification retains payload, timestamps and future envelope fields", async (t) => {
  const { client, transport } = await setup(t);
  const before = await client.nativeEvents("codex");
  const expected = protocol.serverNotifications.map((entry, index) => ({ method: entry.method,
    params: { threadId: `native-${index}`, futurePayload: { nested: [false, null] } },
    emittedAtMs: 1700000000000 + index, futureEnvelope: { source: "native" } }));
  for (const notification of expected) transport.emit(notification);
  const page = await client.nativeEvents("codex", before.cursor, 1000, before.epoch);
  assert.equal(page.events.length, expected.length);
  page.events.forEach(({ event }, index) => assert.deepEqual(event, { type: "notification", ...expected[index] }, expected[index].method));
  assert.equal(page.hasMore, false);
});

test("every Codex server request keeps native identity and exact result or error", async (t) => {
  const { client, transport } = await setup(t);
  await client.nativeEvents("codex");
  for (const [index, entry] of protocol.serverRequests.entries()) {
    const nativeId = index % 2 ? index : `request-${index}`;
    const params = { threadId: "child-thread", turnId: "child-turn", future: { array: [true, null] } };
    const nativeRequest = { id: nativeId, method: entry.method, params, futureEnvelope: { preserved: true } };
    transport.emit(nativeRequest);
    const page = await until(() => client.nativeRequests("codex"), (page) => page.requests.some((r) => r.nativeId === nativeId));
    const request = page.requests.find((r) => r.nativeId === nativeId);
    assert.equal(request.method, entry.method); assert.deepEqual(request.params, params);
    assert.deepEqual(request.native, nativeRequest);
    const result = { nested: [null, false], exactNativeShape: entry.method };
    await client.resolveNativeRequest("codex", request.id, { result });
    await until(async () => transport.sent, (sent) => sent.some((r) => r.id === nativeId && !r.method));
    assert.deepEqual(transport.sent.find((r) => r.id === nativeId && !r.method), { id: nativeId, result });
    await client.resolveNativeRequest("codex", request.id, { result });
    await assert.rejects(client.resolveNativeRequest("codex", request.id, { result: null }), /native_response_conflict/);
  }
  transport.emit({ id: "native-error", method: "fixture/futureRequest", params: {} });
  const page = await until(() => client.nativeRequests("codex"), (p) => p.requests.some((r) => r.nativeId === "native-error"));
  const request = page.requests.find((r) => r.nativeId === "native-error");
  const error = { code: -32099, message: "caller declined", data: { decision: "declined", original: null } };
  await client.resolveNativeRequest("codex", request.id, { error });
  await until(async () => transport.sent, (sent) => sent.some((r) => r.id === "native-error"));
  assert.deepEqual(transport.sent.find((r) => r.id === "native-error"), { id: "native-error", error });
  await assert.rejects(client.nativeRequest("codex", "fixture/error", {}), (error) => {
    assert.deepEqual(error.nativeError, { kind: "remote", method: "fixture/error", code: -32042, data: { retry: false, cursor: "opaque" } });
    return true;
  });
});

test("native extension is opt-in and allowed methods fail before reaching the runtime", async (t) => {
  const disabled = await setup(t, null);
  await assert.rejects(disabled.client.nativeRequest("codex", "thread/read", {}), /native_access_not_enabled/);
  const scoped = await setup(t, { methods: ["thread/read"] });
  const before = scoped.transport.sent.length;
  await assert.rejects(scoped.client.nativeRequest("codex", "thread/delete", {}), /native_method_not_allowed/);
  assert.equal(scoped.transport.sent.length, before);
  await scoped.client.nativeRequest("codex", "thread/read", { threadId: "chosen" });
  scoped.native.close();
  assert.equal(scoped.transport.closed, true, "attached connections close through their own transport");
});

test("attached Unix transport preserves requests and releases only its own connection", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cn-"));
  const path = join(directory, "n.sock"), peers = new Set();
  const server = createServer((socket) => {
    peers.add(socket); socket.once("close", () => peers.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      socket.write(`${JSON.stringify({ id: request.id, result: request.method === "initialize"
        ? { userAgent: "codex/0.165.0" } : { method: request.method, params: request.params } })}\n`);
    });
  });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  for (let index = 0; index < 2; index++) {
    const client = CodexAppServerClient.attach(await connectCodexTransport({ type: "unix", path }));
    await client.initialize();
    assert.deepEqual(await client.request("fixture/future", { nested: [index, null] }), { method: "fixture/future", params: { nested: [index, null] } });
    client.close();
  }
});
