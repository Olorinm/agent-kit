import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Exercise the real gateway and Durable Object routes with the Cloudflare runtime
// replaced by an in-memory container. No account or remote service is contacted.
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
// Node removes the type annotations itself; the TypeScript package no longer ships a JavaScript compiler API.
const compile = source => stripTypeScriptTypes(source, { mode: "transform" });
const runtime = moduleUrl("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}");
const backup = moduleUrl(compile(await readFile(new URL("../src/backup.ts", import.meta.url), "utf8")));
const worker = compile(await readFile(new URL("../src/index.ts", import.meta.url), "utf8"))
  .replace('from "cloudflare:workers"', `from "${runtime}"`)
  .replace('from "./backup"', `from "${backup}"`)
  .replace('from "./security.mjs"', `from "${new URL("../src/security.mjs", import.meta.url)}"`)
  .replace('from "./egress.mjs"', `from "${new URL("../src/egress.mjs", import.meta.url)}"`)
  .replace('from "./credentials.mjs"', `from "${new URL("../src/credentials.mjs", import.meta.url)}"`);
const { default: gateway, AgentSandbox, AgentEgress, Catalog } = await import(moduleUrl(worker));

test("Git, gh, DSH and Claude use the credential of their respective upstream service", async t => {
  const entries = new Map();
  const catalog = new Catalog({ storage: { get: key => entries.get(key), put: (key,value) => entries.set(key,value) },
    blockConcurrencyWhile: body => body() }, {});
  const env = { CONTROL_TOKEN: "control", CATALOG: { getByName: () => catalog } };
  for (const [service, credential] of [
    ["anthropic", { mode: "api_key", apiKey: "anthropic-fixture" }],
    ["github", { mode: "token", accessToken: "github-fixture" }], ["deepseek", { mode: "api_key", apiKey: "deepseek-fixture" }],
  ]) {
    const result = await gateway.fetch(new Request("https://gateway.test/v1/model-credentials/" + service, {
      method: "PUT", headers: { "X-Environment-Control": "control" }, body: JSON.stringify({ service, ...credential }),
    }), env);
    assert.equal(result.status, 200);
    assert.equal((await result.text()).includes("-fixture"), false);
  }
  const requests = [];
  t.mock.method(globalThis, "fetch", async (request, options) => {
    requests.push({ request, options, body: await request.text() });
    return new Response("ok");
  });
  const credentials = { github: "github", deepseek: "deepseek", anthropic: "anthropic" };
  const dispatch = (url, method, selection = credentials) => Object.assign(new AgentEgress(),
    { ctx: { props: { modelServices: ["deepseek", "anthropic"], modelCredentials: selection } }, env }).fetch(new Request(url, {
      method, headers: { Authorization: "Bearer gateway-managed", Cookie: "should-not-travel", "X-Api-Key": "gateway-managed" },
      ...(method === "POST" ? { body: "test body" } : {}),
    }));
  for (const [url, method, expected] of [
    ["https://github.com/team/project.git/info/refs?service=git-upload-pack", "GET", "Basic " + btoa("x-access-token:github-fixture")],
    ["https://github.com/team/project/git-receive-pack", "POST", "Basic " + btoa("x-access-token:github-fixture")],
    ["https://api.github.com/repos/team/project/pulls", "POST", "Bearer github-fixture"],
    ["https://api.github.com/graphql", "POST", "Bearer github-fixture"],
    ["https://uploads.github.com/repos/team/project/releases/52/assets?name=a.tgz", "POST", "Bearer github-fixture"],
    ["https://api.anthropic.com/v1/messages?beta=true", "POST", "anthropic-fixture"],
    ["https://api.deepseek.com/models", "GET", "deepseek-fixture"],
    ["https://api.deepseek.com/anthropic/v1/messages", "POST", "deepseek-fixture"],
    ["https://api.deepseek.com/anthropic/v1/files/file_1", "DELETE", "deepseek-fixture"],
  ]) {
    assert.equal((await dispatch(url, method)).status, 200, url);
    const { request, options, body } = requests.at(-1);
    assert.equal(options.redirect, "manual");
    const github = ["github.com", "api.github.com", "uploads.github.com"].includes(new URL(url).hostname);
    assert.equal(request.headers.get("authorization"), github ? expected : null);
    assert.equal(request.headers.get("x-api-key"), github ? null : expected);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.url, url);
    assert.equal(body, method === "POST" ? "test body" : "");
  }
  const before = requests.length;
  for (const [url, method, selection] of [
    ["https://github.com/team/project/issues", "POST", credentials],
    ["https://github.com/team/project/info/refs?service=unexpected", "GET", credentials],
    ["https://api.github.com/repos/team/project", "GET", {}],
    ["https://api.github.com/repos/team/project", "GET", { github: "deepseek" }],
    ["https://api.deepseek.com/anthropic/v1/messages", "POST", { deepseek: "github" }],
    ["https://api.anthropic.com/v1/messages", "POST", { anthropic: "deepseek" }],
    ["https://api.anthropic.com/v1/files", "POST", credentials],
    ["https://api.deepseek.com/unrelated", "POST", credentials],
    ["https://github.io/team/project.git/git-upload-pack", "POST", credentials],
    ["http://api.github.com/graphql", "POST", credentials],
  ]) assert.equal((await dispatch(url, method, selection)).status, 403, url);
  assert.equal(requests.length, before);
});
const id = "33333333-3333-4333-8333-333333333333";
const control = "fixture-operator-control";

function fixture(overrides = {}, running = false) {
  const record = { id, template: "node24", metadata: { owner: "unchanged" }, env: { FIXTURE: "preserved" },
    status: "running", expires: 1, onTimeout: "pause", snapshot: { id: "original-snapshot", size: 123, createdAt: 1 }, ...overrides };
  const records = new Map([["record", structuredClone(record)]]), starts = [], commands = [], policy = [], egress = [];
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
  const ctx = { container, storage, exports: { AgentEgress: options => { egress.push(options); return { policy: "existing-egress" }; } },
    blockConcurrencyWhile: work => work() };
  const env = { CONTROL_TOKEN: control, DAILY_RUNTIME_MINUTES: "240", CATALOG: { getByName: () => ({ contains: async value => value === id, getCredential: async () => null }) } };
  const sandbox = new AgentSandbox(ctx, env);
  env.SANDBOXES = { getByName(value) { assert.equal(value, id); return sandbox; } };
  const request = (body = { fromLatestSnapshot: true }, key = control, action = "recover") => gateway.fetch(
    new Request(`https://gateway.test/v1/environments/${id}/${action}`, {
      method: "POST", headers: { "X-Environment-Control": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env);
  return { record, records, starts, commands, policy, egress, sandbox, container, request };
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

const security = async f => (await (await f.sandbox.fetch(new Request("https://internal/security"))).json()).modelServices;

test("an environment without a selection starts with the default model services", async () => {
  const f = fixture({ status: "paused" });
  assert.equal((await f.request({ timeoutSeconds: 600 }, control, "resume")).status, 200);
  assert.deepEqual(f.egress, [{ props: { modelServices: ["openai"] } }]);
  assert.equal("modelServices" in f.records.get("record"), false);
  assert.deepEqual(await security(f), ["openai"]);
  const recovered = fixture();
  assert.equal((await recovered.request()).status, 200);
  assert.deepEqual(recovered.egress, [{ props: { modelServices: ["openai"] } }]);
});

test("create stores the product's model services and starts the container with them", async () => {
  const create = async body => {
    const f = fixture(); f.records.delete("record");
    const response = await f.sandbox.fetch(new Request("https://internal/create", { method: "POST", body: JSON.stringify({ id, template: "node24", ...body }) }));
    assert.equal(response.status, 200);
    return f;
  };
  const plain = await create({});
  assert.deepEqual(plain.egress, [{ props: { modelServices: ["openai"] } }]);
  assert.equal("modelServices" in plain.records.get("record"), false);
  const selected = await create({ modelServices: ["openai", "anthropic"] });
  assert.deepEqual(selected.egress, [{ props: { modelServices: ["openai", "anthropic"] } }]);
  assert.deepEqual(selected.records.get("record").modelServices, ["openai", "anthropic"]);
  assert.deepEqual(await security(selected), ["openai", "anthropic"]);
  const packagesOnly = await create({ modelServices: [] });
  assert.deepEqual(packagesOnly.egress, [{ props: { modelServices: [] } }]);
  assert.deepEqual(await security(packagesOnly), []);
  const invalid = fixture(); invalid.records.delete("record");
  const response = await invalid.sandbox.fetch(new Request("https://internal/create", { method: "POST", body: JSON.stringify({ id, template: "node24", modelServices: ["unknown"] }) }));
  assert.equal(response.ok, false); assert.equal(invalid.starts.length, 0); assert.equal(invalid.records.has("record"), false);
});

test("resume stores a new selection before the restored container starts and later resumes keep it", async () => {
  const f = fixture({ status: "paused" });
  const response = await f.request({ timeoutSeconds: 600, modelServices: ["openai", "anthropic"] }, control, "resume");
  assert.equal(response.status, 200);
  assert.deepEqual(f.starts[0].containerSnapshot, { id: "original-snapshot" });
  assert.deepEqual(f.egress, [{ props: { modelServices: ["openai", "anthropic"] } }]);
  assert.deepEqual(f.records.get("record").modelServices, ["openai", "anthropic"]);
  f.records.set("backup", { version: 2, createdAt: Date.now() });
  assert.equal((await f.request({}, control, "pause")).status, 200);
  assert.equal((await f.request({ timeoutSeconds: 600 }, control, "resume")).status, 200);
  assert.deepEqual(f.egress[1], { props: { modelServices: ["openai", "anthropic"] } });
  assert.deepEqual(await security(f), ["openai", "anthropic"]);
  // The selection is durable even when the start itself is refused.
  const exhausted = fixture({ status: "paused" });
  exhausted.records.set("runtime", { day: new Date().toISOString().slice(0, 10), usedMs: 240 * 60000, startedAt: 0 });
  const refused = await exhausted.request({ modelServices: ["anthropic"] }, control, "resume");
  assert.equal(refused.status, 429); assert.equal(exhausted.starts.length, 0);
  assert.deepEqual(exhausted.records.get("record").modelServices, ["anthropic"]);
});

test("resume of a running environment records the selection for its next start without touching the container", async () => {
  const f = fixture({ modelServices: ["openai"] }, true);
  const response = await f.request({ modelServices: ["anthropic"] }, control, "resume");
  assert.equal(response.status, 200); assert.equal((await response.json()).state, "running");
  assert.equal(f.starts.length, 0); assert.deepEqual(f.egress, []);
  assert.deepEqual(f.policy.filter(p => p[0] !== "idle"), []);
  assert.deepEqual(f.records.get("record").modelServices, ["anthropic"]);
  assert.equal((await f.request({ timeoutSeconds: 600 }, control, "resume")).status, 200);
  assert.deepEqual(f.records.get("record").modelServices, ["anthropic"]);
  f.records.set("backup", { version: 2, createdAt: Date.now() });
  assert.equal((await f.request({}, control, "pause")).status, 200);
  assert.equal((await f.request({}, control, "resume")).status, 200);
  assert.deepEqual(f.egress, [{ props: { modelServices: ["anthropic"] } }]);
});

test("resume rejects an invalid model service selection without changing the environment", async () => {
  for (const modelServices of [null, "anthropic", ["unknown"], ["openai", "openai"], [1], Array(9).fill("openai")]) for (const running of [false, true]) {
    const f = fixture({ status: running ? "running" : "paused" }, running);
    const response = await f.request({ timeoutSeconds: 600, modelServices }, control, "resume");
    assert.equal(response.status, 400, JSON.stringify(modelServices));
    assert.equal((await response.json()).error, "invalid_model_services");
    assert.equal(f.starts.length, 0); assert.deepEqual(f.egress, []);
    assert.deepEqual(f.records.get("record"), f.record);
  }
  const stopped = fixture({ status: "running" });
  const response = await stopped.request({ modelServices: ["anthropic"] }, control, "resume");
  assert.equal(response.status, 409); assert.equal((await response.json()).error, "resume_requires_paused");
  assert.deepEqual(stopped.records.get("record"), stopped.record);
});

test("the egress entrypoint enforces the model services it was started with", async t => {
  const forwarded = [];
  t.mock.method(globalThis, "fetch", async (request, options) => { forwarded.push([request.url, options]); return new Response("upstream"); });
  const call = (props, url) => Object.assign(new AgentEgress(), { ctx: { props } }).fetch(new Request(url, { method: "POST", body: "{}" }));
  const openai = "https://api.openai.com/v1/responses", anthropic = "https://api.anthropic.com/v1/messages";
  for (const [props, url, allowed] of [
    [{}, openai, true], [{}, anthropic, false],
    [{ modelServices: ["openai"] }, anthropic, false],
    [{ modelServices: ["anthropic"] }, anthropic, true], [{ modelServices: ["anthropic"] }, openai, false],
    [{ modelServices: ["openai", "anthropic"] }, anthropic, true], [{ modelServices: ["openai", "anthropic"] }, openai, true],
    [{ modelServices: [] }, openai, false], [{ modelServices: [] }, anthropic, false],
  ]) {
    forwarded.length = 0;
    const response = await call(props, url);
    if (allowed) { assert.equal(await response.text(), "upstream"); assert.deepEqual(forwarded, [[url, { redirect: "manual" }]]); }
    else { assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "destination_not_allowed" }); assert.deepEqual(forwarded, []); }
  }
});

const token = account => `Bearer e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.c2ln`;

test("model accounts are stored with the environment, reach the egress entrypoint at its next start and can be removed", async () => {
  const f = fixture({ status: "paused" });
  f.records.set("backup", { version: 2, createdAt: Date.now() });
  assert.equal((await f.request({ timeoutSeconds: 600, modelAccounts: { openai: ["account-1"] } }, control, "resume")).status, 200);
  assert.deepEqual(f.egress, [{ props: { modelServices: ["openai"], modelAccounts: { openai: ["account-1"] } } }]);
  assert.deepEqual(f.records.get("record").modelAccounts, { openai: ["account-1"] });
  assert.deepEqual((await (await f.sandbox.fetch(new Request("https://internal/security"))).json()).modelAccounts, { openai: ["account-1"] });
  // A resume without the field keeps it; one for a running environment stores the change for the next start.
  assert.equal((await f.request({}, control, "pause")).status, 200);
  assert.equal((await f.request({ timeoutSeconds: 600 }, control, "resume")).status, 200);
  assert.deepEqual(f.egress[1], { props: { modelServices: ["openai"], modelAccounts: { openai: ["account-1"] } } });
  assert.equal((await f.request({ modelAccounts: { openai: ["account-2"] } }, control, "resume")).status, 200);
  assert.equal(f.egress.length, 2);
  assert.deepEqual(f.records.get("record").modelAccounts, { openai: ["account-2"] });
  assert.equal((await f.request({}, control, "pause")).status, 200);
  assert.equal((await f.request({ modelAccounts: {} }, control, "resume")).status, 200);
  assert.deepEqual(f.egress[2], { props: { modelServices: ["openai"] } });
  assert.equal("modelAccounts" in f.records.get("record"), false);
  assert.equal((await (await f.sandbox.fetch(new Request("https://internal/security"))).json()).modelAccounts, null);
  const created = fixture(); created.records.delete("record");
  assert.equal((await created.sandbox.fetch(new Request("https://internal/create", { method: "POST", body: JSON.stringify({ id, template: "node24", modelAccounts: { openai: ["account-1"] } }) }))).status, 200);
  assert.deepEqual(created.egress, [{ props: { modelServices: ["openai"], modelAccounts: { openai: ["account-1"] } } }]);
  for (const modelAccounts of [null, ["account-1"], { openai: [] }, { anthropic: ["account-1"] }]) {
    const invalid = fixture({ status: "paused" });
    const response = await invalid.request({ timeoutSeconds: 600, modelAccounts }, control, "resume");
    assert.equal(response.status, 400); assert.equal((await response.json()).error, "invalid_model_accounts");
    assert.equal(invalid.starts.length, 0); assert.deepEqual(invalid.records.get("record"), invalid.record);
  }
});

test("the egress entrypoint refuses another account's token and the API host before anything is sent upstream", async t => {
  const forwarded = [];
  t.mock.method(globalThis, "fetch", async request => { forwarded.push(request.url); return new Response("upstream"); });
  const call = (props, url, headers = {}) => Object.assign(new AgentEgress(), { ctx: { props } }).fetch(new Request(url, { method: "POST", headers, body: "owner data" }));
  const pinned = { modelAccounts: { openai: ["account-1"] } }, codex = "https://chatgpt.com/backend-api/codex/responses", api = "https://api.openai.com/v1/responses";
  for (const [props, url, headers, error] of [
    [pinned, codex, { Authorization: token("account-1") }, undefined],
    [pinned, codex, { Authorization: token("account-2") }, "model_account_not_allowed"],
    [pinned, codex, {}, "model_account_required"],
    [pinned, codex, { Authorization: "Bearer sk-fixture-key" }, "model_account_required"],
    [pinned, api, { Authorization: "Bearer sk-fixture-key" }, "model_api_key_not_allowed"],
    [pinned, "https://auth.openai.com/oauth/token", {}, undefined],
    [pinned, "https://evil.test/collect", { Authorization: token("account-1") }, "destination_not_allowed"],
    [{}, codex, { Authorization: token("account-2") }, undefined], [{}, api, { Authorization: "Bearer sk-fixture-key" }, undefined],
  ]) {
    forwarded.length = 0;
    const response = await call(props, url, headers);
    if (error) { assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error }); assert.deepEqual(forwarded, []); }
    else { assert.equal(await response.text(), "upstream"); assert.deepEqual(forwarded, [url]); }
  }
});

test("gateway stores OpenAI credentials outside sandboxes, injects live headers, refreshes on 401 and blocks guest auth.openai.com", async t => {
  const storeMap = new Map();
  const storage = {
    async get(key) { return structuredClone(storeMap.get(key)); },
    async put(key, value) { storeMap.set(key, structuredClone(value)); },
    async delete(key) { return storeMap.delete(key); },
    async list({ prefix = "" } = {}) {
      return new Map([...storeMap.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
    },
  };
  const catalog = new Catalog({ storage, blockConcurrencyWhile: fn => fn() }, { MAX_ENVIRONMENTS: "3" });
  const env = { CONTROL_TOKEN: control, CATALOG: { getByName: () => catalog } };
  const makeJwt = (acct, exp) => `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: acct } })).toString("base64url")}.sig`;
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const tok1 = makeJwt("account-1", futureExp), tok2 = makeJwt("account-1", futureExp + 3600);

  // Operator stores credential via HTTP route; response never discloses secrets.
  const putRes = await gateway.fetch(new Request("https://gateway.test/v1/model-credentials/codex-main", {
    method: "PUT",
    headers: { "X-Environment-Control": control, "Content-Type": "application/json" },
    body: JSON.stringify({ service: "openai", mode: "chatgpt", accessToken: tok1, refreshToken: "rt_secret_1" }),
  }), env);
  assert.equal(putRes.status, 200);
  const putBody = await putRes.json();
  assert.equal(putBody.id, "codex-main"); assert.equal(putBody.accountId, "account-1"); assert.equal(putBody.renewable, true);
  assert.equal(JSON.stringify(putBody).includes(tok1), false);
  assert.equal(JSON.stringify(putBody).includes("rt_secret_1"), false);

  // AgentEgress replaces placeholder Authorization + ChatGPT-Account-ID, blocks auth.openai.com, and retries once after 401 refresh.
  const upstreamCalls = [];
  let codexAttempts = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url === "https://auth.openai.com/oauth/token") {
      const body = await req.json();
      assert.equal(body.refresh_token, "rt_secret_1");
      return Response.json({ access_token: tok2, refresh_token: "rt_secret_2" });
    }
    upstreamCalls.push({ url: req.url, auth: req.headers.get("authorization"), acct: req.headers.get("chatgpt-account-id"), body: await req.text() });
    codexAttempts++;
    return codexAttempts === 1 ? new Response("unauthorized", { status: 401 }) : new Response("ok-after-refresh", { status: 200 });
  });
  const egress = Object.assign(new AgentEgress(), {
    ctx: { props: { modelServices: ["openai"], modelAccounts: { openai: ["account-1"] }, modelCredentials: { openai: "codex-main" } } },
    env,
  });
  // Guest calling auth.openai.com directly is refused.
  const blockedAuth = await egress.fetch(new Request("https://auth.openai.com/oauth/token", { method: "POST", body: "{}" }));
  assert.equal(blockedAuth.status, 403); assert.deepEqual(await blockedAuth.json(), { error: "destination_not_allowed" });

  // Guest calling chatgpt.com with placeholder token gets real token injected, refreshed on 401, and retried transparently.
  const res = await egress.fetch(new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { Authorization: "Bearer placeholder-only", "ChatGPT-Account-ID": "spoofed-account" },
    body: '{"hello":"world"}',
  }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok-after-refresh");
  assert.deepEqual(upstreamCalls, [
    { url: "https://chatgpt.com/backend-api/codex/responses", auth: `Bearer ${tok1}`, acct: "account-1", body: '{"hello":"world"}' },
    { url: "https://chatgpt.com/backend-api/codex/responses", auth: `Bearer ${tok2}`, acct: "account-1", body: '{"hello":"world"}' },
  ]);

  // A second deployment still has the original import. An insert-only PUT must preserve the rotated token.
  const repeated = await gateway.fetch(new Request("https://gateway.test/v1/model-credentials/codex-main", {
    method: "PUT", headers: { "X-Environment-Control": control, "If-None-Match": "*" },
    body: JSON.stringify({ service: "openai", mode: "chatgpt", accessToken: tok1, refreshToken: "rt_secret_1" }),
  }), env);
  assert.equal(repeated.status, 200);
  assert.equal((await storeMap.get("cred:codex-main")).refreshToken, "rt_secret_2");

  // Environment create and resume persist modelCredentials and expose only IDs on /security.
  const f = fixture({ status: "paused" });
  f.records.set("backup", { version: 2, createdAt: Date.now() });
  assert.equal((await f.request({ timeoutSeconds: 600, modelCredentials: { openai: "codex-main" } }, control, "resume")).status, 200);
  assert.deepEqual(f.egress[0], { props: { modelServices: ["openai"], modelCredentials: { openai: "codex-main" } } });
  assert.deepEqual((await (await f.sandbox.fetch(new Request("https://internal/security"))).json()).modelCredentials, { openai: "codex-main" });
  assert.equal((await f.request({}, control, "pause")).status, 200);
  assert.equal((await f.request({ modelCredentials: {} }, control, "resume")).status, 200);
  assert.deepEqual(f.egress[1], { props: { modelServices: ["openai"] } });
  assert.equal((await (await f.sandbox.fetch(new Request("https://internal/security"))).json()).modelCredentials, null);
});

test("the gateway holds a Gemini API key, sends it in place of whatever the guest sent, and refuses a credential of the wrong service", async t => {
  const storeMap = new Map();
  const storage = {
    async get(key) { return structuredClone(storeMap.get(key)); },
    async put(key, value) { storeMap.set(key, structuredClone(value)); },
    async delete(key) { return storeMap.delete(key); },
    async list({ prefix = "" } = {}) { return new Map([...storeMap.entries()].filter(([k]) => k.startsWith(prefix))); },
  };
  const catalog = new Catalog({ storage, blockConcurrencyWhile: fn => fn() }, { MAX_ENVIRONMENTS: "3" });
  const env = { CONTROL_TOKEN: control, CATALOG: { getByName: () => catalog } };
  const put = (id, body) => gateway.fetch(new Request("https://gateway.test/v1/model-credentials/" + id, {
    method: "PUT", headers: { "X-Environment-Control": control }, body: JSON.stringify(body) }), env);
  const stored = await put("gemini-main", { service: "google", mode: "api_key", apiKey: "AIza-owner-key" });
  assert.equal(stored.status, 200);
  assert.deepEqual({ ...await stored.json(), updatedAt: "" }, { id: "gemini-main", service: "google", mode: "api_key", renewable: false, updatedAt: "" });
  assert.equal((await put("gemini-bad", { service: "google", mode: "chatgpt", accessToken: "x" })).status, 400);
  assert.equal((await put("openai-key", { service: "openai", mode: "api_key", apiKey: "sk-owner-key" })).status, 200);
  const listed = await (await gateway.fetch(new Request("https://gateway.test/v1/model-credentials", { headers: { "X-Environment-Control": control } }), env)).text();
  assert.ok(listed.includes("gemini-main") && !listed.includes("AIza-owner-key") && !listed.includes("sk-owner-key"));

  const upstream = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    upstream.push({ url: req.url, method: req.method, key: req.headers.get("x-goog-api-key"), auth: req.headers.get("authorization"), body: await req.text() });
    return new Response("upstream");
  });
  const egress = selection => Object.assign(new AgentEgress(), { ctx: { props: { modelServices: ["openai", "google"], modelCredentials: selection } }, env });
  const api = "https://generativelanguage.googleapis.com", turn = api + "/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse";
  const held = egress({ google: "gemini-main" });
  // What agy sends from a managed guest, then each credential a guest could try to send instead.
  for (const [url, headers] of [
    [turn, { "X-Goog-Api-Key": "gateway-managed" }],
    [turn, { "X-Goog-Api-Key": "AIza-someone-else" }],
    [turn, { Authorization: "Bearer ya29.someone-else" }],
    [turn + "&key=AIza-someone-else", {}],
    [turn + "&key=AIza-someone-else", { "X-Goog-Api-Key": "AIza-someone-else", Authorization: "Bearer ya29.someone-else" }],
  ]) {
    upstream.length = 0;
    const response = await held.fetch(new Request(url, { method: "POST", headers, body: "owner data" }));
    assert.equal(await response.text(), "upstream");
    assert.deepEqual(upstream, [{ url: turn, method: "POST", key: "AIza-owner-key", auth: null, body: "owner data" }]);
  }
  // The rest of the API is open to a held key and leaves under it as well.
  upstream.length = 0;
  await held.fetch(new Request(api + "/upload/v1beta/files?key=AIza-someone-else&uploadType=multipart", { method: "POST", body: "file" }));
  await held.fetch(new Request(api + "/v1beta/models", { headers: { "X-Goog-Api-Key": "AIza-someone-else" } }));
  assert.deepEqual(upstream, [
    { url: api + "/upload/v1beta/files?uploadType=multipart", method: "POST", key: "AIza-owner-key", auth: null, body: "file" },
    { url: api + "/v1beta/models", method: "GET", key: "AIza-owner-key", auth: null, body: "" },
  ]);

  // Refused before anything is sent: a credential that is missing, and one that belongs to the other service.
  const refused = async (selection, url, headers, error) => {
    upstream.length = 0;
    const response = await egress(selection).fetch(new Request(url, { method: "POST", headers, body: "owner data" }));
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error }); assert.deepEqual(upstream, []);
  };
  await refused({ google: "gemini-absent" }, turn, { "X-Goog-Api-Key": "AIza-someone-else" }, "model_credential_missing");
  await refused({ google: "openai-key" }, turn, { "X-Goog-Api-Key": "AIza-someone-else" }, "model_credential_service_mismatch");
  await refused({ openai: "gemini-main" }, "https://api.openai.com/v1/responses", { Authorization: "Bearer sk-placeholder" }, "model_credential_service_mismatch");
  await refused({ openai: "gemini-main" }, "https://chatgpt.com/backend-api/codex/responses", { Authorization: "Bearer placeholder" }, "model_credential_service_mismatch");
  assert.deepEqual(await catalog.resolveOpenAiCredential("gemini-main"), { service: "google", mode: "api_key", renewable: false });
  assert.deepEqual(await catalog.resolveServiceCredential("openai-key", "google"), { service: "openai", mode: "api_key", renewable: false });
  // Without a held Google key the guest's own key passes on the one admitted request, and nothing else is open.
  upstream.length = 0;
  await egress({ openai: "openai-key" }).fetch(new Request(turn, { method: "POST", headers: { "X-Goog-Api-Key": "AIza-guest-own" }, body: "b" }));
  assert.deepEqual(upstream, [{ url: turn, method: "POST", key: "AIza-guest-own", auth: null, body: "b" }]);
  await refused({ openai: "openai-key" }, api + "/upload/v1beta/files", { "X-Goog-Api-Key": "AIza-guest-own" }, "destination_not_allowed");

  // An environment is not created or resumed with an ID of the wrong service; the right ones are stored and shown.
  const create = body => gateway.fetch(new Request("https://gateway.test/v1/environments", {
    method: "POST", headers: { "X-Environment-Control": control }, body: JSON.stringify({ template: "node24", ...body }) }), env);
  for (const selection of [{ google: "openai-key" }, { openai: "gemini-main" }, { openai: "openai-key", google: "openai-key" }]) {
    const response = await create({ modelCredentials: selection });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "model_credential_service_mismatch" });
  }
  assert.deepEqual(await catalog.ids(), []);
  const f = fixture({ status: "paused" });
  f.sandbox.env.CATALOG.getByName = () => catalog;
  storeMap.set("id:" + f.record.id, {});
  const wrong = await f.request({ timeoutSeconds: 600, modelCredentials: { google: "openai-key" } }, control, "resume");
  assert.equal(wrong.status, 400); assert.deepEqual(await wrong.json(), { error: "model_credential_service_mismatch" });
  assert.equal(f.records.get("record").modelCredentials, undefined); assert.equal(f.starts.length, 0);
  const selection = { openai: "openai-key", google: "gemini-main" };
  assert.equal((await f.request({ timeoutSeconds: 600, modelServices: ["openai", "google"], modelCredentials: selection }, control, "resume")).status, 200);
  assert.deepEqual(f.egress[0], { props: { modelServices: ["openai", "google"], modelCredentials: selection } });
  assert.deepEqual((await (await f.sandbox.fetch(new Request("https://internal/security"))).json()).modelCredentials, selection);
});

test("a running guest must pause to change its credential binding; a restore scrubs before the entrypoint opens", async () => {
  const running = fixture({}, true);
  const selection = { modelCredentials: { openai: "managed" }, codexAuthUsers: ["user"] };
  const refused = await running.request(selection, control, "resume");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "credential_migration_requires_pause");
  assert.equal(running.records.get("record").modelCredentials, undefined);
  const paused = fixture({ status: "paused" });
  paused.sandbox.env.CATALOG.getByName = () => ({ contains: async () => true,
    getCredential: async () => ({ service: "openai", mode: "chatgpt", accountId: "owner", accessToken: "must-never-be-in-guest" }) });
  assert.equal((await paused.request(selection, control, "resume")).status, 200);
  const scrub = paused.commands.findIndex(cmd => cmd.includes("user") && cmd[1] === "-e");
  const release = paused.commands.findIndex(cmd => cmd.some(arg => arg.includes("touch /run/mau-network-ready-")));
  assert.ok(scrub >= 0 && scrub < release);
  assert.ok(!JSON.stringify(paused.commands).includes("must-never-be-in-guest"));
  assert.equal(JSON.parse(paused.commands[scrub].at(-1)).tokens.account_id, "owner");
  const bad = fixture({ status: "paused" });
  bad.sandbox.env.CATALOG.getByName = paused.sandbox.env.CATALOG.getByName;
  const exec = bad.container.exec.bind(bad.container);
  bad.container.exec = args => args.includes("user") ? { output: async () => ({ exitCode: 1 }) } : exec(args);
  assert.equal((await bad.request(selection, control, "resume")).status, 409);
  assert.equal(bad.container.running, false);
  assert.equal(bad.records.get("record").status, "paused");
  assert.ok(!bad.commands.some(cmd => cmd.some(arg => arg.includes("touch /run/mau-network-ready-"))));
});
