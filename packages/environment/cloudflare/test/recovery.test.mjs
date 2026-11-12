import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the real gateway and Durable Object routes with the Cloudflare runtime
// replaced by an in-memory container. No account or remote service is contacted.
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const runtime = moduleUrl("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}");
const backup = moduleUrl(compile(await readFile(new URL("../src/backup.ts", import.meta.url), "utf8")));
const worker = compile(await readFile(new URL("../src/index.ts", import.meta.url), "utf8"))
  .replace('from "cloudflare:workers"', `from "${runtime}"`)
  .replace('from "./backup"', `from "${backup}"`)
  .replace('from "./security.mjs"', `from "${new URL("../src/security.mjs", import.meta.url)}"`)
  .replace('from "./egress.mjs"', `from "${new URL("../src/egress.mjs", import.meta.url)}"`);
const { default: gateway, AgentSandbox } = await import(moduleUrl(worker));
const id = "33333333-3333-4333-8333-333333333333";
const control = "fixture-operator-control";

function fixture(overrides = {}, running = false) {
  const record = { id, template: "node24", metadata: { owner: "unchanged" }, env: { FIXTURE: "preserved" },
    status: "running", expires: 1, onTimeout: "pause", snapshot: { id: "original-snapshot", size: 123, createdAt: 1 }, ...overrides };
  const records = new Map([["record", structuredClone(record)]]), starts = [], commands = [], policy = [];
  const container = {
    running,
    start(options) { starts.push(options); this.running = true; },
    async destroy() { this.running = false; },
    async snapshotContainer() { return { id: "repaired-snapshot", size: 124 }; },
    async interceptAllOutboundHttp(target) { policy.push(["http", target]); },
    async interceptOutboundHttps(address, target) { policy.push(["https", address, target]); },
    async setInactivityTimeout(value) { policy.push(["idle", value]); },
    async exec(argv) { commands.push(argv); return { async output() { return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }; } }; },
  };
  const storage = { async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { records.set(key, structuredClone(value)); }, async setAlarm() {}, async deleteAlarm() {} };
  const ctx = { container, storage, exports: { AgentEgress: () => ({ policy: "existing-egress" }) },
    blockConcurrencyWhile: work => work() };
  const env = { CONTROL_TOKEN: control, DAILY_RUNTIME_MINUTES: "240", CATALOG: { getByName: () => ({ contains: async value => value === id }) } };
  const sandbox = new AgentSandbox(ctx, env);
  env.SANDBOXES = { getByName(value) { assert.equal(value, id); return sandbox; } };
  const request = (body = { fromLatestSnapshot: true }, key = control, action = "recover") => gateway.fetch(
    new Request(`https://gateway.test/v1/environments/${id}/${action}`, {
      method: "POST", headers: { "X-Environment-Control": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env);
  return { record, records, starts, commands, policy, sandbox, container, request };
}

for (const status of ["running", "unknown"]) test(`operator recovery restores the same stopped ${status} environment in fixed maintenance mode`, async () => {
  const f = fixture({ status }), before = Date.now();
  const response = await f.request(), value = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(value, { id, template: "node24", metadata: { owner: "unchanged" }, state: "running", maintenance: true, snapshotId: "original-snapshot" });
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0].containerSnapshot, { id: "original-snapshot" });
  assert.equal(f.starts[0].image, undefined);
  assert.deepEqual(f.starts[0].entrypoint, ["sh", "-c", "exec sleep infinity"]);
  assert.equal(f.starts[0].enableInternet, false);
  assert.equal(f.starts[0].env.FIXTURE, "preserved");
  assert.equal(f.starts[0].env.NODE_EXTRA_CA_CERTS, "/etc/cloudflare/certs/cloudflare-containers-ca.crt");
  assert.deepEqual(f.policy.slice(0, 2).map(p => p.slice(0, -1)), [["http"], ["https", "*"]]);
  assert.ok(f.commands.some(argv => argv.join(" ").includes("update-ca-certificates")));
  const saved = f.records.get("record");
  assert.deepEqual(saved.snapshot, f.record.snapshot); assert.equal(saved.id, id);
  assert.ok(saved.expires >= before + 600_000 && saved.expires <= Date.now() + 600_000);
  assert.deepEqual(await (await f.sandbox.fetch(new Request("https://internal/info"))).json(), value);
  const retry = await f.request();
  assert.equal(retry.status, 409); assert.equal((await retry.json()).error, "recovery_requires_stopped");
  assert.equal(f.starts.length, 1);
});

test("recovery fails before dispatch without operator authority, explicit confirmation, a valid stopped state and a snapshot", async () => {
  const cases = [
    { key: "wrong", error: "unauthorized", status: 401 },
    { body: {}, error: "snapshot_recovery_confirmation_required", status: 400 },
    { body: { fromLatestSnapshot: false }, error: "snapshot_recovery_confirmation_required", status: 400 },
    { body: { fromLatestSnapshot: "true" }, error: "snapshot_recovery_confirmation_required", status: 400 },
    { body: { fromLatestSnapshot: true, entrypoint: ["sh"] }, error: "invalid_recovery_request", status: 400 },
    { body: { fromLatestSnapshot: true, snapshotId: "other" }, error: "invalid_recovery_request", status: 400 },
    { body: { fromLatestSnapshot: true, timeoutSeconds: 0 }, error: "invalid_lifetime", status: 400 },
    { running: true, error: "recovery_requires_stopped", status: 409 },
    { record: { snapshot: undefined }, error: "snapshot_missing", status: 409 },
    { record: { status: "paused" }, error: "recovery_requires_failed_start", status: 409 },
    { record: { status: "creating" }, error: "recovery_requires_failed_start", status: 409 },
    { record: { status: "missing" }, error: "environment_missing", status: 404 },
  ];
  for (const item of cases) {
    const f = fixture(item.record, item.running), response = await f.request(item.body, item.key);
    assert.equal(response.status, item.status, JSON.stringify(item));
    assert.equal((await response.json()).error, item.error);
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.records.get("record"), f.record);
  }
});

test("recovery preserves lifecycle exclusion and the daily runtime limit", async () => {
  const busy = fixture(); busy.sandbox.busy = 1;
  assert.equal((await (await busy.request()).json()).error, "environment_busy");
  assert.equal(busy.starts.length, 0);
  const exhausted = fixture();
  exhausted.records.set("runtime", { day: new Date().toISOString().slice(0, 10), usedMs: 240 * 60000, startedAt: 0 });
  const response = await exhausted.request();
  assert.equal(response.status, 429); assert.equal((await response.json()).error, "daily_runtime_limit");
  assert.equal(exhausted.starts.length, 0);
});

test("normal pause and resume persist repair in the same environment and leave maintenance mode", async () => {
  const f = fixture();
  assert.equal((await f.request({ fromLatestSnapshot: true, timeoutSeconds: 1800 })).status, 200);
  // An existing successful daily backup avoids unrelated backup work in this fixture.
  f.records.set("backup", { version: 2, createdAt: Date.now() });
  assert.equal((await f.request({}, control, "pause")).status, 200);
  assert.equal(f.records.get("record").maintenance, undefined);
  const response = await f.request({ timeoutSeconds: 600 }, control, "resume");
  assert.equal(response.status, 200);
  assert.deepEqual(f.starts[1].containerSnapshot, { id: "repaired-snapshot" });
  assert.match(f.starts[1].entrypoint[2], /exec sh \/opt\/agent-environment\/start\.sh$/);
  assert.equal((await response.json()).maintenance, undefined);
  assert.equal(f.records.get("record").id, id);
});

test("maintenance expiry pauses instead of deleting an environment whose normal timeout policy is kill", async () => {
  const f = fixture({ onTimeout: "kill" });
  assert.equal((await f.request()).status, 200);
  f.records.set("record", { ...f.records.get("record"), expires: Date.now() - 1 });
  f.records.set("backup", { version: 2, createdAt: Date.now() });
  await f.sandbox.alarm();
  const saved = f.records.get("record");
  assert.equal(saved.status, "paused"); assert.equal(saved.id, id);
  assert.deepEqual(saved.snapshot, { id: "repaired-snapshot", size: 124, createdAt: saved.snapshot.createdAt });
  assert.equal(saved.maintenance, undefined);
  assert.equal(saved.onTimeout, "kill");
  assert.deepEqual(saved.env, f.record.env);
});
