import { createInterface } from "node:readline";
import {
  readFile,
  writeFile,
  mkdir,
  appendFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const home = process.env.HERMES_HOME;
await mkdir(home, { recursive: true });
let mcpConfig, mcp, transport;
const live = new Map(),
  pending = new Map();
let next = 1000;
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const event = (id, type, payload) =>
  send({ method: "event", params: { session_id: id, type, payload } });
const ask = (session_id, method, params) =>
  new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    send({ id, method, params: { session_id, ...params } });
  });
const file = (id) => join(home, id + ".json");
async function turn(id, text) {
  event(undefined, "message.complete", {
    text: "WRONG GLOBAL RESULT",
    status: "complete",
  });
  event("other-session", "message.complete", {
    text: "WRONG SESSION RESULT",
    status: "complete",
  });
  if (text.includes("HANG")) return;
  let answer;
  if (text.includes("CALL_TOOL")) {
    const result = await mcp.callTool({
      name: "edit_document",
      arguments: { text: "Shared Hermes editor" },
    });
    answer = JSON.stringify(result);
  } else if (text.includes("INTERACTION")) {
    const permission = await ask(id, "approval", {
      request_id: "approve-one",
      command: "test",
      choices: ["once", "deny"],
    });
    const response = await ask(id, "clarify", {
      questions: [
        { qid: "one", question: "Which color?" },
        { qid: "two", question: "Which size?" },
      ],
    });
    answer = JSON.stringify({ permission, response });
  } else answer = "Native Hermes response";
  const state = live.get(id);
  state.messages.push(text);
  await writeFile(file(state.stored_session_id), JSON.stringify(state));
  event(id, "message.delta", { text: answer });
  event(id, "message.complete", {
    text: answer,
    status: "complete",
    usage: { input: 42, output: 8 },
  });
}
async function handle(rpc) {
  if (!rpc.method) {
    pending.get(rpc.id)?.(rpc.result);
    pending.delete(rpc.id);
    return;
  }
  const { method, params: p = {}, id } = rpc;
  await appendFile(
    join(home, "methods.jsonl"),
    JSON.stringify({ method, params: p }) + "\n",
  );
  let result = {};
  try {
    if (["image.attach_bytes", "pdf.attach", "file.attach"].includes(method))
      result = {
        attached: true,
        path: "/fixture/image.png",
        pages: [{ path: "/fixture/page.png" }],
        ref_text: "@file:fixture",
      };
    else if (method === "image.detach") result = { detached: true };
    else if (method === "gateway.capabilities")
      result = { per_session_exclusive_submit: true };
    else if (method === "session.list")
      result = {
        sessions: (await readdir(home))
          .filter((n) => n.endsWith(".json"))
          .map((n) => ({ session_id: n.slice(0, -5) })),
      };
    else if (method === "config.set") {
      if (p.scope !== "session" || !live.has(p.session_id))
        throw new Error("settings must target a live native session");
      if (p.value === "reject-me") throw new Error("native_setting_rejected");
      result = { key: p.key, value: p.value };
      if (p.value.includes("confirm-me")) result.confirm_required = true;
      else live.get(p.session_id)[p.key] = p.value;
    } else if (method === "session.history")
      result = {
        messages: JSON.parse(
          await readFile(
            file(live.get(p.session_id).stored_session_id),
            "utf8",
          ),
        ).messages,
        count: 1,
      };
    else if (method === "session.branch" || method === "session.branch_whole") {
      const source = live.get(p.session_id);
      const stored_session_id = `stored-fork-${++next}`,
        session_id = `live-fork-${next}`;
      result = { ...source, stored_session_id, session_id };
      live.set(session_id, result);
      await writeFile(file(stored_session_id), JSON.stringify(result));
    } else if (method === "session.close") {
      live.delete(p.session_id);
      result = { closed: p.session_id };
    } else if (method === "session.delete") {
      await unlink(file(p.session_id));
      result = { deleted: p.session_id };
    } else if (method === "mcp.servers.list") {
      result = {
        servers: mcpConfig ? [{ name: "agent-host", source: "config" }] : [],
      };
    } else if (method === "mcp.servers.remove") {
      if (!mcpConfig) throw new Error("server not found");
      mcpConfig = undefined;
      result = { ok: true };
    } else if (method === "mcp.servers.add") {
      mcpConfig = p.config;
      result = { ok: true };
    } else if (method === "reload.mcp") {
      await mcp?.close();
      mcp = new Client({ name: "hermes-fixture", version: "1" });
      transport = new StdioClientTransport({
        ...mcpConfig,
        env: { ...process.env, ...mcpConfig.env },
      });
      await mcp.connect(transport);
      result = { status: "reloaded" };
    } else if (method === "session.create") {
      const stored_session_id = "stored-" + p.idempotency_key.slice(0, 12),
        session_id = "live-" + process.pid + "-" + live.size;
      result = { session_id, stored_session_id, messages: [] };
      live.set(session_id, result);
      await writeFile(file(stored_session_id), JSON.stringify(result));
    } else if (method === "session.resume") {
      const state = JSON.parse(await readFile(file(p.session_id), "utf8"));
      const session_id = "resumed-" + process.pid + "-" + live.size;
      result = {
        ...state,
        session_id,
        session_key: p.session_id,
        resumed: p.session_id,
      };
      live.set(session_id, { ...result, stored_session_id: p.session_id });
      delete result.stored_session_id;
    } else if (method === "prompt.submit") {
      result = { status: "streaming" };
      send({ id, result });
      void turn(p.session_id, p.text).catch((error) =>
        event(p.session_id, "error", { message: String(error) }),
      );
      return;
    } else if (method === "session.interrupt") {
      result = { status: "interrupted" };
      if (process.env.IGNORE_INTERRUPT !== "1")
        event(p.session_id, "message.complete", {
          text: "",
          status: "interrupted",
        });
    } else if (method === "session.compress") {
      const state = live.get(p.session_id);
      if (process.env.HERMES_TEST_ROTATE === "1") {
        state.stored_session_id += "-compressed";
        await writeFile(file(state.stored_session_id), JSON.stringify(state));
      }
      result =
        p.focus_topic === "pending"
          ? { status: "pending" }
          : ["noop", "aborted", "refused_would_grow"].includes(p.focus_topic)
            ? { status: "compressed", summary: { [p.focus_topic]: true } }
            : {
                status: "compressed",
                before_tokens: 100,
                after_tokens: 20,
                info: { stored_session_id: state.stored_session_id },
              };
    } else if (method === "session.steer")
      result = { status: "queued", text: p.text };
    else throw new Error("unknown method " + method);
    send({ id, result });
  } catch (error) {
    send({ id, error: { code: -32000, message: String(error) } });
  }
}
for await (const line of createInterface({ input: process.stdin }))
  void handle(JSON.parse(line));
await mcp?.close();
