import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCloudflareProvider, EnvironmentManager } from "../dist/index.js";
const id = "e85982d9-ea40-4be4-9646-02c07b7109d2";
async function withServer(handler, fn) {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers["x-environment-control"], "operator-test-key");
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const provider = createCloudflareProvider({ id: "cf", apiUrl, apiKey: "operator-test-key", allowHttp: true });
  try { await fn(provider, apiUrl); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
test("Cloudflare preserves BOM, split UTF-8, separate stderr and nonzero exit", async () => {
  const text = Buffer.from("\uFEFF中文");
  await withServer(async (_req, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    for (const bytes of [text.subarray(0, 2), text.subarray(2)])
      res.write(JSON.stringify({ stream: "stdout", data: bytes.toString("base64") }) + "\n");
    res.write(JSON.stringify({ stream: "stderr", data: Buffer.from("failure").toString("base64") }) + "\n");
    res.end('{"exitCode":7}\n');
  }, async provider => {
    let out = "", err = "", exit;
    for await (const chunk of provider.exec(id, ["fixture"], { onExit: e => exit = e.exitCode }))
      if (chunk.stream === "stdout") out += chunk.text; else err += chunk.text;
    assert.equal(out, "\uFEFF中文"); assert.equal(err, "failure"); assert.equal(exit, 7);
    assert.equal(provider.hasUncertainExecution(id), false);
  });
});
test("transport EOF without exit is uncertain and blocks pause", async () => {
  await withServer(async (_req, res) => res.end('{"stream":"stdout","data":"YQ=="}\n'), async p => {
    await assert.rejects(async () => { for await (const _ of p.exec(id, ["fixture"])) {} }, { code: "execution_uncertain" });
    assert.equal(p.hasUncertainExecution(id), true);
    await assert.rejects(p.pause(id), { code: "execution_uncertain" });
  });
});
test("an unrelated gateway 404 is not a missing environment", async () => {
  await withServer(async (_req, res) => { res.writeHead(404); res.end("<html>upstream missing</html>"); }, async p => {
    await assert.rejects(p.info(id), { code: "gateway_error" });
  });
});
test("provider missing response is distinguished from transport failure", async () => {
  await withServer(async (_req, res) => { res.writeHead(404); res.end('{"error":"environment_missing"}'); }, async p => {
    assert.equal((await p.info(id)).state, "missing");
  });
});
test("application endpoints never disclose operator keys or accept a redirect target", async () => {
  await withServer(async (_req, res) => res.end(JSON.stringify({
    url: "https://other.example/app", headers: { "X-Environment-Control": "operator-test-key" },
  })), async p => {
    await assert.rejects(p.httpEndpoint(id, 37420), { code: "invalid_endpoint_response" });
  });
});
test("binary file transfer and metadata filtering retain exact values", async () => {
  let written;
  await withServer(async (req, res) => {
    if (req.method === "PUT") {
      const chunks = []; for await (const c of req) chunks.push(c);
      written = JSON.parse(Buffer.concat(chunks)); res.end("{}");
    } else if (req.url.includes("/files")) res.end(Buffer.from(written.data, "base64"));
    else res.end(JSON.stringify([{ id, state: "paused", metadata: { owner: "one" } }]));
  }, async p => {
    const data = Uint8Array.from([0, 255, 128, 42, 10]);
    await p.writeFile(id, "/workspace/中文", data);
    assert.deepEqual(await p.readFile(id, "/workspace/中文"), data);
    assert.equal(written.path, "/workspace/中文");
    assert.equal((await p.list({ owner: "one" })).length, 1);
    assert.equal((await p.list({ owner: "two" })).length, 0);
  });
});
test("model services reach the gateway only when the caller selects them", async () => {
  const sent = [];
  await withServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    sent.push([req.method, req.url, Buffer.concat(chunks).toString()]);
    res.end(JSON.stringify({ id, state: "running", template: "node24", metadata: {} }));
  }, async p => {
    const manager = new EnvironmentManager([p]), ref = { provider: "cf", id };
    assert.deepEqual(await p.create({ template: "node24", timeoutSeconds: 600 }), ref);
    await p.create({ template: "node24", timeoutSeconds: 600, modelServices: undefined });
    await p.create({ template: "node24", timeoutSeconds: 600, modelServices: ["openai", "anthropic"] });
    await manager.create("cf", { template: "node24", modelServices: [] });
    assert.equal((await p.resume(id)).state, "running");
    await p.resume(id, 900);
    await p.resume(id, 900, {});
    await p.resume(id, 900, { modelServices: ["anthropic"] });
    await p.resume(id, undefined, { modelServices: [] });
    await manager.resume(ref);
    await manager.resume(ref, 900, { modelServices: ["openai", "anthropic"] });
    await p.create({ template: "node24", modelAccounts: { openai: ["account-1"] } });
    await manager.resume(ref, 900, { modelAccounts: { openai: ["account-1"] } });
    await p.resume(id, 900, { modelAccounts: {} });
    const create = body => ["POST", "/v1/environments", body], resume = body => ["POST", `/v1/environments/${id}/resume`, body];
    assert.deepEqual(sent, [
      create('{"template":"node24","timeoutSeconds":600}'),
      create('{"template":"node24","timeoutSeconds":600}'),
      create('{"template":"node24","timeoutSeconds":600,"modelServices":["openai","anthropic"]}'),
      create('{"template":"node24","modelServices":[]}'),
      resume('{"timeoutSeconds":600}'),
      resume('{"timeoutSeconds":900}'),
      resume('{"timeoutSeconds":900}'),
      resume('{"timeoutSeconds":900,"modelServices":["anthropic"]}'),
      resume('{"timeoutSeconds":600,"modelServices":[]}'),
      resume('{"timeoutSeconds":600}'),
      resume('{"timeoutSeconds":900,"modelServices":["openai","anthropic"]}'),
      create('{"template":"node24","modelAccounts":{"openai":["account-1"]}}'),
      resume('{"timeoutSeconds":900,"modelAccounts":{"openai":["account-1"]}}'),
      resume('{"timeoutSeconds":900,"modelAccounts":{}}'),
    ]);
  });
});
test("an invalid model service selection surfaces the gateway's error code", async () => {
  await withServer(async (req, res) => {
    res.writeHead(400); res.end(JSON.stringify({ error: req.url.endsWith("/resume") ? "invalid_model_services" : "invalid_create" }));
  }, async p => {
    await assert.rejects(p.resume(id, 600, { modelServices: ["unknown"] }), { code: "invalid_model_services", outcomeUnknown: false });
    await assert.rejects(p.create({ template: "node24", modelServices: ["unknown"] }), { code: "invalid_create", outcomeUnknown: false });
  });
});
test("rejects nonlocal HTTP, credential URLs and path injection before network I/O", () => {
  for (const apiUrl of ["http://example.com", "https://user:key@example.com", "https://example.com/private"])
    assert.throws(() => createCloudflareProvider({ id: "cf", apiUrl, apiKey: "test", allowHttp: true }));
});
test("CloudflareProvider stores and deletes gateway model credentials and passes modelCredentials on create and resume", async () => {
  const sent = [];
  await withServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    sent.push([req.method, req.url, raw]);
    if (req.url.startsWith("/v1/model-credentials/") && req.method === "PUT") {
      res.end(JSON.stringify({ id: "codex-main", service: "openai", mode: "chatgpt", accountId: "acct-1", renewable: true, updatedAt: "2026-11-22T00:00:00.000Z" }));
      return;
    }
    if (req.url.startsWith("/v1/model-credentials/") && req.method === "DELETE") { res.end(JSON.stringify({ deleted: true })); return; }
    res.end(JSON.stringify({ id, state: "running", template: "node24", metadata: {} }));
  }, async p => {
    const info = await p.putModelCredential("codex-main", { service: "openai", mode: "chatgpt", accessToken: "tok", refreshToken: "rt", accountId: "acct-1" });
    assert.equal(info.id, "codex-main"); assert.equal(info.accountId, "acct-1");
    await p.create({ template: "node24", modelCredentials: { openai: "codex-main" } });
    await p.resume(id, 900, { modelCredentials: { openai: "codex-main" } });
    await p.deleteModelCredential("codex-main");
    assert.deepEqual(sent, [
      ["PUT", "/v1/model-credentials/codex-main", JSON.stringify({ service: "openai", mode: "chatgpt", accessToken: "tok", refreshToken: "rt", accountId: "acct-1" })],
      ["POST", "/v1/environments", JSON.stringify({ template: "node24", modelCredentials: { openai: "codex-main" } })],
      ["POST", `/v1/environments/${id}/resume`, JSON.stringify({ timeoutSeconds: 900, modelCredentials: { openai: "codex-main" } })],
      ["DELETE", "/v1/model-credentials/codex-main", ""],
    ]);
    await assert.rejects(p.putModelCredential("../bad", { service: "openai", mode: "api_key", apiKey: "sk-1" }), { code: "invalid_credential_id" });
  });
});
test("CloudflareProvider stores a Gemini API key as a google credential and selects it on create and resume", async () => {
  const sent = [];
  let service = "google";
  await withServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    sent.push([req.method, req.url, Buffer.concat(chunks).toString(), req.headers["if-none-match"]]);
    if (req.url.startsWith("/v1/model-credentials/")) {
      res.end(JSON.stringify({ id: "gemini-main", service, mode: "api_key", renewable: false, updatedAt: "2026-11-23T00:00:00.000Z" }));
      return;
    }
    res.end(JSON.stringify({ id, state: "running", template: "node24", metadata: {} }));
  }, async p => {
    const input = { service: "google", mode: "api_key", apiKey: "AIza-fixture" };
    const info = await p.putModelCredential("gemini-main", input);
    assert.deepEqual(info, { id: "gemini-main", service: "google", mode: "api_key", renewable: false, updatedAt: "2026-11-23T00:00:00.000Z" });
    await p.putModelCredential("gemini-main", input, { ifAbsent: true });
    const selection = { modelServices: ["openai", "google"], modelCredentials: { openai: "codex-main", google: "gemini-main" } };
    await p.create({ template: "node24", ...selection });
    await p.resume(id, 900, selection);
    assert.deepEqual(sent, [
      ["PUT", "/v1/model-credentials/gemini-main", JSON.stringify(input), undefined],
      ["PUT", "/v1/model-credentials/gemini-main", JSON.stringify(input), "*"],
      ["POST", "/v1/environments", JSON.stringify({ template: "node24", ...selection }), undefined],
      ["POST", `/v1/environments/${id}/resume`, JSON.stringify({ timeoutSeconds: 900, ...selection }), undefined],
    ]);
    // An ID that already holds another service's credential is not taken for the one that was sent.
    service = "openai";
    await assert.rejects(p.putModelCredential("gemini-main", input, { ifAbsent: true }), { code: "invalid_response" });
  });
});
