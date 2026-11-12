import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ServiceConfig } from "../src/service/managed.js";
import { channelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import { loadServiceConfig } from "../src/service/config.js";
import { personId } from "../src/ledger/registry.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
const owner = "@alice:example.test", root = "/_agent-router/v1/web";
const mail = "https://mail.example.test", inbox = "agent@example.test";
async function setup(overrides: Partial<ServiceConfig> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "identity-web-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  // The mail service of the agent's connection: the inbox exists and has no events.
  writeFileSync(join(stateDir, "mail-key"), "fixture-mail-key");
  const actualFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== mail) return actualFetch(input, init);
    return Response.json(url.pathname.endsWith("/events/lifecycle") ? { events: [], next_cursor: Number(url.searchParams.get("after")) } : { inbox_id: inbox });
  });
  const service: ManagedService = new ManagedService({ serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, ledgerRead: true, ledgerSend: true, ledgerIdentity: true, ...overrides }, {
    authenticate: async (token) => { if (token === "alice") return owner; throw new Error("bad_credentials"); },
    configure: async (agent, runtime) => {
      const config = channelConfigSchema.parse({ agents: [{ agentId: agent.id, connections: [{ id: "mail", kind: "grove-mail", url: mail, inboxId: inbox,
        apiKeyFile: "mail-key", ownerAddresses: ["alice@example.test"] }] }] }).agents[0]!;
      return createChannelRuntime(agent, runtime, config, stateDir, (name) => {
        const issued = service.issue(agent.id, name);
        return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
      }, undefined, { persons: service.persons, identity: service.identity });
    } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + root + path, { method, headers: { Authorization: "Bearer alice", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  }
  const agent = await service.create(owner, "helper");
  await service.runtime(agent.id);
  return { service, api, agent };
}

describe("identity web API (features.identity)", () => {
  it("reads the flag from AGENT_LEDGER_IDENTITY", () => {
    const env = { MATRIX_SERVER_NAME: "example.test", AGENT_SERVICE_URL: "https://example.test" };
    expect(loadServiceConfig({ ...env, AGENT_LEDGER_IDENTITY: "1" }).ledgerIdentity).toBe(true);
    expect(loadServiceConfig(env).ledgerIdentity).toBeUndefined();
  });
  it("lists config-seeded identities as fixed, issues, lists and cancels pairing codes, and enforces the pending limit", async () => {
    const t = await setup();
    const me = await t.api("/me");
    expect(me.data.limits.features).toMatchObject({ history: true, identity: true });
    const listed = await t.api("/identities");
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((item: any) => [item.provider, item.namespace, item.subject, item.verifiedBy, item.removable])).toEqual([
      ["matrix", "example.test", owner, "config", false], ["grove-mail", "", "alice@example.test", "config", false]]);
    expect(listed.data.data[0]).toMatchObject({ personId: personId(owner), fixed: "identity_from_config", lastSeenAt: null, createdAt: expect.any(String) });
    expect(await t.api(`/identities/${listed.data.data[0].identityId}`, "DELETE")).toEqual({ status: 409, data: { error: "identity_from_config" } });
    expect(await t.api("/identities/idn_missing", "DELETE")).toEqual({ status: 404, data: { error: "identity_not_found" } });

    const created = await t.api("/identities/pairing-codes", "POST", {});
    expect(created).toMatchObject({ status: 201, data: { id: expect.stringMatching(/^pc_/), code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/), expiresAt: expect.any(String) } });
    expect(created.data.instructions).toBe(`在要关联的渠道里私聊你的任一 Agent，发送：/link ${created.data.code}`);
    await t.api("/identities/pairing-codes", "POST", {}); await t.api("/identities/pairing-codes", "POST", {});
    expect(await t.api("/identities/pairing-codes", "POST", {})).toEqual({ status: 429, data: { error: "pairing_codes_pending_limit" } });
    const pending = await t.api("/identities/pairing-codes");
    expect(pending.data.data).toHaveLength(3);
    expect(JSON.stringify(pending.data)).not.toContain(created.data.code);
    expect(await t.api(`/identities/pairing-codes/${created.data.id}`, "DELETE")).toEqual({ status: 204, data: null });
    expect(await t.api(`/identities/pairing-codes/${created.data.id}`, "DELETE")).toEqual({ status: 404, data: { error: "pairing_code_not_found" } });
    expect((await t.api("/identities/pairing-codes")).data.data).toHaveLength(2);
    expect((await t.api("/identities/pairing-codes", "POST", { extra: true })).status).toBe(400);
  });
  it("without the flag the routes are absent and the feature is off", async () => {
    const t = await setup({ ledgerIdentity: false });
    expect((await t.api("/me")).data.limits.features.identity).toBe(false);
    expect((await t.api("/identities")).status).toBe(404);
    expect(t.service.identity).toBeUndefined();
  });
});
