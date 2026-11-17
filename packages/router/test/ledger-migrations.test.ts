import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
    expect(versions(a.agent)).toEqual({ ledger_schema_version: 6 });
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
        VALUES('out-final','ev_1','cv_1','chat','${JSON.stringify({ ...route, channel: "chat" })}','reply','queued',1,1),
          ('out-stray','ev_9','cv_1','chat','${JSON.stringify({ ...route, channel: "chat" })}','notice','queued',1,1)`);
    agent.set("communication_inbox", "in-1", { id: "in-1", connectionId: "chat", source, conversationId: "c-main", replyRoute: route, hash: "h1", state: "submitted", taskId: "turn-1", forkFromContextId: "c-parent" });
    agent.set("communication_inbox", "in-2", { id: "in-2", connectionId: "chat", source: { ...source, externalId: "m2", text: "" }, conversationId: "c-main", replyRoute: route, hash: "h2", state: "done" });
    agent.set("communication_inbox", "in-3", { id: "in-3", connectionId: "chat", source: { ...source, externalId: "m3" }, conversationId: "c-main", replyRoute: route, hash: "h3", state: "done" });
    agent.set("communication_outbox", "out-final", { id: "out-final", taskId: "turn-1", route, text: "回答", final: true, state: "queued", attempts: 2, nextAt: 9 });
    agent.set("communication_outbox", "out-push", { id: "out-push", taskId: null, route: { connectionId: "bark", target: "owner", messageId: "", data: {} }, text: "推送", state: "accepted", attempts: 1, nextAt: 0, externalId: "p1" });
    for (const id of ["out-b", "out-a"].reverse()) agent.set("communication_outbox", id, { id, taskId: null, route: { connectionId: "bark", target: "owner", messageId: "", data: {} }, text: id, state: "queued", attempts: 0, nextAt: 0 });
    agent.set("communication_outbox", "out-web", { id: "out-web", taskId: "turn-1", route: { ...route, connectionId: "web" }, text: "网页", final: true, state: "accepted", attempts: 0, nextAt: 0, externalId: "ev_2" });
    agent.set("communication_outbox", "out-media", { id: "out-media", taskId: null, originTaskId: "turn-1", route, text: "图", content: { text: "图", html: "<b>图</b>" }, state: "uncertain", attempts: 1, nextAt: 0, error: "send_interrupted" });
    const ledger = AgentLedger.open(agent);
    // A claim takes its message, session and fork parent from its inbox record. A purged one (tombstone) keeps what
    // its inbox record kept: the routing facts without the text.
    expect(ledger.claimByInput("in-1")).toMatchObject({ source, sessionKey: "c-main", forkFrom: "c-parent" });
    expect(ledger.claimByInput("in-2")).toMatchObject({ state: "tombstone", source: { text: "", reply: { target: "room" } }, sessionKey: "c-main" });
    // An inbox record that never had a claim is not carried over.
    expect(ledger.claimByInput("in-3")).toBeUndefined();
    // A delivery takes its text and turn from its outbox record and stays queued; records without a delivery row become one.
    expect(ledger.delivery("out-final")).toMatchObject({ status: "queued", purpose: "reply", text: "回答", turnId: "turn-1", eventId: "ev_1", conversationId: "cv_1" });
    expect(ledger.delivery("out-push")).toMatchObject({ status: "sent", purpose: "notice", text: "推送", platformMessageId: "p1", eventId: null, route: { target: "owner" } });
    expect(ledger.delivery("out-media")).toMatchObject({ status: "unknown", purpose: "content", originTurnId: "turn-1", content: { html: "<b>图</b>" }, error: "send_interrupted" });
    // Queued notifications keep the order they were queued in, and a waiting delivery that had no outbox record
    // (never sent before, nothing to send) is settled instead of going out empty.
    expect(ledger.dueDeliveries()).toEqual(["out-final", "out-a", "out-b"]);
    expect(ledger.delivery("out-stray")).toMatchObject({ status: "suppressed", error: "delivery_without_content" });
    // The web connection's event is its delivery.
    expect(ledger.delivery("out-web")).toBeUndefined();
    expect(agent.entries("communication_inbox")).toEqual([]); expect(agent.entries("communication_outbox")).toEqual([]);
  });
  it("adds owner routes and settlements to a store of the previous step without touching its rows", async () => {
    const { AGENT_LEDGER_V1, AGENT_LEDGER_V2, AGENT_LEDGER_V3, AGENT_LEDGER_V4, AGENT_LEDGER_V5 } = await import("../src/ledger/schema.js");
    const path = join(dir(), "agent.sqlite"), before = store(path, "agent-1");
    [AGENT_LEDGER_V1, AGENT_LEDGER_V2, AGENT_LEDGER_V3, AGENT_LEDGER_V4, AGENT_LEDGER_V5].forEach((sql, index) => before.migrate(index + 1, sql));
    // A conversation as the previous release left it: a turn that waits on a card, a queued input, and a queued delivery.
    before.db.exec(`INSERT INTO ledger_sessions(session_key,kind,label,last_seq,created_at,updated_at) VALUES('c-main','owner_main','owner-main',2,1,1);
      INSERT INTO ledger_session_windows(session_key,window,context_id,opened_at) VALUES('c-main',1,'c-main',1);
      INSERT INTO ledger_events(session_key,seq,event_id,window,kind,role,sender_type,sender_id,turn_id,idempotency_key,created_at,body)
        VALUES('c-main',1,'ev_1',1,'message','user','system','schedule','turn-1','work:rule-1',1,'{"text":"check","origin":"schedule","reference":"rule-1"}'),
          ('c-main',2,'ev_2',1,'card','assistant','agent','agent-1','turn-1','card:cd_1',2,'{"card":{"cardId":"cd_1","callId":"call-1","kind":"approval","text":"ok?","choices":[{"choiceId":"0","label":"同意"},{"choiceId":"1","label":"拒绝"}],"freeText":false}}');
      INSERT INTO ledger_pending_inputs(input_id,session_key,event_id,state,turn_id,created_at,updated_at) VALUES('work:rule-1','c-main','ev_1','started','turn-1',1,1),('in-2','c-main','ev_9','queued',NULL,2,2);
      INSERT INTO ledger_turns(turn_id,session_key,window,admission,origin_event_id,state,created_at) VALUES('turn-1','c-main',1,'schedule','ev_1','running',1);
      INSERT INTO ledger_cards(card_id,call_id,run_id,claim_id,turn_id,session_key,event_id,kind,status,deadline_at,updated_at,source) VALUES('cd_1','call-1','run-1','claim-1','turn-1','c-main','ev_2','approval','pending',NULL,2,'host');
      INSERT INTO ledger_card_tokens(token,card_id,choice_id,result) VALUES('t0','cd_1','0','{"decision":"accept"}'),('t1','cd_1','1','{"decision":"decline"}');
      INSERT INTO ledger_deliveries(delivery_id,event_id,conversation_id,connection_id,route,purpose,status,created_at,updated_at,text,turn_id)
        VALUES('out-1','ev_2','cv_1','chat','{"connectionId":"chat","target":"room","messageId":"m1","data":{},"channel":"chat"}','card','queued',2,2,'ok?','turn-1')`);
    const dump = (value: DurableStore) => Object.fromEntries(["ledger_sessions", "ledger_events", "ledger_pending_inputs", "ledger_turns", "ledger_cards", "ledger_card_tokens", "ledger_deliveries"]
      .map((table) => [table, (value.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>).map(({ route: _route, ...row }) => table === "ledger_deliveries" ? { ...row, route: _route } : row)]));
    const rows = dump(before);
    before.close();
    const after = store(path, "agent-1"), ledger = AgentLedger.open(after);
    expect(versions(after)).toEqual({ ledger_schema_version: 6 });
    // Every row is what it was; the new columns are empty and the new table has no rows.
    expect(dump(after)).toEqual(rows);
    expect(after.db.prepare("SELECT COUNT(*) AS n FROM ledger_pending_inputs WHERE route IS NOT NULL").get()!.n).toBe(0);
    expect(after.db.prepare("SELECT COUNT(*) AS n FROM ledger_cards WHERE route IS NOT NULL").get()!.n).toBe(0);
    expect(ledger.settlements()).toEqual([]);
    // The stored records read and move as before: the card of the run is not a product card, and it still closes.
    expect(ledger.cardRecord("cd_1")).toMatchObject({ status: "pending", source: "host", route: null, turnId: "turn-1" });
    expect(ledger.overdueCards(Date.now() + 1e12)).toEqual([]);
    expect(ledger.input("work:rule-1")).toMatchObject({ state: "started", turn_id: "turn-1", route: null });
    expect(ledger.dueInputs()).toEqual(["in-2"]);
    expect(ledger.dueDeliveries()).toEqual(["out-1"]);
    expect(ledger.planAnswer("cd_1", { key: "web:1", result: { decision: "accept" }, by: "p_1", surface: "web" })).toBe("planned");
    expect(ledger.cardStatus("cd_1", "approved")).toBe(true);
    expect(ledger.settlements()).toEqual([]);
    expect(ledger.turnState("turn-1", "completed")).toMatchObject({ kind: "turn" });
    // The new records are accepted beside them, and the cursor only grows.
    ledger.settle("work", "rule-1"); ledger.settle("work", "rule-1"); ledger.settle("request", "ask-1");
    expect(ledger.settlements().map((row) => [row.seq, row.kind, row.eventId])).toEqual([[1, "work", "rule-1"], [2, "request", "ask-1"]]);
    // A sequence number is never given out twice, also when rows are gone.
    after.db.exec("DELETE FROM ledger_settlements");
    ledger.settle("work", "rule-2");
    expect(ledger.settlements().map((row) => row.seq)).toEqual([3]);
    after.close();
    // Opening it again changes nothing.
    const again = store(path, "agent-1"); AgentLedger.open(again);
    expect(versions(again)).toEqual({ ledger_schema_version: 6 });
    expect(AgentLedger.open(again).settlements().map((row) => row.seq)).toEqual([3]);
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
  it("keeps the later shipped agent ledger steps unedited", async () => {
    const shipped = await import("../src/ledger/schema.js"), sha = (sql: string) => createHash("sha256").update(sql).digest("hex");
    expect([shipped.AGENT_LEDGER_V3, shipped.AGENT_LEDGER_V4, shipped.AGENT_LEDGER_V5].map(sha)).toEqual([
      "8f5affa678257ffc3d0fca546f008daaebded25914f771424a480f26728f4c9a",
      "21158f0bae1cc0798ccdfeedd4e13c8d71bdd656948813092fdd807af5e4b807",
      "775a009b39d160c67dbf0a7fb61f31d63bb5994e25ce50653e849b4a154139f2",
    ]);
  });
});
