import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

// An ACP protocol fixture, not evidence of a model-backed native run.
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const text = (sessionId, value, extra = {}) =>
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
    ...extra,
  });
const config = [
  {
    id: "model",
    category: "model",
    type: "select",
    currentValue: "fixture/model",
    options: [{ value: "fixture/model", name: "Fixture" }],
  },
];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (process.env.ACP_V2_LOG)
    appendFileSync(
      process.env.ACP_V2_LOG,
      JSON.stringify({ method, params }) + "\n",
    );
  const reply = (result) => send({ id, result });
  const sessionId = params?.sessionId ?? "native-v2";
  if (method === "initialize")
    reply({
      protocolVersion: 1,
      agentInfo: { name: "OpenCode", version: process.env.ACP_V2_VERSION ?? "2.0.29" },
      authMethods: [{ id: "opencode-login", name: "Login" }],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: {
          resume: {},
          list: {},
          fork: {},
          delete: {},
          additionalDirectories: {},
        },
        _meta: { "opencode/child-session-updates": true },
      },
    });
  else if (["session/new", "session/resume", "session/load"].includes(method)) {
    if (method === "session/load") text(sessionId, "historical answer");
    // The adapter must retain native setup updates even before the lifecycle reply.
    update(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "compact", description: "Compact" },
        { name: "review", description: "Review" },
      ],
    });
    reply({
      ...(method === "session/new" ? { sessionId } : {}),
      configOptions: config,
    });
  } else if (method === "session/list")
    reply({
      sessions: [
        {
          sessionId: "native-v2",
          cwd: params.cwd,
          additionalDirectories: ["/shared/granted"],
        },
      ],
    });
  else if (method === "session/fork") reply({ sessionId: "native-fork" });
  else if (method === "session/delete") reply({});
  else if (method === "fixture/ping") reply({});
  else if (method === "fixture/order") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "fixture/notice", params: {} }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id, result: {} }) +
        "\n",
    );
  } else if (method === "fixture/config-change") {
    update(sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: [
        ...config,
        {
          id: "thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ],
    });
    reply({});
  } else if (method === "session/set_config_option") reply({});
  else if (method === "session/prompt") {
    const input = params.prompt
      .filter((block) => !block.annotations?.audience?.includes("assistant"))
      .map((block) => block.text ?? "")
      .join("\n");
    if (input === "/compact") {
      const behavior = process.env.ACP_V2_RECEIPT ?? "completed";
      if (behavior !== "missing") {
        update(sessionId, {
          sessionUpdate: "compaction_update",
          compactionId: "compact-root",
          status: "in_progress",
        });
        update(sessionId, {
          sessionUpdate: "compaction_update",
          compactionId:
            behavior === "foreign" ? "compact-other" : "compact-root",
          status: behavior === "failed" ? "failed" : "completed",
        });
      }
      reply({ stopReason: "end_turn" });
    } else {
      text(sessionId, "legacy child", {
        _meta: {
          "opencode/child-session": {
            id: "child",
            parentID: sessionId,
            depth: 1,
          },
        },
      });
      send({
        method: "opencode/session/child_update",
        params: {
          rootSessionId: sessionId,
          childSessionId: "child",
          parentSessionId: sessionId,
          depth: 1,
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child response" },
          },
        },
      });
      text(sessionId, input);
      reply({
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
      });
    }
  } else if (id !== undefined)
    send({ id, error: { code: -32601, message: method } });
}
