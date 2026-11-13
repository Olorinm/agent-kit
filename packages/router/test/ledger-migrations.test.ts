import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/communication/store.js";
import { AgentLedger } from "../src/ledger/ledger.js";
import { OwnerHubs, type HubDirectory } from "../src/ledger/hub.js";
import { Identities } from "../src/ledger/identity.js";
import { digest } from "../src/execution/protocol.js";
import { PersonRegistry } from "../src/ledger/registry.js";
import { ALPHA10_AGENT_LEDGER_V1, ALPHA10_AGENT_LEDGER_V2, ALPHA10_OWNER_HUB_V1, ALPHA10_REGISTRY_V1 } from "./fixtures/schema-0.7.0-alpha.10.js";

/**
 * Every ledger, hub and registry migration applies in order both on a fresh store and on a store created by the
 * released 0.7.0-alpha.10 schema, and both paths end in the same schema. Phase steps with their own version counter
 * (hub rooms, ...) are covered by opening the store the way the service does.
 */
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const dir = () => { const path = mkdtempSync(join(tmpdir(), "ledger-migrations-")); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path; };
const store = (path: string, identity = "@alice:example.test") => { const value = new DurableStore(path, identity); cleanup.push(() => { try { value.close(); } catch { /* closed */ } }); return value; };
const owner = "@alice:example.test", hubPath = (root: string) => join(root, "owners", `${digest(owner)}.sqlite`);
const directory: HubDirectory = { owns: () => true, agentName: (id) => id, ledger: () => undefined, personName: () => undefined };

/** Tables, indexes and their columns, without SQLite internals. */
function schema(db: DurableStore["db"]) {
  const objects = db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string; tbl_name: string }>;
  return objects.map((object) => ({ ...object, columns: object.type === "table"
    ? (db.prepare(`PRAGMA table_info("${object.name}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>)
      .map((column) => `${column.name} ${column.type}${column.notnull ? " NOT NULL" : ""}${column.dflt_value === null ? "" : ` DEFAULT ${String(column.dflt_value)}`}${column.pk ? ` PK${column.pk}` : ""}`)
    : (db.prepare(`PRAGMA index_info("${object.name}")`).all() as Array<{ name: string | null }>).map((column) => column.name ?? "<expr>") }));
}
const versions = (value: DurableStore) => Object.fromEntries((value.db.prepare("SELECT id,value FROM documents WHERE collection='meta' AND id LIKE '%schema_version' ORDER BY id").all() as Array<{ id: string; value: string }>)
  .map((row) => [row.id, JSON.parse(row.value)]));

/** Create the stores as 0.7.0-alpha.10 did, with one row each, and close them. */
function alpha10(root: string) {
  const agent = store(join(root, "agent.sqlite"), "agent-1");
  agent.migrate(1, ALPHA10_AGENT_LEDGER_V1); agent.migrate(2, ALPHA10_AGENT_LEDGER_V2);
  agent.set("meta", "probe", "agent");
  agent.close();
  const hub = store(hubPath(root));
  hub.migrate(1, ALPHA10_OWNER_HUB_V1); hub.set("meta", "probe", "hub"); hub.close();
  const registry = store(join(root, "registry.sqlite"), "service");
  registry.migrate(1, ALPHA10_REGISTRY_V1, "registry_schema_version"); registry.set("meta", "probe", "registry"); registry.close();
}
/** Open the stores the way the current service does (every migration it knows). */
function current(root: string) {
  const agent = store(join(root, "agent.sqlite"), "agent-1");
  AgentLedger.open(agent);
  const hubs = new OwnerHubs(root, directory), hub = hubs.hub(owner);
  cleanup.push(() => { try { hubs.close(); } catch { /* closed */ } });
  const registryStore = store(join(root, "registry.sqlite"), "service");
  // The identity step (phase 6) runs when the identity flag first touches the owner's hub.
  new Identities(new PersonRegistry(registryStore), hubs).pendingCodes(owner);
  return { agent, hub: hub.store, registry: registryStore };
}

describe("ledger migrations", () => {
  it("upgrade a 0.7.0-alpha.10 store to the same schema as a fresh store", () => {
    const upgraded = dir(), fresh = dir();
    alpha10(upgraded);
    const a = current(upgraded), b = current(fresh);
    for (const name of ["agent", "hub", "registry"] as const) {
      expect(schema(a[name].db), name).toEqual(schema(b[name].db));
      expect(versions(a[name]), name).toEqual(versions(b[name]));
      expect(a[name].get("meta", "probe"), name).toBe(name);
    }
    expect(versions(a.agent)).toEqual({ ledger_schema_version: 5 });
    expect(versions(a.hub)).toEqual({ ledger_schema_version: 2, hub_rooms_schema_version: 1, hub_identity_schema_version: 1 });
    expect(versions(a.registry)).toEqual({ registry_schema_version: 2 });
  });
  it("folds the inbox and outbox documents of earlier releases into the ledger and deletes them", async () => {
    const { AGENT_LEDGER_V1, AGENT_LEDGER_V2, AGENT_LEDGER_V3, AGENT_LEDGER_V4 } = await import("../src/ledger/schema.js");
    const agent = store(join(dir(), "agent.sqlite"), "agent-1");
    [AGENT_LEDGER_V1, AGENT_LEDGER_V2, AGENT_LEDGER_V3, AGENT_LEDGER_V4].forEach((sql, index) => agent.migrate(index + 1, sql));
    const route = { connectionId: "chat", target: "room", messageId: "m1", data: {} }, source = { externalId: "m1", sender: "owner", scope: "direct", threadId: "t", text: "你好", reply: { target: "room", messageId: "m1", data: {} } };
    agent.db.exec(`INSERT INTO ledger_ingress(connection_id,external_id,input_id,hash,state,received_at) VALUES('chat','m1','in-1','h1','accepted',1),('chat','m2','in-2','h2','tombstone',2);
      INSERT INTO ledger_deliveries(delivery_id,event_id,conversation_id,connection_id,route,purpose,status,created_at,updated_at)
        VALUES('out-final','ev_1','cv_1','chat','${JSON.stringify({ ...route, channel: "chat" })}','reply','queued',1,1)`);
    agent.set("communication_inbox", "in-1", { id: "in-1", connectionId: "chat", source, conversationId: "c-main", replyRoute: route, hash: "h1", state: "submitted", taskId: "turn-1", forkFromContextId: "c-parent" });
    agent.set("communication_inbox", "in-2", { id: "in-2", connectionId: "chat", source: { ...source, externalId: "m2", text: "" }, conversationId: "c-main", replyRoute: route, hash: "h2", state: "done" });
    agent.set("communication_inbox", "in-3", { id: "in-3", connectionId: "chat", source: { ...source, externalId: "m3" }, conversationId: "c-main", replyRoute: route, hash: "h3", state: "done" });
    agent.set("communication_outbox", "out-final", { id: "out-final", taskId: "turn-1", route, text: "回答", final: true, state: "queued", attempts: 2, nextAt: 9 });
    agent.set("communication_outbox", "out-push", { id: "out-push", taskId: null, route: { connectionId: "bark", target: "owner", messageId: "", data: {} }, text: "推送", state: "accepted", attempts: 1, nextAt: 0, externalId: "p1" });
    agent.set("communication_outbox", "out-web", { id: "out-web", taskId: "turn-1", route: { ...route, connectionId: "web" }, text: "网页", final: true, state: "accepted", attempts: 0, nextAt: 0, externalId: "ev_2" });
    agent.set("communication_outbox", "out-media", { id: "out-media", taskId: null, originTaskId: "turn-1", route, text: "图", content: { text: "图", html: "<b>图</b>" }, state: "uncertain", attempts: 1, nextAt: 0, error: "send_interrupted" });
    const ledger = AgentLedger.open(agent);
    // A claim takes its message, session and fork parent from its inbox record; a tombstone keeps no content.
    expect(ledger.claimByInput("in-1")).toMatchObject({ source, sessionKey: "c-main", forkFrom: "c-parent" });
    expect(ledger.claimByInput("in-2")).toMatchObject({ state: "tombstone", source: null, sessionKey: "c-main" });
    // An inbox record that never had a claim is not carried over.
    expect(ledger.claimByInput("in-3")).toBeUndefined();
    // A delivery takes its text and turn from its outbox record and stays queued; records without a delivery row become one.
    expect(ledger.delivery("out-final")).toMatchObject({ status: "queued", purpose: "reply", text: "回答", turnId: "turn-1", eventId: "ev_1", conversationId: "cv_1" });
    expect(ledger.delivery("out-push")).toMatchObject({ status: "sent", purpose: "notice", text: "推送", platformMessageId: "p1", eventId: null, route: { target: "owner" } });
    expect(ledger.delivery("out-media")).toMatchObject({ status: "unknown", purpose: "content", originTurnId: "turn-1", content: { html: "<b>图</b>" }, error: "send_interrupted" });
    // The web connection's event is its delivery.
    expect(ledger.delivery("out-web")).toBeUndefined();
    expect(agent.entries("communication_inbox")).toEqual([]); expect(agent.entries("communication_outbox")).toEqual([]);
  });
  it("is idempotent when the stores are opened again", () => {
    const root = dir();
    alpha10(root);
    const first = current(root), before = { agent: schema(first.agent.db), hub: schema(first.hub.db), registry: schema(first.registry.db) };
    for (const close of cleanup.splice(1).reverse()) close();
    const again = current(root);
    expect({ agent: schema(again.agent.db), hub: schema(again.hub.db), registry: schema(again.registry.db) }).toEqual(before);
  });
  it("keeps the shipped 0.7.0-alpha.10 steps unedited", async () => {
    const shipped = await import("../src/ledger/schema.js");
    expect(shipped.AGENT_LEDGER_V1).toBe(ALPHA10_AGENT_LEDGER_V1);
    expect(shipped.AGENT_LEDGER_V2).toBe(ALPHA10_AGENT_LEDGER_V2);
    expect(shipped.OWNER_HUB_V1).toBe(ALPHA10_OWNER_HUB_V1);
    expect(shipped.REGISTRY_V1).toBe(ALPHA10_REGISTRY_V1);
  });
});
