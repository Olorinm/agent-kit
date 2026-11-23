// Protocol fixture shaped after `agy acp` of Antigravity CLI 1.5.15 (initialize, session/new, config options,
// permission requests). It contacts no model. Field names and error texts follow a recorded local handshake.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const skipPermissions = process.argv.includes("--dangerously-skip-permissions");
const efforts = {
  "gemini-4-neon": ["low", "medium", "high", "xhigh"],
  "gemini-3.8-flash": ["low", "medium", "high"],
};
const modes = ["default", "accept-edits", "auto", "plan"];
const sessions = new Map();
const requests = new Map();
let seq = 0;
const send = (value) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, message) => send({ id, error: { code: -32602, message } });
const request = (method, params) =>
  new Promise((resolve) => {
    // Antigravity numbers its own requests with string IDs.
    const id = String(++seq);
    requests.set(id, resolve);
    send({ id, method, params });
  });
const notify = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const select = (id, category, currentValue, values) => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const options = (state) => [
  select("model", "model", state.model, Object.keys(efforts)),
  select("thought_level", "thought_level", state.effort, efforts[state.model]),
  select("mode", "mode", state.mode, modes),
];
const permission = (sessionId, name, kind, title) =>
  request("session/request_permission", {
    sessionId,
    toolCall: {
      sessionUpdate: "tool_call",
      toolCallId: `call_${++seq}`,
      name,
      status: "pending",
      kind,
      title,
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
const allowed = (result) =>
  result?.outcome?.outcome === "selected" && result.outcome.optionId === "allow";

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  void handle(message).catch((error) =>
    send({ id: message.id, error: { code: -32603, message: String(error) } }),
  );
}
async function handle({ id, method, params, result }) {
  if (!method) return requests.get(id)?.(result);
  if (process.env.ACP_TEST_LOG)
    appendFileSync(
      process.env.ACP_TEST_LOG,
      `${JSON.stringify({ method, params, argv: process.argv.slice(2) })}\n`,
    );
  if (method === "initialize") {
    const sessionCapabilities = {
      resume: {},
      close: {},
      load: {},
      list: {},
      additionalDirectories: {},
    };
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        load_session: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities,
        session_capabilities: sessionCapabilities,
        auth: { logout: {} },
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      },
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
    });
  }
  if (method === "session/new" || method === "session/resume") {
    // The native server ignores `model` of session/new: a session starts on its own default.
    const sessionId = params.sessionId ?? `agy-session-${++seq}`;
    const state = sessions.get(sessionId) ?? {
      model: "gemini-4-neon",
      effort: "high",
      mode: "default",
    };
    sessions.set(sessionId, { ...state, mcpServers: params.mcpServers });
    return reply(id, {
      sessionId,
      models: {
        currentModelId: `${state.model}-${state.effort}`,
        availableModels: Object.entries(efforts).flatMap(([model, levels]) =>
          levels.map((level) => ({ modelId: `${model}-${level}`, name: `${model} (${level})` })),
        ),
      },
      modes: { currentModeId: state.mode, availableModes: modes.map((mode) => ({ id: mode, name: mode })) },
      configOptions: options(state),
    });
  }
  if (method === "session/list")
    return reply(id, {
      sessions: [...sessions.keys()].map((sessionId) => ({ sessionId })),
    });
  if (method === "session/set_config_option") {
    const state = sessions.get(params.sessionId);
    if (params.configId === "model") {
      // Both the base ID and the CLI's ID with a thinking level are accepted.
      const base = Object.keys(efforts).find(
        (model) => params.value === model || efforts[model].some((level) => params.value === `${model}-${level}`),
      );
      if (!base) return fail(id, `Unknown model ID: ${params.value}`);
      state.model = base;
      if (params.value !== base) state.effort = params.value.slice(base.length + 1);
      else if (!efforts[base].includes(state.effort)) state.effort = "high";
    } else if (params.configId === "thought_level") {
      if (!efforts[state.model].includes(params.value))
        return fail(id, `Thinking level "${params.value}" is not offered for model "${state.model}"`);
      state.effort = params.value;
    } else if (params.configId === "mode") {
      if (!modes.includes(params.value)) return fail(id, `Unknown mode: ${params.value}`);
      state.mode = params.value;
    } else return fail(id, `Unknown config option: ${params.configId}`);
    notify(params.sessionId, { sessionUpdate: "config_option_update", configOptions: options(state) });
    return reply(id, { configOptions: options(state) });
  }
  if (method === "session/cancel") return;
  if (method === "session/prompt") {
    const state = sessions.get(params.sessionId);
    const text = params.prompt.map((item) => item.text ?? "").join("\n");
    let answer = `model=${state.model} effort=${state.effort} mode=${state.mode}`;
    if (text.includes("command")) {
      // Shell commands: asked in default mode; auto mode and the skip flag run them.
      const asks = !skipPermissions && state.mode !== "auto";
      answer = !asks || allowed(await permission(params.sessionId, "run_command", "execute", "date > probe.txt"))
        ? "command ran"
        : "command refused";
    } else if (text.includes("tool")) {
      // Tools of a client MCP server are asked about in every mode; only the skip flag runs them unasked.
      const server = state.mcpServers[0];
      const client = new Client({ name: "fixture", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
        }),
      );
      try {
        const { tools } = await client.listTools();
        const name = `mcp_${server.name}_${tools[0].name}`;
        if (skipPermissions || allowed(await permission(params.sessionId, name, "other", `Run ${name}`)))
          answer = JSON.stringify(await client.callTool({ name: tools[0].name, arguments: { text: "Saved via ACP" } }));
        else answer = "tool refused";
      } finally {
        await client.close();
      }
    }
    notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
    return reply(id, {
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 12 },
    });
  }
  throw new Error(`unknown_method:${method}`);
}
