import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ServiceConfig } from "../src/service/managed.js";
import { loadServiceConfig } from "../src/service/config.js";

/** `GET /web/me` → `limits.features` lists every ADR 0005 feature; history and send come together, every other flag is independent and off by default. */
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test";
const base = { history: true, send: true, cards: false, attachments: false, reset: false, groups: false, identity: false };

async function features(flags: Partial<ServiceConfig>) {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-features-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const service = new ManagedService({ serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, ledgerRead: true, ledgerSend: true, ...flags }, {
    authenticate: async (token) => { if (token === "alice") return owner; throw new Error("bad_credentials"); } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/_agent-router/v1/web/me`, { headers: { Authorization: "Bearer alice" } });
  return ((await response.json()) as { limits: { features: Record<string, boolean> } }).limits.features;
}

describe("ledger feature flags", () => {
  it("lists every feature, all off but history and send by default", async () => {
    expect(await features({})).toEqual(base);
  });
  it("turns on exactly the flagged feature", async () => {
    expect(await features({ ledgerCards: true })).toEqual({ ...base, cards: true });
    expect(await features({ ledgerControl: true })).toEqual({ ...base, reset: true });
    expect(await features({ ledgerGroups: true })).toEqual({ ...base, groups: true });
    expect(await features({ ledgerAttachments: true })).toEqual({ ...base, attachments: true });
    expect(await features({ ledgerIdentity: true })).toEqual({ ...base, identity: true });
    expect(await features({ ledgerCards: true, ledgerControl: true, ledgerGroups: true, ledgerAttachments: true, ledgerIdentity: true }))
      .toEqual({ history: true, send: true, cards: true, attachments: true, reset: true, groups: true, identity: true });
  });
  it("refuses to serve history without send, whatever the other flags", async () => {
    await expect(features({ ledgerSend: false })).rejects.toThrow("ledger_read_requires_ledger_send");
    await expect(features({ ledgerSend: false, ledgerCards: true, ledgerControl: true, ledgerGroups: true, ledgerAttachments: true }))
      .rejects.toThrow("ledger_read_requires_ledger_send");
  });
  it("sets no ledger flag from an environment without them", () => {
    const env = { MATRIX_SERVER_NAME: "example.test", AGENT_SERVICE_URL: "https://example.test/x" };
    const config = loadServiceConfig(env);
    for (const flag of ["ledgerRead", "ledgerSend", "ledgerCards", "ledgerControl", "ledgerGroups", "ledgerAttachments", "ledgerIdentity"] as const)
      expect(config[flag], flag).toBeUndefined();
    const all = loadServiceConfig({ ...env, AGENT_LEDGER_READ: "1", AGENT_LEDGER_SEND: "1", AGENT_LEDGER_CARDS: "1", AGENT_LEDGER_CONTROL: "1",
      AGENT_LEDGER_GROUPS: "1", AGENT_LEDGER_ATTACHMENTS: "1", AGENT_LEDGER_IDENTITY: "1" });
    expect(all).toMatchObject({ ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true, ledgerGroups: true, ledgerAttachments: true, ledgerIdentity: true });
  });
});
