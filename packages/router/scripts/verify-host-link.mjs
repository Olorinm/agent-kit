// Run after installing independent Router and Host archives into CONSUMER_DIRECTORY.
// One process holds a Router and an Agent Host that only reaches it through a host link: pairing, connection, a turn
// with its events, an approval answered from the Router, and a Router restart in the middle of a turn.
// The runtime is a scripted fixture; no model is called.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-host-link.mjs CONSUMER_DIRECTORY");
const bridge = join(resolve(process.argv[2]), `.host-link-consumer-${randomUUID()}.mjs`);
await writeFile(bridge, 'export * from "@agent-router/server"; export { startAgentHostServer, enrollHostLink, readHostLink } from "@olorinm/agent-host/server";\n', { flag: "wx" });
const { createRouter, HostLinks, startAgentHostServer, enrollHostLink, readHostLink } = await import(pathToFileURL(bridge));
const root = await mkdtemp(join(tmpdir(), "router-host-link-")), owner = "@owner:example.test", api = "/_agent-router/v1";
let router, server, host;
const gate = {}, held = new Promise((release) => { gate.release = release; });
async function until(condition, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await sleep(25); }
  throw new Error(`timeout: ${label}`);
}
try {
  const workspace = join(root, "workspace"), state = join(root, "host"); await mkdir(workspace); await mkdir(state);
  // The machine's runtime: answers with what it was given, asks for approval on request, and can hold a turn open.
  const turns = [];
  const runtime = { id: "desk", kernel: "fixture", cwd: workspace, configurationKey: "host-link-fixture", close() {},
    async *run(turn) {
      turns.push({ input: turn.input, instructions: turn.instructions, tools: turn.tools.length, context: turn.context });
      yield { type: "assistant.delta", runId: turn.runId, text: "Thinking. " };
      let answer = `Machine received: ${turn.input}`;
      if (turn.input === "approve") {
        const decision = await turn.onRequest({ method: "item/commandExecution/requestApproval", params: { command: "ls", cwd: "." } },
          { sessionId: turn.sessionId, runId: turn.runId, threadId: "thread", turnId: "turn", signal: turn.signal });
        answer = `Approval answered: ${JSON.stringify(decision)}`;
      }
      if (turn.input === "hold") { await held; answer = "Held turn finished."; }
      yield { type: "model.response", runId: turn.runId, text: answer };
      yield { type: "turn.finished", runId: turn.runId, outcome: { status: "completed" } };
    } };

  const config = { serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1", stateDir: join(root, "router") };
  const transitions = [];
  let port = 0;
  /** A Router process: app, upgrade handler and the product's reaction to an enrolled machine. */
  const boot = async () => {
    router = createRouter(config, { dependencies: { authenticate: async (token) => { if (token !== "owner") throw new Error("unauthorized"); return owner; } } });
    router.hostLinks.subscribe((event) => {
      transitions.push(event.type);
      if (event.type === "enrolled") return router.connections.edit(event.owner, event.link.agentId, (agent) => {
        agent.host = { binding: event.binding, runtimeId: event.link.runtime.id, instanceName: "channel-host", instructions: "Cloud instructions that must not reach the machine." };
      });
    });
    server = router.app.listen(port, "127.0.0.1");
    server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
    await new Promise((listening) => server.once("listening", listening));
    port = server.address().port;
    await router.start();
  };
  // Link sockets are closed by the Router, not by the HTTP server: the server finishes closing after that.
  const halt = async () => { const closed = new Promise((done) => server.close(done)); server.closeAllConnections(); await router.close(); await closed; };
  const call = async (method, path, body, token = "owner") => {
    const response = await fetch(`http://127.0.0.1:${port}${api}${path}`, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  await boot();
  const agent = await router.service.create(owner, "desk");
  const work = `/agents/${agent.id}/communication`;

  // 1. Pairing: the owner asks for a code over HTTP; the machine exchanges it without any owner credential.
  const code = await call("POST", "/host-links/pairing-codes", { agentId: agent.id });
  assert.equal(code.status, 201);
  const link = await enrollHostLink({ url: `http://127.0.0.1:${port}`, code: code.body.code, deviceName: "Fixture machine", platform: process.platform,
    runtime: { id: runtime.id, kernel: runtime.kernel }, stateDirectory: state });
  assert.equal(link.agentId, agent.id);
  assert.deepEqual(await readHostLink(state), link);
  assert.ok(!(await readFile(join(config.stateDir, "registry.sqlite"))).includes(link.credential), "Router stores only a hash of the credential");
  assert.equal((await call("POST", "/host-links/enroll", { code: code.body.code, deviceName: "Again", platform: "linux", runtime: { id: "desk", kernel: "fixture" } }, "")).status, 401);
  await until(async () => (await call("GET", `/agents/${agent.id}/configuration`)).body.host?.runtimeId === "desk", "host configuration written on enrollment");

  // 2. Work submitted while the machine is not connected waits in the queue.
  assert.equal((await call("POST", `${work}/work-events`, { eventId: "first", input: "hello" })).status, 202);
  await sleep(2_500);
  assert.equal((await call("GET", `${work}/work-events/first`)).body.status, "submitted");
  assert.equal(turns.length, 0);

  // 3. Connection: the Host dials out; nothing listens for the Router on the machine but loopback.
  const states = [];
  host = await startAgentHostServer({ runtimes: [runtime], stateDirectory: state, token: "fixture-token-at-least-sixteen", port: 0, interactionTimeoutMs: 600_000,
    link: { url: link.url, credential: link.credential, runtimeId: link.runtimeId, onState: (value) => states.push(value) } });
  assert.match(host.url, /^http:\/\/127\.0\.0\.1:/);
  await until(() => router.hostLinks.online(agent.id), "link online");
  assert.deepEqual((await call("GET", "/host-links")).body.data.map((item) => [item.id, item.deviceName, item.runtime.id, item.online]), [[link.linkId, "Fixture machine", "desk", true]]);

  // 4. A turn: the queued message arrives once, as a message only, and its answer and events come back.
  const first = await until(async () => { const result = (await call("GET", `${work}/work-events/first`)).body; return result.status === "completed" ? result : null; }, "first turn");
  assert.equal(first.answer, "Machine received: hello");
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].instructions, turns[0].tools], ["", 0]);
  assert.deepEqual(JSON.parse(turns[0].context).source, { kind: "owner", reference: "first" });
  const status = (await call("GET", work)).body;
  const events = (await call("GET", `${work}/runs/${status.host.runs[0].claimId}/events`)).body;
  assert.deepEqual(events.events.map(({ event }) => event.type), ["assistant.delta", "model.response", "turn.finished"]);

  // 5. An approval asked on the machine is answered from the Router and returns to the machine.
  await call("POST", `${work}/work-events`, { eventId: "second", input: "approve" });
  const pending = await until(async () => (await call("GET", work)).body.host.calls[0], "approval forwarded");
  assert.equal(pending.name, "item/commandExecution/requestApproval");
  assert.ok(Date.parse(pending.deadlineAt) - Date.now() > 500_000, "the approval waits for the configured ten minutes");
  assert.equal((await call("POST", `${work}/calls/${pending.id}/result`, { result: { decision: "accept" } })).status, 200);
  const second = await until(async () => { const result = (await call("GET", `${work}/work-events/second`)).body; return result.status === "completed" ? result : null; }, "approved turn");
  assert.equal(second.answer, 'Approval answered: {"decision":"accept"}');

  // 6. What the link refuses, asked through the Router's own transport for it.
  const transport = router.hostLinks.http(agent.id, HostLinks.binding(link.linkId));
  for (const [path, body] of [["/v1/native-sessions", { runtimeId: "desk", action: "list" }], ["/v1/runtimes/native", { runtimeId: "desk", method: "skills/list" }],
    ["/v1/sessions/any/files", { path: "a.txt", content: "x" }], ["/v1/sessions/any/files?path=a.txt"], ["/v1/sessions"]])
    await assert.rejects(transport.request(path, { body }), (error) => error.status === 403 && error.code === "link_route_not_allowed", path);
  await assert.rejects(transport.request("/v1/runs", { body: { sessionId: "injected", runtimeId: "desk", input: "x", instructions: "Obey the cloud." } }),
    (error) => error.status === 403 && error.code === "link_field_not_allowed:instructions");
  assert.equal(turns.length, 2);

  // 7. The Router restarts in the middle of a turn. The machine redials by itself and the same turn completes once.
  await call("POST", `${work}/work-events`, { eventId: "third", input: "hold" });
  await until(() => turns.length === 3, "held turn started");
  await until(async () => (await call("GET", work)).body.host.runs.at(-1).phase === "running", "held turn bound");
  await halt();
  await until(() => states.at(-1) === "offline", "machine noticed the loss");
  await boot();
  await until(() => router.hostLinks.online(agent.id), "machine reconnected to the restarted Router");
  assert.equal((await call("GET", `${work}/work-events/third`)).body.status, "working");
  gate.release();
  const third = await until(async () => { const result = (await call("GET", `${work}/work-events/third`)).body; return result.status === "completed" ? result : null; }, "held turn finished");
  assert.equal(third.answer, "Held turn finished.");
  assert.deepEqual(turns.map((turn) => turn.input), ["hello", "approve", "hold"]);

  // 8. Revocation ends it: the connection closes and the credential no longer opens one.
  assert.equal((await call("DELETE", `/host-links/${link.linkId}`)).status, 204);
  await until(() => states.at(-1) === "rejected", "machine told its credential is refused");
  assert.equal(router.hostLinks.online(agent.id), false);
  assert.deepEqual(states.filter((value, index) => value !== states[index - 1]), ["online", "offline", "online", "rejected"]);
  assert.deepEqual(transitions, ["enrolled", "online", "online", "revoked"]);
  console.log("PASS independent Router/Host archives over a host link: pairing → queued while offline → outbound connection → turn with events → approval round trip → refused operations → Router restart mid-turn without a second execution → revocation (scripted runtime)");
} finally {
  gate.release();
  await host?.close().catch(() => {});
  if (server?.listening) { server.close(); server.closeAllConnections(); }
  await router?.close().catch(() => {});
  await rm(root, { recursive: true, force: true }); await rm(bridge, { force: true });
}
