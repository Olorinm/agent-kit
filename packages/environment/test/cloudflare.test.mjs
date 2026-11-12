import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCloudflareProvider } from "../dist/index.js";
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
test("rejects nonlocal HTTP, credential URLs and path injection before network I/O", () => {
  for (const apiUrl of ["http://example.com", "https://user:key@example.com", "https://example.com/private"])
    assert.throws(() => createCloudflareProvider({ id: "cf", apiUrl, apiKey: "test", allowHttp: true }));
});
