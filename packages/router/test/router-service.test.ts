import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createRouter, loadServiceConfig, type ServiceConfig } from "../src/server.js";
import { Host, until } from "./ledger-fixture.js";
import { restoreMatrixEraState } from "./fixtures/matrix-era-state.js";
import { DurableStore } from "../src/communication/store.js";
import { digest } from "../src/execution/protocol.js";

/**
 * The full service as a product embeds it (createRouter, loadServiceConfig): the edge identity is the only owner login
 * and every owner flow works through the ledger. The operator environment is the one a deployment already has, including
 * the variables of the removed Matrix switch, which are ignored.
 */
const team = "https://example-team.cloudflareaccess.com", aud = "c".repeat(64), root = "/_agent-router/v1", enc = encodeURIComponent;
const owner = "@owner:example.test", origin = "https://mau.example.test";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
let counter = 0;
const ik = () => `mo${String(++counter).padStart(6, "0")}${"0".repeat(16)}`;

async function edge() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "k1", alg: "RS256", use: "sig" };
  const server: Server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const certs = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/cdn-cgi/access/certs`);
  const token = await new SignJWT({ email: "owner@example.test", sub: "s-1", type: "app" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(team).setAudience(aud).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return { certs, token };
}
/** Records every outbound request made through `fetch`. */
function recordFetch() {
  const urls: string[] = [], original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return original(input, init);
  });
  return urls;
}

async function boot(stateDir: string, overrides: Partial<ServiceConfig> = {}) {
  const keys = await edge();
  const edgeFile = join(stateDir, "..", `edge-${counter++}.json`);
  writeFileSync(edgeFile, JSON.stringify({ edgeIdentity: { provider: "cloudflare-access", teamDomain: team, audiences: [aud], owners: { "owner@example.test": owner } } }));
  cleanup.push(() => rmSync(edgeFile, { force: true }));
  // The operator environment of an existing deployment. `MATRIX_SERVER_NAME` is the account namespace; `AGENT_MATRIX`
  // and the homeserver variables belonged to the removed Matrix switch and no longer mean anything.
  const env = { MATRIX_SERVER_NAME: "example.test", AGENT_SERVICE_URL: `${origin}/_agent-router/v1`, AGENT_SERVICE_STATE: stateDir, AGENT_MATRIX: "off",
    MATRIX_HOMESERVER_URL: "https://matrix.example.test", MATRIX_AS_TOKEN_FILE: join(stateDir, "missing-as-token"),
    AGENT_LEDGER_READ: "1", AGENT_LEDGER_SEND: "1", AGENT_LEDGER_CARDS: "1", AGENT_LEDGER_CONTROL: "1", AGENT_LEDGER_GROUPS: "1",
    AGENT_LEDGER_ATTACHMENTS: "1", AGENT_LEDGER_IDENTITY: "1", AGENT_EDGE_IDENTITY_FILE: edgeFile };
  const loaded = loadServiceConfig(env);
  expect(Object.keys(loaded).sort()).toEqual(["attachmentQuotaBytes", "blobStore", "edgeIdentity", "ledgerAttachments", "ledgerCards", "ledgerControl", "ledgerGroups",
    "ledgerIdentity", "ledgerRead", "ledgerSend", "publicUrl", "serverName", "stateDir"].filter((key) => key in loaded));
  expect(loaded).toMatchObject({ serverName: "example.test", ledgerRead: true, ledgerSend: true });
  // A product built against the previous release still passes the Matrix switch; it is an unknown key and has no effect.
  const config = { ...loaded, matrix: { enabled: false }, ...overrides } as ServiceConfig;
  const host = new Host();
  const router = createRouter(config, { hosts: { assertReady: () => {}, host: () => host, http: () => ({ request: async () => { throw new Error("unused"); } }) as never },
    dependencies: { edgeIdentityCerts: keys.certs } });
  const server = router.app.listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const stop = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await router.close(); };
  cleanup.push(stop);
  await router.start();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = (extra: Record<string, string> = {}) => ({ "cf-access-jwt-assertion": keys.token, Origin: origin, "Content-Type": "application/json", ...extra });
  async function api(path: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, { method, headers: headers(extraHeaders), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) as any : null };
  }
  async function upload(bytes: Buffer, type: string, name: string) {
    const response = await fetch(`${base}${root}/web/attachments`, { method: "POST", body: new Blob([new Uint8Array(bytes)]),
      headers: { ...headers({ "Content-Type": type }), "X-File-Name": `UTF-8''${enc(name)}` } });
    return { status: response.status, data: await response.json() as any };
  }
  async function download(url: string) {
    const response = await fetch(base + url, { headers: { "cf-access-jwt-assertion": keys.token } });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  }
  const events = async (chatId: string) => (await api(`${root}/web/chats/${enc(chatId)}/events?limit=200`)).data.events as any[];
  return { router, host, api, upload, download, events, base, certs: keys.certs.origin, stop };
}
async function withHost(t: Awaited<ReturnType<typeof boot>>, agent: { id: string }) {
  await t.router.connections.replaceHost(owner, agent.id, { binding: "fixture", runtimeId: "fixture", instanceName: "channel-host", instructions: "" });
}

describe("the Router service", () => {
  it("boots from the operator environment and serves DMs, cards, attachments and groups through the ledger", async () => {
    const urls = recordFetch();
    const stateDir = mkdtempSync(join(tmpdir(), "router-service-"));
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const t = await boot(stateDir);
    expect((await fetch(`${t.base}/health/live`).then((r) => r.json()))).toEqual({ status: "ok", component: "agent-service" });
    const me = (await t.api(`${root}/web/me`)).data;
    expect(me).toMatchObject({ ownerId: owner, auth: { via: "edge", email: "owner@example.test" } });
    expect(me.limits.features).toEqual({ history: true, send: true, cards: true, attachments: true, reset: true, groups: true, identity: true });
    expect((await t.api(`${root}/account`)).data).toEqual({ owner, personId: expect.stringMatching(/^prs_/), via: "edge", email: "owner@example.test" });

    const created = await t.api(`${root}/agents`, "POST", { name: "helper" });
    expect(created).toMatchObject({ status: 201, data: { name: "helper", status: "active", matrixId: expect.stringMatching(/^@_ar_[0-9a-f]{32}:example\.test$/) } });
    expect(created.data).not.toHaveProperty("matrix");
    const helper = created.data, writer = (await t.api(`${root}/agents`, "POST", { name: "writer" })).data;
    await withHost(t, helper); await withHost(t, writer);

    // DM send and reply.
    const chatId = `dm:${helper.id}`;
    expect((await t.api(`${root}/web/chats/dm`, "POST", { agentId: helper.id })).data).toMatchObject({ chatId, readOnly: false });
    const sent = await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "你好" });
    expect(sent).toMatchObject({ status: 200, data: { status: "accepted", event: { kind: "message", text: "你好", channel: { kind: "web" } } } });
    const reply = (await until(() => t.events(chatId), (items) => items.some((event) => event.kind === "message" && event.role === "assistant")))
      .find((event) => event.role === "assistant");
    expect(reply).toMatchObject({ text: "回答-1", final: true, sender: { type: "agent", id: helper.id } });

    // A card answered through the web.
    t.host.plan = (_n, input) => input.input.includes("需要批准") ? [{ id: "a1", kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "make" } }] : [];
    await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "需要批准" });
    const card = (await until(() => t.events(chatId), (items) => items.some((event) => event.kind === "card"))).find((event) => event.kind === "card").card;
    expect(card).toMatchObject({ kind: "approval", status: "pending" });
    const answered = await t.api(`${root}/web/chats/${enc(chatId)}/cards/${enc(card.cardId)}/answer`, "POST", { idempotencyKey: ik(), choiceId: "0" });
    expect(answered).toMatchObject({ status: 200, data: { status: "accepted", card: { status: "approved" } } });
    expect(t.host.resolved).toEqual([expect.objectContaining({ callId: "a1", result: { decision: "accept" } })]);

    // An attachment: upload, send, the Host reads the bytes, the console downloads it.
    const uploaded = await t.upload(png, "image/png", "截图.png");
    expect(uploaded).toMatchObject({ status: 201, data: { attachmentId: expect.stringMatching(/^at_/) } });
    const withImage = await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "看图", attachments: [uploaded.data.attachmentId] });
    expect(withImage.data.event.attachments).toMatchObject([{ name: "截图.png", contentType: "image/png", size: png.length }]);
    const start = await until(() => t.host.starts.find((item) => item.input.includes("看图")), Boolean);
    expect(start.attachments?.map((item) => Buffer.from(item.data, "base64").equals(png))).toEqual([true]);
    expect(await t.download(withImage.data.event.attachments[0].url)).toMatchObject({ status: 200, body: png });

    // A native group: @all fans out to both agents, both reply in the room.
    const group = await t.api(`${root}/web/groups`, "POST", { idempotencyKey: ik(), title: "周报小组", agentIds: [helper.id, writer.id] });
    expect(group.status).toBe(201);
    const roomChat = group.data.chatId as string;
    const posted = await t.api(`${root}/web/chats/${enc(roomChat)}/messages`, "POST", { idempotencyKey: ik(), text: "@all 周报", mentions: { agentIds: [], all: true } });
    expect(posted.data.addressed.map((item: any) => item.state).sort()).toEqual(["queued", "queued"]);
    const room = await until(() => t.events(roomChat), (items) => items.filter((event) => event.kind === "message" && event.role === "assistant").length === 2);
    expect(new Set(room.filter((event) => event.role === "assistant").map((event) => event.agentId))).toEqual(new Set([helper.id, writer.id]));

    // Owners sign in through the edge identity only: a bearer token is not an account here.
    const bearer = await fetch(`${t.base}${root}/agents`, { headers: { Authorization: "Bearer some-token" } });
    expect({ status: bearer.status, body: await bearer.json() }).toEqual({ status: 401, body: { error: "account_login_required" } });
    // Matrix is not a connection kind, and its routes do not exist.
    expect(await t.api(`${root}/agents/${helper.id}/connections`, "POST", { kind: "matrix" })).toEqual({ status: 400, data: { error: "invalid_request" } });
    for (const [path, method] of [["/_matrix/app/v1/ping", "POST"], [`${root}/agents/${helper.id}/matrix`, "PUT"], [`${root}/agents/${helper.id}/gateway/health/ready`, "GET"],
      [`${root}/directory?address=${enc(helper.address)}`, "GET"]] as const)
      expect(await t.api(path, method, method === "GET" ? undefined : {}), path).toEqual({ status: 404, data: { error: "not_found" } });

    expect((await t.api(`${root}/agents/${writer.id}`, "DELETE")).status).toBe(204);

    // The service called nothing but the edge identity's key set.
    expect(urls.filter((url) => !url.startsWith(t.base) && !url.startsWith(t.certs))).toEqual([]);
  }, 60_000);
});

/**
 * A store written while Router still had Matrix (`fixtures/matrix-era-state.ts`): the agent's owner-main session ends with
 * Matrix turns, its configuration lists a Matrix connection and its Host scope was written by that release.
 */
describe("a store written by a release with Matrix", () => {
  const state = () => { const dir = mkdtempSync(join(tmpdir(), "matrix-era-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
  const agentStore = (stateDir: string, prior: { agent: { id: string; matrixId: string } }) => new DurableStore(join(stateDir, "agents", `${prior.agent.id}.sqlite`), prior.agent.matrixId);

  it("ignores the leftover Matrix connection: it is not started, listed or checked, and the agent keeps working and can be deleted", async () => {
    const stateDir = state(), prior = restoreMatrixEraState(stateDir);
    const channels = join(stateDir, "connections", "agents", prior.agent.id, "channels.json");
    expect(JSON.parse(readFileSync(channels, "utf8")).agents[0].connections).toEqual([expect.objectContaining({ id: "matrix", kind: "matrix" })]);
    const urls = recordFetch();
    const t = await boot(stateDir);
    const agent = (await t.api(`${root}/agents/${prior.agent.id}`)).data;
    expect(agent).toEqual({ ...prior.agent, status: "active" });
    const status = (await t.api(`${root}/agents/${prior.agent.id}/communication`)).data;
    expect(status.error ?? null).toBeNull();
    expect(status.connections.map((item: any) => item.id).sort()).toEqual(["room", "web"]);
    expect(t.router.connections.summary(t.router.service.agent(prior.agent.id))).toMatchObject({ host: { runtimeId: "fixture" }, connections: [] });
    const checked = await t.api(`${root}/agents/${prior.agent.id}/check`, "POST", {});
    expect(checked.status, JSON.stringify(checked.data)).toBe(200);
    expect(checked.data.checks.filter((check: any) => check.connectionId === "matrix" || check.kind === "matrix")).toEqual([]);
    // Its stored record stays: the connection id still belongs to the removed kind.
    const runtime = await t.router.service.runtime(prior.agent.id);
    expect(runtime.store.get("communication_connections", "matrix")).toMatchObject({ kind: "matrix", agentId: prior.agent.id });
    // The file is untouched until the configuration is saved again, which writes it without the connection.
    expect(JSON.parse(readFileSync(channels, "utf8")).agents[0].connections).toHaveLength(1);
    const chatId = `dm:${prior.agent.id}`;
    await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "还在吗" });
    await until(() => t.events(chatId), (items) => items.filter((event) => event.role === "assistant" && event.final).length === 2);
    // The Matrix turn is still in the transcript.
    expect((await t.events(chatId)).filter((event) => event.kind === "message").map((event) => [event.role, event.text, event.channel?.kind]))
      .toEqual([["user", "Matrix 上的消息", "matrix"], ["assistant", "回答-1", "matrix"], ["user", "还在吗", "web"], ["assistant", "回答-1", "web"]]);
    await t.router.connections.edit(owner, prior.agent.id, () => {});
    expect(JSON.parse(readFileSync(channels, "utf8")).agents[0]).toMatchObject({ connections: [], host: { binding: "fixture", instructions: "prior instructions" } });
    expect(runtime.store.get("communication_host", "scope")).toBe(prior.scope);
    expect((await t.api(`${root}/agents/${prior.agent.id}`, "DELETE")).status).toBe(204);
    expect(existsSync(join(stateDir, "agents", `${prior.agent.id}.sqlite`))).toBe(false);
    expect(urls.filter((url) => !url.startsWith(t.base) && !url.startsWith(t.certs))).toEqual([]);
  }, 60_000);

  it("keeps the Host scope and the owner-main session, and a web DM after Matrix turns reaches the same Host session", async () => {
    const stateDir = state(), prior = restoreMatrixEraState(stateDir);
    const t = await boot(stateDir);
    const runtime = await t.router.service.runtime(prior.agent.id);
    // The 2026-11-05 outage: a different scope fails the start with host_binding_configuration_changed.
    expect(runtime.store.get("communication_host", "scope")).toBe(prior.scope);
    expect(runtime.store.get("execution_sessions", prior.session)).toEqual(prior.binding);
    const chatId = `dm:${prior.agent.id}`;
    await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "网页上的消息" });
    await until(() => t.host.starts.map((item) => item.input), (inputs) => inputs.some((input) => input.includes("网页上的消息")));
    await until(() => t.events(chatId), (items) => items.filter((event) => event.role === "assistant" && event.final).length === 2);
    expect(t.host.starts.at(-1)!.sessionId).toBe(prior.binding.sessionId);
    // Mau reads the session and validates schedule targets through the same owner lookup.
    expect(runtime.extension!.sessions!.getSession(prior.session).ownerConversation).toBe(true);
  }, 60_000);

  it("pins the Host scope of the current channel tool and instructions", () => {
    const prior = restoreMatrixEraState(state());
    // `communication_host.scope` is checked at every start and is not migrated. The fixture is the current definition.
    const current = JSON.parse(readFileSync(new URL("./fixtures/host-scope.json", import.meta.url), "utf8")) as { tools: unknown[]; toolInstructions: string };
    expect(prior.scope).toBe(digest({ agentId: prior.agent.id, instanceId: prior.instanceId, runtimeId: "fixture", instructions: "prior instructions", host: "fixture-host",
      tools: current.tools, toolInstructions: current.toolInstructions }));
  });

  it("refuses a store with the 0.7.0-alpha.11 Host scope until the operator clears it, then keeps the native session", async () => {
    const stateDir = state(), prior = restoreMatrixEraState(stateDir);
    // Up to 0.7.0-alpha.11 the tool instructions also described the removed Feishu personal tool.
    const released = JSON.parse(readFileSync(new URL("./fixtures/host-scope-0.7.0-alpha.10.json", import.meta.url), "utf8")) as { tools: unknown[]; toolInstructions: string };
    const legacy = digest({ agentId: prior.agent.id, instanceId: prior.instanceId, runtimeId: "fixture", instructions: "prior instructions", host: "fixture-host",
      tools: released.tools, toolInstructions: released.toolInstructions });
    expect(legacy).not.toBe(prior.scope);
    const file = join(stateDir, "agents", `${prior.agent.id}.sqlite`);
    const write = (sql: string, ...values: string[]) => { const db = new DatabaseSync(file); try { db.prepare(sql).run(...values); } finally { db.close(); } };
    write("UPDATE documents SET value=? WHERE collection='communication_host' AND id='scope'", JSON.stringify(legacy));
    // Router itself does not start: every agent's runtime is opened at start.
    await expect(boot(stateDir)).rejects.toThrow("host_binding_configuration_changed");
    // The operator step, with Router stopped and no running or unknown run: delete the stored scope.
    write("DELETE FROM documents WHERE collection='communication_host' AND id='scope'");
    const restarted = await boot(stateDir);
    const runtime = await restarted.router.service.runtime(prior.agent.id);
    expect(runtime.store.get("communication_host", "scope")).toBe(prior.scope);
    expect(runtime.store.get("execution_sessions", prior.session)).toEqual(prior.binding);
  }, 60_000);

  it("does not let records of the removed Matrix connection stall dispatch, results or schedule notices", async () => {
    const stateDir = state(), prior = restoreMatrixEraState(stateDir);
    // A Matrix message that was never dispatched and a Matrix task's result that was never published.
    const seed = agentStore(stateDir, prior);
    const [{ value: done }] = seed.entries<Record<string, any>>("communication_inbox") as [{ value: Record<string, any> }];
    seed.set("communication_inbox", "late", { ...done, id: "late", state: "received", taskId: undefined, source: { ...done.source, externalId: "$late", text: "切换瞬间的消息" } });
    seed.set("cli_work_events", "unpublished", seed.get<{ task: unknown }>("cli_work", String(done.taskId))!.task);
    // Records only the Matrix adapter read: a queued event and a request waiting for approval. Nothing reads them now.
    seed.set("outbox", "matrix-envelope", { room: "!dm:example.test", type: "m.room.message", content: { body: "never sent" }, status: "queued", attempts: 0, nextAt: 0 });
    seed.set("incoming", "matrix-request", { id: "matrix-request", room: "!dm:example.test", sender: "@peer:example.test", eventId: "$r", status: "pending",
      request: { version: 1, requestId: "r1", recipient: prior.agent.matrixId, taskId: "t1", contextId: "c1", operation: "send", body: {} } });
    seed.close();
    const t = await boot(stateDir);
    const runtime = await t.router.service.runtime(prior.agent.id);
    const records = () => runtime.store.entries<{ state: string; reason?: string }>("communication_inbox");
    await until(records, (items) => items.find(({ id }) => id === "late")?.value.state === "ignored");
    expect(records().find(({ id }) => id === "late")!.value.reason).toBe("connection_removed");
    await until(() => runtime.store.entries("cli_work_events").filter(({ id }) => id === "unpublished").length, (n) => n === 0);
    expect(t.host.starts).toEqual([]);
    expect(runtime.store.get("outbox", "matrix-envelope")).toMatchObject({ status: "queued" });
    expect(runtime.store.get("incoming", "matrix-request")).toMatchObject({ status: "pending" });

    // A schedule notice for a session that only has Matrix turns: the transcript is its delivery.
    const sessions = runtime.extension!.sessions!, chatId = `dm:${prior.agent.id}`;
    expect(sessions.deliver({ eventId: "rule-1", targetSessionId: prior.session, text: "定时通知" })).toMatchObject({ state: "accepted" });
    await until(() => t.events(chatId), (items) => items.some((event) => event.kind === "notice" && event.text === "定时通知"));
    // Once the owner uses the web, the notice goes through the newest route that exists.
    await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "网页上的消息" });
    await until(() => t.events(chatId), (items) => items.filter((event) => event.role === "assistant" && event.final).length === 2);
    expect(sessions.deliver({ eventId: "rule-2", targetSessionId: prior.session, text: "第二条通知" })).toMatchObject({ state: "accepted" });
    const delivered = runtime.store.entries<{ route: { connectionId: string }; text: string }>("communication_outbox").find(({ value }) => value.text === "第二条通知")!;
    expect(delivered.value.route.connectionId).toBe("web");
  }, 60_000);
});
