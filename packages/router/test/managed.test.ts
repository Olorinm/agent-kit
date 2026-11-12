import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_CHANNEL_COLLECTIONS, ManagedService, createManagedApp, type ServiceConfig } from "../src/service/managed.js";
import { DurableStore } from "../src/communication/store.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test";
function config() {
  const stateDir = mkdtempSync(join(tmpdir(), "managed-router-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  return { serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1", stateDir };
}
async function setup(overrides: Partial<ServiceConfig> = {}) {
  const cfg = { ...config(), ...overrides };
  const service = new ManagedService(cfg, { authenticate: async (token) => {
    if (token === "alice") return owner;
    if (token === "bob") return other;
    throw new Error("bad_credentials");
  } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path: string, token = "alice", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() as any };
  }
  return { service, api, cfg, base };
}
const root = "/_agent-router/v1";
describe("owner accounts, Agents and worker instances", () => {
  it("drops the removed visitor channel ledger once and no longer serves its routes", async () => {
    const cfg = config();
    const seed = new DurableStore(join(cfg.stateDir, "registry.sqlite"), cfg.serverName);
    for (const collection of LEGACY_CHANNEL_COLLECTIONS) seed.set(collection, "legacy", { agentId: "x" });
    seed.set("agents_unrelated", "kept", true); seed.close();
    const { service, api } = await setup(cfg);
    for (const collection of LEGACY_CHANNEL_COLLECTIONS) expect(service.store.entries(collection)).toEqual([]);
    expect(service.store.get("agents_unrelated", "kept")).toBe(true);
    expect(service.store.get("meta", "legacy_channels_removed")).toBe(1);
    const agent = await service.create(owner, "helper");
    expect((await api(`${root}/agents/${agent.id}/channels`)).status).toBe(404);
    expect((await api(`${root}/agents/${agent.id}/channels/email/events`)).status).toBe(404);
  });
  it("limits requests before auth and ignores untrusted forwarded IPs", async () => {
    const { service, api, base } = await setup();
    const agent = await service.create(owner, "coder");
    for (let i = 0; i < 1200; i++) expect((await api(`${root}/agents`)).status).toBe(200);
    expect((await api(`${root}/agents/${agent.id}`, "invalid")).status).toBe(429);
    const forged = await fetch(`${base}${root}/agents`, { headers: { Authorization: "Bearer bob", "X-Forwarded-For": "198.51.100.2" } });
    expect(forged.status).toBe(429);
    expect((await api("/health/live")).status).toBe(200);
  });
  it("uses separate client buckets only behind an explicitly trusted proxy", async () => {
    const { base } = await setup({ trustedProxies: ["loopback"] });
    const list = (ip: string) => fetch(`${base}${root}/agents`, { headers: { Authorization: "Bearer alice", "X-Forwarded-For": ip } });
    for (let i = 0; i < 1200; i++) expect((await list("198.51.100.1")).status).toBe(200);
    const blocked = await list("198.51.100.1");
    expect(blocked.status).toBe(429);
    expect((await blocked.json() as { error: string }).error).toBe("rate_limit_exceeded");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await list("198.51.100.2")).status).toBe(200);
  });
  it("creates two Agent identities under one owner and enforces account boundaries", async () => {
    const { service, api } = await setup();
    const a = await api(`${root}/agents`, "alice", "POST", { name: "coder" });
    const b = await api(`${root}/agents`, "alice", "POST", { name: "researcher" });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(a.data.owner).toBe(owner); expect(a.data.matrixId).not.toBe(b.data.matrixId);
    expect(a.data.matrixId).toBe(`@_ar_${a.data.id.replaceAll("-", "")}:example.test`);
    expect(a.data.address).toBe("alice/coder@example.test");
    expect(a.data).not.toHaveProperty("matrix");
    expect((await api(`${root}/agents`, "alice", "POST", { name: "coder" })).data.id).toBe(a.data.id);
    expect((await api(`${root}/agents`, "bob")).data.data).toHaveLength(0);
    expect((await api(`${root}/agents/${a.data.id}`, "bob")).status).toBe(404);
    expect((await api(`${root}/agents/${a.data.id}`, "bob", "DELETE")).status).toBe(404);
    expect((await api(`${root}/account`)).data).toEqual({ owner, personId: expect.stringMatching(/^prs_/), via: "bearer" });
    expect(service.agents()).toHaveLength(2);
  });
  it("gives a worker instance a stable id per name, replaces its token on reissue and never accepts it as an owner credential", async () => {
    const { service, api } = await setup();
    const a = await service.create(owner, "coder"), b = await service.create(owner, "researcher");
    const issued = service.issue(a.id, "laptop");
    expect(issued.token).toMatch(/^ari_/);
    expect(JSON.stringify(issued.instance)).not.toContain("tokenHash");
    expect(service.instance(issued.token, a.id).id).toBe(issued.instance.id);
    expect(() => service.instance(issued.token, b.id)).toThrow("instance_unauthorized");
    expect(() => service.instance("alice", a.id)).toThrow("instance_token_required");
    expect((await api(`${root}/agents`, issued.token)).status).toBe(401);
    expect((await api(`${root}/agents/${a.id}`, issued.token)).status).toBe(401);
    // The id feeds the Host scope and Host session ids, so it must survive a reissue.
    const reissued = service.issue(a.id, "laptop");
    expect(reissued.instance.id).toBe(issued.instance.id);
    expect(() => service.instance(issued.token, a.id)).toThrow("instance_unauthorized");
    expect(service.instance(reissued.token, a.id).id).toBe(issued.instance.id);
    expect(service.issue(a.id, "desktop").instance.id).not.toBe(issued.instance.id);
  });
  it("answers a bearer token only through the embedding product's authenticator", async () => {
    const cfg = config();
    const service = new ManagedService(cfg); cleanup.push(() => service.close());
    await expect(service.authenticate("alice")).rejects.toMatchObject({ message: "account_login_required", status: 401 });
    const { service: embedded } = await setup();
    expect(await embedded.authenticate("alice")).toBe(owner);
    await expect(embedded.authenticate("ari_instance")).rejects.toMatchObject({ message: "account_login_required", status: 401 });
  });
  it("no longer serves the Matrix, gateway, instance and credential exchange routes", async () => {
    const { service, api } = await setup();
    const agent = await service.create(owner, "coder");
    for (const [path, method, body] of [["/_matrix/app/v1/ping", "POST", {}], [`${root}/agents/${agent.id}/gateway/api/status`, "GET", undefined],
      [`${root}/agents/${agent.id}/instances`, "GET", undefined], [`${root}/agents/${agent.id}/matrix`, "PUT", { enabled: true }],
      [`${root}/directory?address=${encodeURIComponent(agent.address)}`, "GET", undefined]] as const)
      expect((await api(path, "alice", method, body)).status, path).toBe(404);
    // Unauthenticated routes that are gone now end at the owner check.
    expect((await api(`${root}/auth/exchange`, "", "POST", { provider: "x", accessToken: "y" })).status).toBe(401);
  });
});

it("protects run observation and interaction routes with Agent ownership before accessing Host state", async () => {
  const { service, api } = await setup(); const agent = await service.create(owner, "observed");
  const instance = service.issue(agent.id, "worker");
  const root = `/_agent-router/v1/agents/${agent.id}/communication`;
  for (const [path, method, body] of [["/tasks", "GET", undefined], ["/runs/claim", "GET", undefined],
    ["/runs/claim/events?after=0", "GET", undefined], ["/runs/claim/calls/call/result", "POST", { result: {} }],
    ["/tasks/task/cancel", "POST", {}]] as const) {
    expect((await api(root + path, "bob", method, body)).status).toBe(404);
    expect((await api(root + path, instance.token, method, body)).status).toBe(401);
  }
  expect((await api(root + "/runs/claim/events?after=-1")).status).toBe(400);
  expect((await api(root + "/tasks?limit=100000")).status).toBe(400);
});
