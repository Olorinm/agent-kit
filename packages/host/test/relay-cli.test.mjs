import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const run = promisify(execFile);
const cli = resolve("dist/service/relay-cli.js");

test("relay client forwards a command's arguments, falling back to the write tool only when the connector requires it", async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => {
      const input = JSON.parse(body); seen.push(input);
      const action = input.input;
      const result = action.action === "tools" ? { status: "completed", tools: [{ name: "google_gmail__gws_read" }, { name: "google_gmail__gws_write" }, { name: "google_gmail__get_thread" }] }
        : action.name.endsWith("_read") ? { status: "failed", error: "gws_command_requires_write_tool" }
        : { status: "completed", result: { output: "sent" } };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const env = { ...process.env, CODEX_THREAD_ID: "thread-1", CODEX_TOOL_CALL_ID: "exec-1", AGENT_HOST_RELAY_URL: `http://127.0.0.1:${server.address().port}` };
  const { stdout } = await run(process.execPath, [cli, "gws", "gmail", "+send", "--to", "a@example.test", "--subject", "Hi", "--body", "x y"], { env });
  assert.equal(stdout, "sent\n");
  assert.deepEqual(seen.map((call) => call.input.name ?? call.input.action), ["tools", "google_gmail__gws_read", "google_gmail__gws_write"]);
  assert.deepEqual(seen[2].input.arguments.args, ["gmail", "+send", "--to", "a@example.test", "--subject", "Hi", "--body", "x y"]);
  assert.ok(seen.every((call) => call.threadId === "thread-1" && call.callId === "exec-1" && call.tool === "connected_apps"));
  // Outside an Agent shell command there is no identity to relay.
  const { CODEX_THREAD_ID: _t, CODEX_TOOL_CALL_ID: _c, ...outside } = env;
  await assert.rejects(run(process.execPath, [cli, "gws", "gmail", "+triage"], { env: outside }), (error) => error.code === 2 && /Agent's shell/.test(error.stderr));
});
