import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createRouter, HostLinks, HOST_LINK_SOCKET_PATH, HOST_OFFLINE, type HostLinkEvent } from "../src/server.js";
import { DurableStore } from "../src/communication/store.js";
import { PAIRING } from "../src/ledger/pairing-codes.js";
import { ChannelHttpError } from "../src/http.js";
import { until } from "./ledger-fixture.js";
import { admission, harness, WorkHost } from "./fixtures/work-harness.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const alice = "@alice:example.test", bob = "@bob:example.test", root = "/_agent-router/v1";
const device = { deviceName: "Workstation", platform: "win32", runtime: { id: "local", kernel: "codex" } };

/** What a linked Agent Host answers, scripted: runs stay `running` until the test finishes them. */
class FakeHost {
  starts: any[] = [];
  runs = new Map<string, any>();
  calls = new Map<string, any[]>();
  resolved: Array<{ callId: string; result: unknown }> = [];
  seen: string[] = [];
  /** Take the next submission, then lose the connection before answering it. */
  dropNextStart = false;
  handle(method: string, path: string, body: any, drop: () => void): { status: number; body: unknown } | undefined {
    this.seen.push(`${method} ${path.split("?")[0]}`);
    const url = new URL(path, "http://host.local"), [, , area, id, action, callId] = url.pathname.split("/");
    if (path === "/v1/health") return { status: 200, body: { ok: true, protocolVersion: 1, capabilities: { runIdempotency: true } } };
    if (path === "/v1/runtimes") return { status: 200, body: { runtimes: [{ id: "local" }] } };
    if (area !== "runs") return { status: 403, body: { error: "link_route_not_allowed" } };
    if (method === "POST" && !id) {
      let run = [...this.runs.values()].find((item) => item.requestKey === body.requestKey);
      if (!run) {
        this.starts.push(body);
        run = { id: `run-${this.starts.length}`, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "running", answer: "", requestKey: body.requestKey };
        this.runs.set(run.id, run);
      }
      if (this.dropNextStart) { this.dropNextStart = false; drop(); return undefined; }
      return { status: 202, body: this.view(run) };
    }
    if (id === "by-request") {
      const run = [...this.runs.values()].find((item) => item.requestKey === url.searchParams.get("requestKey"));
      return { status: 200, body: { run: run ? this.view(run) : null } };
    }
    const run = this.runs.get(id!);
    if (!run) return { status: 404, body: { error: "run_not_found" } };
    if (!action) return { status: 200, body: this.view(run) };
    if (action === "events") return { status: 200, body: { events: [], cursor: Number(url.searchParams.get("after")), hasMore: false, historyTruncated: false, liveGap: false } };
    if (action === "calls" && !callId) return { status: 200, body: { calls: this.calls.get(run.id) ?? [] } };
    if (action === "calls") {
      const call = (this.calls.get(run.id) ?? []).find((item) => item.id === callId);
      if (!call || call.status !== "pending") return { status: 409, body: { error: "call_not_pending" } };
      call.status = "completed"; this.resolved.push({ callId: callId!, result: body.result });
      return { status: 200, body: { ok: true } };
    }
    if (action === "cancel") { run.status = "cancelled"; return { status: 200, body: { cancellationRequested: true } }; }
    return { status: 404, body: { error: "route_not_found" } };
  }
  private view({ requestKey: _key, ...run }: any) { return run; }
  finish(n: number, answer: string) { Object.assign(this.runs.get(`run-${n}`), { status: "completed", answer }); }
}
/** Connects like `agent-host serve` does; resolves once Router greeted the link, or with the refused status. */
function connect(port: number, credential: string, host = new FakeHost(), options: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${HOST_LINK_SOCKET_PATH}`, { headers: { authorization: `Bearer ${credential}` }, autoPong: options.autoPong ?? true });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  cleanup.push(() => ws.terminate());
  const ready = new Promise<{ status: number; hello?: any }>((resolve) => {
    ws.on("error", (error) => resolve({ status: Number(/Unexpected server response: (\d+)/.exec(error.message)?.[1] ?? 0) }));
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "hello") return resolve({ status: 101, hello: frame });
      const answer = host.handle(frame.method, frame.path, frame.body, () => ws.terminate());
      if (answer && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id: frame.id, ...answer }));
    });
  });
  return { ws, host, ready, closed };
}
/** A bare `HostLinks` over its own store and socket server, with a short heartbeat. */
function standalone(options: { heartbeatMs?: number; requestTimeoutMs?: number } = {}) {
  const store = new DurableStore(":memory:", "registry"), agents = new Map([["agent-a", alice], ["agent-b", bob]]);
  const links = new HostLinks(store, (owner, agentId) => agents.get(agentId) === owner, options), events: HostLinkEvent[] = [];
  links.subscribe((event) => { events.push(event); });
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => { if (!links.upgrade(req, socket, head)) socket.destroy(); });
  cleanup.push(() => { store.close(); });
  cleanup.push(() => new Promise<void>((r) => { links.close(); server.closeAllConnections(); server.close(() => r()); }));
  return new Promise<{ links: HostLinks; events: HostLinkEvent[]; port: number; agents: Map<string, string> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ links, events, agents, port: (server.address() as { port: number }).port })));
}

describe("host link pairing", () => {
  it("issues a code that enrolls one machine once, for one hour, and only the newest code of an agent", async () => {
    const { links } = await standalone(), now = 1_800_000_000_000;
    expect(() => links.createCode(bob, "agent-a", now)).toThrow("agent_not_found");
    const first = links.createCode(alice, "agent-a", now);
    expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(Date.parse(first.expiresAt)).toBe(now + PAIRING.ttlMs);
    const second = links.createCode(alice, "agent-a", now + 1);
    expect(() => links.enroll({ code: first.code, ...device }, "198.51.100.1", now + 2)).toThrow("host_link_code_invalid");
    // Lower case, spaces instead of the hyphen: the code is read as a person types it.
    const enrolled = links.enroll({ code: second.code.toLowerCase().replace("-", " "), ...device }, "198.51.100.2", now + 3);
    expect(enrolled).toMatchObject({ agentId: "agent-a", linkId: expect.stringMatching(/^hl_[0-9a-f]{24}$/), credential: expect.stringMatching(/^ahl_[A-Za-z0-9_-]{43}$/) });
    expect(() => links.enroll({ code: second.code, ...device }, "198.51.100.2", now + 4)).toThrow("host_link_code_invalid");
    const expired = links.createCode(alice, "agent-a", now + 5);
    expect(() => links.enroll({ code: expired.code, ...device }, "198.51.100.3", now + 5 + PAIRING.ttlMs)).toThrow("host_link_code_invalid");
    // The stored state holds neither the code nor the credential.
    const stored = JSON.stringify(links.list(alice));
    expect(stored).not.toContain(enrolled.credential);
    expect(links.list(alice)).toEqual([{ id: enrolled.linkId, agentId: "agent-a", ...device, online: false, createdAt: new Date(now + 3).toISOString(), lastOnlineAt: null }]);
    expect(links.list(bob)).toEqual([]);
  });
  it("locks a client out after five wrong codes, without affecting another client", async () => {
    const { links } = await standalone(), now = 1_800_000_000_000, valid = links.createCode(alice, "agent-a", now);
    for (let attempt = 1; attempt <= 4; attempt++)
      expect(() => links.enroll({ code: "0000-0000", ...device }, "198.51.100.9", now + attempt)).toThrow("host_link_code_invalid");
    expect(() => links.enroll({ code: "0000-0001", ...device }, "198.51.100.9", now + 5)).toThrow(expect.objectContaining({ message: "host_link_enroll_locked", status: 429 }));
    expect(() => links.enroll({ code: valid.code, ...device }, "198.51.100.9", now + 6)).toThrow("host_link_enroll_locked");
    expect(links.enroll({ code: valid.code, ...device }, "198.51.100.10", now + 7).agentId).toBe("agent-a");
    const later = now + 5 + PAIRING.lockoutMs, fresh = links.createCode(alice, "agent-a", later);
    expect(links.enroll({ code: fresh.code, ...device }, "198.51.100.9", later).agentId).toBe("agent-a");
  });
  it("keeps one link per agent: a new pairing revokes the earlier machine", async () => {
    const { links, events, port } = await standalone();
    const first = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device }, "c");
    const machine = connect(port, first.credential);
    expect((await machine.ready).status).toBe(101);
    const second = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device, deviceName: "Laptop" }, "c");
    expect(await machine.closed).toBe(4003);
    expect(links.list(alice).map((link) => [link.id, link.deviceName])).toEqual([[second.linkId, "Laptop"]]);
    expect(events.map((event) => [event.type, event.link.id])).toEqual([["enrolled", first.linkId], ["online", first.linkId], ["revoked", first.linkId], ["enrolled", second.linkId]]);
    expect(events[3]).toMatchObject({ owner: alice, binding: `link:${second.linkId}`, link: { agentId: "agent-a", runtime: device.runtime } });
    expect((await connect(port, first.credential).ready).status).toBe(401);
  });
});

describe("host link connection", () => {
  it("authenticates by device credential, carries Host requests, and reports going online and offline", async () => {
    const { links, events, port } = await standalone();
    const { linkId, credential } = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device }, "c"), binding = HostLinks.binding(linkId);
    for (const wrong of ["ahl_" + "x".repeat(43), "", credential.slice(0, -1)]) expect((await connect(port, wrong).ready).status).toBe(401);
    expect(() => links.assertReady("agent-a", binding)).toThrow(expect.objectContaining({ message: HOST_OFFLINE, status: 503 }));
    await expect(links.http("agent-a", binding).request("/v1/health")).rejects.toMatchObject({ status: 503, code: HOST_OFFLINE });
    const machine = connect(port, credential);
    expect(await machine.ready).toEqual({ status: 101, hello: { type: "hello", linkId, agentId: "agent-a", heartbeatMs: 20_000 } });
    links.assertReady("agent-a", binding);
    expect(links.online("agent-a")).toBe(true);
    expect(links.get("agent-a")).toMatchObject({ online: true, lastOnlineAt: expect.any(String) });
    // A binding belongs to its agent: another agent's id resolves nothing.
    expect(() => links.assertReady("agent-b", binding)).toThrow("host_link_not_found");
    expect(links.host("agent-b", binding).online!()).toBe(false);
    const http = links.http("agent-a", binding);
    expect(await http.request("/v1/health")).toMatchObject({ protocolVersion: 1 });
    await expect(http.request("/v1/native-sessions", { body: { action: "list" } })).rejects.toMatchObject({ status: 403, code: "link_route_not_allowed" });
    machine.ws.terminate(); await machine.closed;
    await until(() => events.at(-1)?.type, (type) => type === "offline");
    expect(links.online("agent-a")).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["enrolled", "online", "offline"]);
  });
  it("keeps one connection per link: a newer connection takes over without the link going offline", async () => {
    const { links, events, port } = await standalone();
    const { credential } = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device }, "c");
    const first = connect(port, credential); await first.ready;
    const second = connect(port, credential); await second.ready;
    expect(await first.closed).toBe(4001);
    expect(links.online("agent-a")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["enrolled", "online"]);
    expect(await links.http("agent-a", HostLinks.binding(links.get("agent-a")!.id)).request("/v1/health")).toMatchObject({ ok: true });
    expect(second.host.seen).toEqual(["GET /v1/health"]);
    expect(first.host.seen).toEqual([]);
  });
  it("revoking closes the connection and voids the credential; another owner cannot revoke", async () => {
    const { links, events, port } = await standalone();
    const { linkId, credential } = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device }, "c");
    const machine = connect(port, credential); await machine.ready;
    expect(() => links.revoke(bob, linkId)).toThrow(expect.objectContaining({ message: "host_link_not_found", status: 404 }));
    links.revoke(alice, linkId);
    expect(await machine.closed).toBe(4003);
    expect(links.list(alice)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["enrolled", "online", "revoked"]);
    expect((await connect(port, credential).ready).status).toBe(401);
    expect(() => links.assertReady("agent-a", HostLinks.binding(linkId))).toThrow("host_link_not_found");
  });
  it("drops a connection that stops answering heartbeats, and fails what it was waiting for", async () => {
    const { links, events, port } = await standalone({ heartbeatMs: 40, requestTimeoutMs: 60 });
    const { linkId, credential } = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device }, "c");
    const healthy = connect(port, credential); await healthy.ready;
    await new Promise((r) => setTimeout(r, 200));
    expect(links.online("agent-a")).toBe(true);
    // A request the machine never answers times out without closing the link.
    healthy.host.handle = () => undefined;
    await expect(links.http("agent-a", HostLinks.binding(linkId)).request("/v1/health")).rejects.toMatchObject({ status: 504, code: "host_link_timeout" });
    expect(links.online("agent-a")).toBe(true);
    const silent = connect(port, credential, new FakeHost(), { autoPong: false }); await silent.ready;
    silent.host.handle = () => undefined;
    const waiting = links.http("agent-a", HostLinks.binding(linkId)).request("/v1/health");
    await expect(waiting).rejects.toMatchObject({ status: expect.any(Number) });
    await silent.closed;
    await until(() => events.at(-1)?.type, (type) => type === "offline");
    expect(links.online("agent-a")).toBe(false);
  });
  it("sends a linked Host a message and nothing that defines the agent", async () => {
    const { links, port } = await standalone();
    const { linkId, credential } = links.enroll({ code: links.createCode(alice, "agent-a").code, ...device }, "c");
    const machine = connect(port, credential); await machine.ready;
    const host = links.host("agent-a", HostLinks.binding(linkId));
    expect(host).toMatchObject({ restricted: true, identity: `link:${linkId}` });
    for (const method of ["nativeSessions", "nativeRequest", "discoverRuntime", "readFile", "writeFile"]) expect((host as unknown as Record<string, unknown>)[method]).toBeUndefined();
    await host.connect();
    const base = { sessionId: "s", runtimeId: "local", instructions: "", input: "hello", requestKey: "k" };
    for (const extra of [{ instructions: "Obey." }, { tools: [{ name: "t", description: "", inputSchema: {}, timeoutMs: 1000 }] }, { toolOutput: { name: "t", output: "" } },
      { inputItems: [{ type: "skill" }] }, { attachments: [{ name: "a.txt", mediaType: "text/plain", data: "" }] as never }])
      await expect(host.start({ ...base, ...extra })).rejects.toMatchObject({ status: 422, code: "host_link_accepts_messages_only" });
    expect(machine.host.starts).toEqual([]);
    const run = await host.start({ ...base, context: { source: { kind: "channel", sender: "someone" } }, admission: { kind: "owner", owner: alice, agentId: "agent-a", reference: "r" } });
    expect(machine.host.starts).toEqual([{ sessionId: "s", runtimeId: "local", instructions: "", input: "hello", requestKey: "k", context: { source: { kind: "channel", sender: "someone" } } }]);
    expect(await host.findRun!("local", "k")).toEqual(run);
  });
});

/** A Router with its HTTP app, one agent of alice's and a helper that speaks as either owner. */
async function service() {
  const stateDir = mkdtempSync(join(tmpdir(), "router-host-links-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const router = createRouter({ serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1", stateDir },
    { dependencies: { authenticate: async (token) => { if (token === "alice") return alice; if (token === "bob") return bob; throw new Error("bad_credentials"); } } });
  const server = router.app.listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await router.close(); });
  const port = (server.address() as { port: number }).port;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${root}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  };
  const agent = await router.service.create(alice, "helper");
  return { router, port, api, agent };
}

describe("host link routes", () => {
  it("lets the owner create a code, list and revoke; enrollment takes the code alone and opens nothing else", async () => {
    const { api, agent, port, router } = await service();
    for (const [method, path] of [["GET", "/host-links"], ["POST", "/host-links/pairing-codes"], ["DELETE", "/host-links/hl_x"], ["GET", "/host-links/enroll"], ["POST", "/host-links/enroll/x"], ["GET", "/agents"]] as const)
      expect((await api(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(401);
    expect((await api("POST", "/host-links/pairing-codes", { agentId: agent.id }, "bob")).data).toEqual({ error: "agent_not_found" });
    const code = await api("POST", "/host-links/pairing-codes", { agentId: agent.id }, "alice");
    expect(code).toMatchObject({ status: 201, data: { agentId: agent.id, code: expect.stringMatching(/^.{4}-.{4}$/), expiresAt: expect.any(String) } });
    expect((await api("POST", "/host-links/enroll", { code: code.data.code, ...device, owner: alice })).data).toEqual({ error: "invalid_request" });
    expect((await api("POST", "/host-links/enroll", { code: "0000-0000", ...device })).data).toEqual({ error: "host_link_code_invalid" });
    // An owner token adds nothing to enrollment, and enrollment needs none.
    const enrolled = await api("POST", "/host-links/enroll", { code: code.data.code, ...device });
    expect(enrolled).toMatchObject({ status: 201, data: { agentId: agent.id, linkId: expect.any(String), credential: expect.stringMatching(/^ahl_/) } });
    // The device credential is not an owner credential.
    expect((await api("GET", "/host-links", undefined, enrolled.data.credential)).status).toBe(401);
    expect((await api("GET", "/agents", undefined, enrolled.data.credential)).status).toBe(401);
    expect((await api("GET", "/host-links", undefined, "bob")).data).toEqual({ data: [] });
    expect((await api("GET", "/host-links", undefined, "alice")).data.data).toEqual([expect.objectContaining({ id: enrolled.data.linkId, agentId: agent.id, ...device, online: false })]);
    const machine = connect(port, enrolled.data.credential);
    expect((await machine.ready).status).toBe(101);
    expect((await api("GET", "/host-links", undefined, "alice")).data.data[0].online).toBe(true);
    expect((await api("DELETE", `/host-links/${enrolled.data.linkId}`, undefined, "bob")).status).toBe(404);
    expect((await api("DELETE", `/host-links/${enrolled.data.linkId}`, undefined, "alice")).status).toBe(204);
    expect(await machine.closed).toBe(4003);
    expect(router.hostLinks.list(alice)).toEqual([]);
  });
  it("removes an agent's link and pending code when the agent is deleted", async () => {
    const { router, agent, port } = await service();
    const { credential } = router.hostLinks.enroll({ code: router.hostLinks.createCode(alice, agent.id).code, ...device }, "c");
    const pending = router.hostLinks.createCode(alice, agent.id);
    const machine = connect(port, credential); await machine.ready;
    await router.service.delete(alice, agent.id);
    expect(await machine.closed).toBe(4003);
    expect(router.hostLinks.list(alice)).toEqual([]);
    expect(() => router.hostLinks.enroll({ code: pending.code, ...device }, "c")).toThrow("host_link_code_invalid");
  });
});

describe("a Host that is not connected", () => {
  it("is not given work: nothing is claimed while it is away, and it is asked for its protocol again when it returns", async () => {
    const host = Object.assign(new WorkHost(), { present: false, connects: 0, online() { return this.present; }, async connect() { this.connects++; } });
    const h = await harness({ host }); cleanup.push(() => h.close());
    const submitted = await h.sessions.submit({ eventId: "queued", input: "Wait for me.", admission: admission("owner") });
    await h.round();
    expect(h.sessions.get("queued")).toMatchObject({ status: "submitted", outcomeUnknown: false });
    expect(h.worker.status()).toMatchObject({ error: HOST_OFFLINE, runs: [] });
    expect([host.starts.length, host.connects]).toEqual([0, 0]);
    host.present = true; await h.round();
    expect([host.starts.length, host.connects]).toEqual([1, 1]);
    host.present = false; await h.round(); host.present = true; await h.round();
    expect(host.connects).toBe(2);
    host.finish(1, "Here."); await h.round();
    expect(h.sessions.get("queued")).toMatchObject({ taskId: submitted.taskId, status: "completed", answer: "Here." });
  });
  it("returns a claim to the queue when the Host left before the submission was sent", async () => {
    const host = new WorkHost(); host.failStart = new ChannelHttpError(503, HOST_OFFLINE);
    const h = await harness({ host }); cleanup.push(() => h.close());
    await h.sessions.submit({ eventId: "raced", input: "Almost sent.", admission: admission("owner") });
    await h.worker.tick();
    // Neither failed nor unknown, and no record of a run: the turn was never handed over.
    expect(h.sessions.get("raced")).toMatchObject({ status: "submitted", outcomeUnknown: false });
    expect(h.worker.status().runs).toEqual([]);
    host.failStart = undefined; await h.round();
    host.finish(host.starts.length, "Sent now."); await h.round();
    expect(h.sessions.get("raced")).toMatchObject({ status: "completed", answer: "Sent now." });
    // Each attempt had its own claim, so its own request key.
    expect(new Set(host.starts.map((start) => start.requestKey)).size).toBe(host.starts.length);
  });
});

describe("work for a linked Host", () => {
  /** An agent whose Host is a link, configured the way a product does it when the link enrolls. */
  async function linked() {
    const context = await service(), { router, agent } = context;
    router.hostLinks.subscribe((event) => event.type === "enrolled"
      ? router.connections.edit(event.owner, event.link.agentId, (config) => { config.host = { binding: event.binding, runtimeId: event.link.runtime.id, instanceName: "channel-host", instructions: "You are configured in the cloud." }; })
      : undefined);
    const { credential } = router.hostLinks.enroll({ code: router.hostLinks.createCode(alice, agent.id).code, ...device }, "c");
    const extension = await until(async () => (await router.service.runtime(agent.id)).extension, (value) => Boolean(value?.sessions));
    const submit = (eventId: string, input: string, admission: "owner" | "delegation" = "owner") => extension!.sessions!.submit({ eventId, input,
      admission: { kind: admission, owner: alice, agentId: agent.id, reference: eventId, ...(admission === "owner" ? {} : { toolGrants: {} }) } });
    const phases = () => (extension!.status() as { host: { error: string | null; runs: Array<{ phase: string }> } }).host;
    return { ...context, credential, extension: extension!, submit, phases, get: (eventId: string) => extension!.sessions!.get(eventId) };
  }
  it("waits in the queue while the machine is offline and is delivered once it connects", async () => {
    const { port, credential, submit, get, phases } = await linked();
    await submit("first", "Hello from the cloud.");
    await new Promise((r) => setTimeout(r, 2_500));
    // Not claimed, not failed, not unknown: nothing was sent anywhere.
    expect(get("first")).toMatchObject({ status: "submitted", outcomeUnknown: false });
    expect(phases()).toMatchObject({ error: HOST_OFFLINE, runs: [] });
    const machine = connect(port, credential); await machine.ready;
    await until(() => machine.host.starts.length, (count) => count === 1);
    // A message and its source; none of the cloud's instructions or tools. A linked Host is told who is asking.
    expect(machine.host.starts[0]).toEqual({ sessionId: expect.any(String), runtimeId: "local", instructions: "", input: "Hello from the cloud.", requestKey: expect.any(String),
      context: { agentId: expect.any(String), conversationId: expect.any(String), source: { kind: "owner", reference: "first" } } });
    machine.host.finish(1, "Hello from the machine.");
    expect(await until(() => get("first"), (value) => value.status === "completed")).toMatchObject({ answer: "Hello from the machine." });
    expect(machine.host.starts).toHaveLength(1);
    expect(machine.host.seen.filter((path) => !/^(GET \/v1\/(health|runs\/[^/]+(\/(events|calls))?)|POST \/v1\/runs)$/.test(path))).toEqual([]);
  }, 30_000);
  it("delivers input that no person wrote as text, never as a native tool output", async () => {
    const { port, credential, submit } = await linked();
    const machine = connect(port, credential); await machine.ready;
    await submit("delegated", "Summarize the report.", "delegation");
    await until(() => machine.host.starts.length, (count) => count === 1);
    expect(machine.host.starts[0]).not.toHaveProperty("toolOutput");
    expect(machine.host.starts[0].input).toBe('{"from":"system","message":"Summarize the report."}');
    expect(machine.host.seen).not.toContain("POST /v1/runtimes/inspect");
  }, 30_000);
  it("finds a running turn again after the connection was lost, without running it twice", async () => {
    const { port, credential, submit, get, phases } = await linked();
    const machine = connect(port, credential); await machine.ready;
    await submit("long", "Take your time.");
    await until(() => phases().runs.map((run) => run.phase).join(), (value) => value === "running");
    machine.ws.terminate(); await machine.closed;
    await new Promise((r) => setTimeout(r, 2_200));
    expect(get("long")).toMatchObject({ status: "working", outcomeUnknown: false });
    expect(phases().runs.map((run) => run.phase)).toEqual(["running"]);
    // The same machine state behind a new connection: the run is still there.
    const again = connect(port, credential, machine.host); await again.ready;
    machine.host.finish(1, "Done after reconnecting.");
    expect(await until(() => get("long"), (value) => value.status === "completed")).toMatchObject({ answer: "Done after reconnecting." });
    expect(machine.host.starts).toHaveLength(1);
  }, 30_000);
  it("binds a submission whose answer was lost to the run it started, by its request key", async () => {
    const { port, credential, submit, get, phases } = await linked();
    const machine = connect(port, credential); await machine.ready;
    machine.host.dropNextStart = true;
    await submit("lost", "Did this arrive?");
    await machine.closed;
    await until(() => phases().runs.map((run) => run.phase).join(), (value) => value === "unknown");
    const again = connect(port, credential, machine.host); await again.ready;
    await until(() => phases().runs.map((run) => run.phase).join(), (value) => value === "running");
    machine.host.finish(1, "It arrived once.");
    expect(await until(() => get("lost"), (value) => value.status === "completed")).toMatchObject({ answer: "It arrived once." });
    expect(machine.host.starts).toHaveLength(1);
  }, 30_000);
  it("forwards an approval to the machine that asked", async () => {
    const { port, credential, submit, get, extension } = await linked();
    const machine = connect(port, credential); await machine.ready;
    await submit("approve", "Run the command.");
    await until(() => machine.host.starts.length, (count) => count === 1);
    machine.host.calls.set("run-1", [{ id: "call-1", runId: "run-1", kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "ls" },
      status: "pending", deadlineAt: new Date(Date.now() + 600_000).toISOString() }]);
    await until(() => (extension.status() as { host: { calls: unknown[] } }).host.calls.length, (count) => count === 1);
    await extension.resolve("call-1", { decision: "accept" });
    expect(machine.host.resolved).toEqual([{ callId: "call-1", result: { decision: "accept" } }]);
    machine.host.finish(1, "Command ran.");
    expect(await until(() => get("approve"), (value) => value.status === "completed")).toMatchObject({ answer: "Command ran." });
  }, 30_000);
});
