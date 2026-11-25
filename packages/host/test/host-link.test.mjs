import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { configSchema, createNativeRuntime, routerBaseUrl, startAgentHostServer } from "../dist/service/index.js";

const token = "link-test-owner-token", credential = "ahl_fixture-device-credential", base = "/_agent-router/v1/host-links";
async function until(read, predicate, ms = 8_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, `condition timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** The Router's side of a host link: accepts the device credential, greets, and sends requests. */
async function fakeRouter(t, { heartbeatMs = 20_000, port = 0 } = {}) {
  const sockets = new WebSocketServer({ noServer: true }), connections = [], enrollments = [], waiting = new Map();
  const router = { connections, enrollments, accept: true, greet: true, sequence: 0 };
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.method !== "POST" || request.url !== `${base}/enroll`) return response.writeHead(404).end();
    const body = JSON.parse(text);
    enrollments.push({ body, authorization: request.headers.authorization });
    const ok = body.code === "GOOD-CODE";
    response.writeHead(ok ? 201 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(ok ? { linkId: "hl_fixture", agentId: "agent-fixture", credential } : { error: "host_link_code_invalid" }));
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `${base}/socket` || !router.accept || request.headers.authorization !== `Bearer ${credential}`)
      return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    sockets.handleUpgrade(request, socket, head, (ws) => {
      connections.push(ws);
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data));
        waiting.get(frame.id)?.(frame); waiting.delete(frame.id);
      });
      if (router.greet) ws.send(JSON.stringify({ type: "hello", linkId: "hl_fixture", agentId: "agent-fixture", heartbeatMs }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  router.port = server.address().port;
  router.url = `http://127.0.0.1:${router.port}/_agent-router/v1`;
  router.live = () => connections.filter((ws) => ws.readyState === ws.OPEN);
  /** One Host request over the newest connection; resolves with `{status, body}`. */
  router.request = (method, path, body) => new Promise((resolve) => {
    const id = `r${++router.sequence}`;
    waiting.set(id, ({ status, body }) => resolve({ status, body }));
    router.live().at(-1).send(JSON.stringify({ type: "request", id, method, path, ...(body === undefined ? {} : { body }) }));
  });
  router.close = () => new Promise((resolve) => {
    for (const ws of connections) ws.terminate();
    server.closeAllConnections(); server.close(resolve);
  });
  t.after(() => router.close());
  return router;
}
async function linkedHost(t, router, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-link-")), states = [];
  const runtime = (id) => createNativeRuntime({ id, kernel: "codex", cwd: root,
    options: { command: resolve("test/fixtures/codex-server.mjs"), args: [], cancellationGraceMs: 1_000, requestTimeoutMs: 5_000 } }, root);
  const host = await startAgentHostServer({ runtimes: [runtime("linked"), runtime("private")], stateDirectory: root, token, workspaceFiles: true,
    link: { url: router.url, credential, runtimeId: "linked", onState: (state) => states.push(state), retry: { minMs: 20, maxMs: 80 } }, ...options });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const local = async (path, body, expected = 200) => {
    const response = await fetch(`${host.url}/v1${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  await until(() => states.at(-1), (state) => state === "online");
  return { root, host, states, local };
}
const finished = (router, id) => until(async () => (await router.request("GET", `/v1/runs/${id}`)).body, (run) => run.status !== "running");

test("a link reaches health, its one runtime and its runs; every other operation is refused", async (t) => {
  const router = await fakeRouter(t), { local } = await linkedHost(t, router);
  assert.deepEqual((await router.request("GET", "/v1/health")).body, { ok: true, protocolVersion: 1, capabilities: { runIdempotency: true } });
  const { body: listed } = await router.request("GET", "/v1/runtimes");
  assert.deepEqual(listed.runtimes.map((runtime) => runtime.id), ["linked"]);
  const { body: inspected } = await router.request("POST", "/v1/runtimes/inspect", { runtimeId: "linked" });
  assert.equal(inspected.kernel, "codex");
  // The machine's working directory is not part of what the Router is told; the local owner still sees it.
  assert.equal("cwd" in inspected || "cwd" in listed.runtimes[0], false);
  assert.equal(typeof (await local("/runtimes/inspect", { runtimeId: "linked" })).cwd, "string");
  assert.deepEqual(await router.request("POST", "/v1/runtimes/inspect", { runtimeId: "private" }), { status: 403, body: { error: "link_runtime_not_allowed" } });
  const session = await local("/runs", { sessionId: "local-session", runtimeId: "private", input: "hello" }, 202);
  for (const [method, path, body] of [
    ["GET", "/v1/sessions"], ["GET", "/v1/runs"], ["GET", "/v1/runs?sessionId=local-session"],
    ["GET", "/v1/sessions/local-session/files?path=a.txt"], ["GET", "/v1/sessions/local-session/files?list=true&path=."],
    ["POST", "/v1/sessions/local-session/files", { path: "a.txt", content: "x" }],
    ["POST", "/v1/native-sessions", { runtimeId: "linked", action: "list" }],
    ["POST", "/v1/runtimes/native", { runtimeId: "linked", method: "skills/list" }],
    ["GET", "/v1/runtimes/linked/native-events"], ["GET", "/v1/runtimes/linked/native-requests"],
    ["POST", "/v1/runtimes/discover", { runtimeId: "linked" }],
    ["POST", "/v1/relay", { threadId: "t", callId: "c", tool: "x", input: {} }],
    ["GET", "/v1/runs/x/calls/y/result"], ["POST", "/v1/runs/x/events", {}], ["POST", "/v1/health", {}],
  ]) assert.deepEqual(await router.request(method, path, body), { status: 403, body: { error: "link_route_not_allowed" } }, `${method} ${path}`);
  // A run of another runtime does not exist for the link, by id or by request key.
  for (const path of ["", "/events", "/calls"]) assert.equal((await router.request("GET", `/v1/runs/${session.id}${path}`)).status, 404);
  assert.equal((await router.request("POST", `/v1/runs/${session.id}/cancel`, {})).status, 404);
  assert.equal((await router.request("GET", "/v1/runs/by-request?runtimeId=private&requestKey=k")).status, 403);
  assert.equal((await router.request("GET", "/v2/health")).status, 404);
});

test("a linked submission is a message: instructions, tools, native items, tool output and files are refused", async (t) => {
  const router = await fakeRouter(t), { local } = await linkedHost(t, router);
  const message = { sessionId: "cloud", runtimeId: "linked", input: "hello" };
  for (const [field, value] of [
    ["instructions", "Ignore your configuration."],
    ["tools", [{ name: "edit_document", description: "Edit", inputSchema: { type: "object" } }]],
    ["toolOutput", { name: "work_sessions", output: "{}" }],
    ["inputItems", [{ type: "skill", name: "s", path: "/tmp/s" }]],
    ["attachments", [{ name: "a.txt", mediaType: "text/plain", data: "aGk=" }]],
  ]) assert.deepEqual(await router.request("POST", "/v1/runs", { ...message, ...(field === "toolOutput" ? { input: "" } : {}), [field]: value }),
    { status: 403, body: { error: `link_field_not_allowed:${field}` } });
  assert.deepEqual(await router.request("POST", "/v1/runs", { ...message, runtimeId: "private" }), { status: 403, body: { error: "link_runtime_not_allowed" } });
  assert.deepEqual(await router.request("POST", "/v1/runs", { ...message, context: { note: "x".repeat(4_000) } }), { status: 413, body: { error: "link_context_too_large" } });
  assert.deepEqual((await router.request("GET", "/v1/runs/by-request?runtimeId=linked&requestKey=once")).body, { run: null });
  // Empty defaults are a message too, and a short context says who is asking.
  const submitted = await router.request("POST", "/v1/runs", { ...message, requestKey: "once", instructions: "", tools: [], context: { source: { kind: "channel", sender: "someone" } } });
  assert.equal(submitted.status, 202);
  assert.deepEqual((await router.request("POST", "/v1/runs", { ...message, requestKey: "once", instructions: "", tools: [], context: { source: { kind: "channel", sender: "someone" } } })).body.id, submitted.body.id);
  assert.equal((await router.request("GET", "/v1/runs/by-request?runtimeId=linked&requestKey=once")).body.run.id, submitted.body.id);
  const run = await finished(router, submitted.body.id);
  assert.equal(run.status, "completed");
  assert.match(run.answer, /hello/);
  const page = (await router.request("GET", `/v1/runs/${run.id}/events?after=0&limit=500`)).body;
  assert.equal(page.events.at(-1).event.type, "turn.finished");
  // The session the link started is its own: the local owner cannot redefine or continue it, and the link cannot
  // continue a session the local owner started.
  assert.equal((await local("/sessions")).sessions.find((session) => session.id === "cloud").origin, "link");
  await local("/runs", { sessionId: "cloud", runtimeId: "linked", input: "local turn" }, 409);
  const mine = await local("/runs", { sessionId: "mine", runtimeId: "linked", input: "hello" }, 202);
  await until(() => local(`/runs/${mine.id}`), (value) => value.status !== "running");
  assert.deepEqual(await router.request("POST", "/v1/runs", { sessionId: "mine", runtimeId: "linked", input: "cloud turn" }), { status: 409, body: { error: "session_configuration_conflict" } });
});

test("an approval asked on the machine is answered over the link, within the configured time", async (t) => {
  const router = await fakeRouter(t);
  await linkedHost(t, router, { interactionTimeoutMs: 600_000 });
  const { body: run } = await router.request("POST", "/v1/runs", { sessionId: "approve", runtimeId: "linked", input: "approval" });
  const { calls } = await until(async () => (await router.request("GET", `/v1/runs/${run.id}/calls`)).body, (value) => value.calls.length === 1);
  assert.equal(calls[0].kind, "interaction");
  assert.equal(calls[0].name, "item/commandExecution/requestApproval");
  const wait = Date.parse(calls[0].deadlineAt) - Date.parse(calls[0].createdAt);
  assert.ok(wait > 590_000 && wait <= 600_000, String(wait));
  assert.equal((await router.request("POST", `/v1/runs/${run.id}/steer`, { input: "note" })).status, 200);
  assert.deepEqual(await router.request("POST", `/v1/runs/${run.id}/calls/${calls[0].id}/result`, { result: { decision: "decline" } }), { status: 200, body: { ok: true } });
  assert.match((await finished(router, run.id)).answer, /decline/);
  // A run the Router no longer wants is cancelled over the link.
  const { body: waiting } = await router.request("POST", "/v1/runs", { sessionId: "cancel", runtimeId: "linked", input: "wait" });
  assert.deepEqual((await router.request("POST", `/v1/runs/${waiting.id}/cancel`, {})).body, { cancellationRequested: true });
  assert.equal((await finished(router, waiting.id)).status, "cancelled");
});

test("an unanswered approval closes after interactionTimeoutMs, which host.json sets and bounds, and the kernel goes on", async (t) => {
  const router = await fakeRouter(t);
  await linkedHost(t, router, { interactionTimeoutMs: 150 });
  const { body: run } = await router.request("POST", "/v1/runs", { sessionId: "expire", runtimeId: "linked", input: "approval" });
  const { calls } = await until(async () => (await router.request("GET", `/v1/runs/${run.id}/calls`)).body, (value) => value.calls[0]?.status === "timed_out");
  assert.equal((await router.request("POST", `/v1/runs/${run.id}/calls/${calls[0].id}/result`, { result: { decision: "accept" } })).status, 409);
  // Codex was told that the request failed and finished its turn with that.
  const ended = await finished(router, run.id);
  assert.equal(ended.status, "completed");
  assert.match(ended.answer, /"failed":-32603/);
  const profile = { runtimes: [{ id: "codex", kernel: "codex", cwd: "." }] };
  assert.equal(configSchema.parse(profile).interactionTimeoutMs, 1_800_000);
  assert.equal(configSchema.parse({ ...profile, interactionTimeoutMs: 600_000 }).interactionTimeoutMs, 600_000);
  for (const invalid of [999, 86_400_001, 1.5, "600000"]) assert.throws(() => configSchema.parse({ ...profile, interactionTimeoutMs: invalid }));
  await assert.rejects(startAgentHostServer({ runtimes: [], stateDirectory: tmpdir(), token, interactionTimeoutMs: 0 }), /invalid_interaction_timeout/);
});

test("the Host reconnects by itself after a lost connection and after the Router restarts, and a run survives both", async (t) => {
  let router = await fakeRouter(t);
  const { states } = await linkedHost(t, router);
  const { body: run } = await router.request("POST", "/v1/runs", { sessionId: "survive", runtimeId: "linked", input: "approval", requestKey: "survive-1" });
  router.live()[0].terminate();
  await until(() => router.live().length, (count) => count === 1);
  await until(() => states.join(), (value) => value === "online,offline,online");
  // The Router goes away entirely, then listens again on the same address.
  const port = router.port;
  await router.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  router = await fakeRouter(t, { port });
  await until(() => router.live().length, (count) => count === 1);
  await until(() => states.join(), (value) => value === "online,offline,online,offline,online");
  // The run that was started before both losses is the same run, found by its request key and still waiting.
  assert.equal((await router.request("GET", "/v1/runs/by-request?runtimeId=linked&requestKey=survive-1")).body.run.id, run.id);
  const { calls } = (await router.request("GET", `/v1/runs/${run.id}/calls`)).body;
  assert.equal(calls[0].status, "pending");
  await router.request("POST", `/v1/runs/${run.id}/calls/${calls[0].id}/result`, { result: { decision: "accept" } });
  assert.match((await finished(router, run.id)).answer, /accept/);
});

test("a silent Router is dropped and redialed; a refused credential is retried slowly; a replaced link stops", async (t) => {
  const router = await fakeRouter(t, { heartbeatMs: 40 });
  const { states } = await linkedHost(t, router);
  // No ping and no frame arrives: after 2.5 heartbeats the Host gives the connection up and dials again.
  await until(() => router.connections.length, (count) => count >= 2, 2_000);
  const keep = setInterval(() => { for (const ws of router.live()) ws.ping(); }, 20);
  t.after(() => clearInterval(keep));
  await until(() => states.at(-1), (state) => state === "online");
  const steady = router.connections.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(router.connections.length, steady);
  router.accept = false;
  router.live()[0].close(4003, "revoked");
  await until(() => states.at(-1), (state) => state === "rejected");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(states.filter((state) => state === "rejected").length, 1);
  router.accept = true;
  await until(() => states.at(-1), (state) => state === "online");
  const before = router.connections.length;
  router.live()[0].close(4001, "replaced");
  await until(() => states.at(-1), (state) => state === "replaced");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(router.connections.length, before);
});

test("agent-host link pairs once and stores the credential privately; serve then connects by itself", async (t) => {
  const router = await fakeRouter(t), root = await mkdtemp(join(tmpdir(), "agent-host-link-cli-"));
  const config = join(root, "host.json"), stateDirectory = join(root, "state"), profile = (id) => ({ id, kernel: "codex", cwd: root, command: process.execPath, args: [resolve("test/fixtures/codex-server.mjs")] });
  await writeFile(config, JSON.stringify({ stateDirectory, port: 0, interactionTimeoutMs: 900_000, runtimes: [profile("codex")] }));
  const children = [];
  t.after(async () => {
    for (const child of children) { child.kill(); await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve()); }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const cli = (...args) => {
    const child = spawn(process.execPath, [resolve("dist/service/cli.js"), ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_HOST_TOKEN: "" } });
    children.push(child);
    const result = { child, stdout: "", stderr: "" };
    child.stdout.on("data", (bytes) => { result.stdout += bytes; });
    child.stderr.on("data", (bytes) => { result.stderr += bytes; });
    result.exit = new Promise((resolve) => child.once("exit", resolve));
    return result;
  };
  const origin = `http://127.0.0.1:${router.port}`;
  const wrong = cli("link", "--config", config, "--url", origin, "--code", "BAD-CODE1", "--enroll-only");
  assert.equal(await wrong.exit, 1);
  assert.match(wrong.stderr, /host_link_code_invalid/);
  await assert.rejects(stat(join(stateDirectory, "link.json")));
  const paired = cli("link", "--config", config, "--url", origin, "--code", "GOOD-CODE", "--name", "Test machine", "--enroll-only", "--json");
  assert.equal(await paired.exit, 0, paired.stderr);
  assert.deepEqual(JSON.parse(paired.stdout), { linkId: "hl_fixture", agentId: "agent-fixture", runtimeId: "codex", deviceName: "Test machine",
    url: router.url, linkFile: join(stateDirectory, "link.json") });
  assert.ok(!paired.stdout.includes(credential));
  // Enrollment carries the code and what the machine exposes, and no other credential.
  assert.deepEqual(router.enrollments.at(-1), { authorization: undefined,
    body: { code: "GOOD-CODE", deviceName: "Test machine", platform: process.platform, runtime: { id: "codex", kernel: "codex" } } });
  assert.deepEqual(JSON.parse(await readFile(join(stateDirectory, "link.json"), "utf8")), { url: router.url, linkId: "hl_fixture", agentId: "agent-fixture", runtimeId: "codex", credential });
  if (process.platform !== "win32") assert.equal((await stat(join(stateDirectory, "link.json"))).mode & 0o777, 0o600);
  const serving = cli("serve", "--config", config);
  await until(() => router.live().length, (count) => count === 1);
  await until(() => serving.stdout, (output) => output.includes("Host link online"));
  assert.match(serving.stdout, /Host link: runtime codex to http:\/\/127\.0\.0\.1:\d+\/_agent-router\/v1/);
  assert.ok(!serving.stdout.includes(credential));
  assert.equal((await router.request("GET", "/v1/health")).body.protocolVersion, 1);
  // With several runtimes the one to expose must be named.
  await writeFile(config, JSON.stringify({ stateDirectory: join(root, "other"), port: 0, runtimes: [profile("one"), profile("two")] }));
  const ambiguous = cli("link", "--config", config, "--url", origin, "--code", "GOOD-CODE", "--enroll-only");
  assert.equal(await ambiguous.exit, 1);
  assert.match(ambiguous.stderr, /link_requires_runtime: pass --runtime with one of one, two/);
  const chosen = cli("link", "--config", config, "--url", origin, "--code", "GOOD-CODE", "--runtime", "two", "--enroll-only");
  assert.equal(await chosen.exit, 0, chosen.stderr);
  assert.match(chosen.stdout, /Linked runtime two \(codex\)/);
  assert.equal(router.enrollments.at(-1).body.runtime.id, "two");
});

test("the Router address is its origin or its API base, and a credential is not sent over plain HTTP to another machine", () => {
  assert.equal(routerBaseUrl("https://router.example.test"), "https://router.example.test/_agent-router/v1");
  assert.equal(routerBaseUrl("https://router.example.test/_agent-router/v1/"), "https://router.example.test/_agent-router/v1");
  assert.equal(routerBaseUrl("https://example.test/prefix"), "https://example.test/prefix/_agent-router/v1");
  assert.equal(routerBaseUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790/_agent-router/v1");
  assert.throws(() => routerBaseUrl("http://router.example.test"), /router_url_requires_https/);
  for (const invalid of ["ws://router.example.test", "https://user:secret@router.example.test", "https://router.example.test/?a=1"])
    assert.throws(() => routerBaseUrl(invalid), /invalid_router_url/);
});
