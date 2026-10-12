import type { AgentEvent } from "./agent.js";
import type { JsonObject, JsonValue } from "./types.js";

export type ProgressEvent =
  | { type: "reasoning.delta"; runId: string; text: string }
  | {
      type: "usage";
      runId: string;
      scope: "turn" | "session" | "response" | "native";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
      native: JsonValue;
    }
  | {
      type: "native.tool";
      runId: string;
      phase: "started" | "updated" | "finished";
      callId?: string;
      tool?: string;
      native: JsonValue;
    };
const obj = (v: unknown): JsonObject =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};

/** Add projections without consuming, rewriting or hiding the original native event. */
export function projectProgress(event: AgentEvent): AgentEvent[] {
  if (event.type !== "native.notification") return [event];
  const { method } = event.notification,
    p = obj(event.notification.params);
  const output: AgentEvent[] = [event];
  const reason = (v: unknown) => {
    if (typeof v === "string" && v)
      output.push({ type: "reasoning.delta", runId: event.runId, text: v });
  };
  const usage = (
    native: JsonObject,
    scope: "turn" | "session" | "response" | "native",
    names: Record<string, string>,
  ) => {
    const counts: Record<string, number> = {};
    for (const [name, key] of Object.entries(names))
      if (typeof native[key] === "number" && Number.isFinite(native[key]))
        counts[name] = native[key] as number;
    output.push({
      type: "usage",
      runId: event.runId,
      scope,
      native,
      ...counts,
    });
  };
  const tool = (
    native: JsonObject,
    phase: "started" | "updated" | "finished",
  ) =>
    output.push({
      type: "native.tool",
      runId: event.runId,
      phase,
      callId: [
        native.id,
        native.toolCallId,
        native.tool_use_id,
        native.tool_id,
      ].find((value): value is string => typeof value === "string"),
      tool: [native.name, native.toolName, native.tool_name, native.tool].find(
        (value): value is string => typeof value === "string",
      ),
      native,
    });
  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  )
    reason(p.delta);
  if (method === "thread/tokenUsage/updated")
    usage(obj(obj(p.tokenUsage).total), "session", {
      inputTokens: "inputTokens",
      outputTokens: "outputTokens",
      cachedInputTokens: "cachedInputTokens",
      reasoningTokens: "reasoningOutputTokens",
    });
  if (["item/started", "item/completed"].includes(method)) {
    const item = obj(p.item);
    if (
      [
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "webSearch",
        "dynamicToolCall",
      ].includes(String(item.type))
    )
      tool(item, method.endsWith("started") ? "started" : "finished");
  }
  if (method === "claude.message") {
    const delta = obj(obj(p.event).delta);
    if (delta.type === "thinking_delta") reason(delta.thinking);
    if (p.type === "result")
      usage({ ...obj(p.usage), cost: p.total_cost_usd }, "native", {
        inputTokens: "input_tokens",
        outputTokens: "output_tokens",
        cachedInputTokens: "cache_read_input_tokens",
        costUsd: "cost",
      });
    if (p.type === "tool_progress") tool(p, "updated");
    const content = obj(p.message).content;
    if (Array.isArray(content))
      for (const item of content) {
        const block = obj(item);
        if (p.type === "assistant" && block.type === "tool_use")
          tool(block, "started");
        if (p.type === "user" && block.type === "tool_result")
          tool(block, "finished");
      }
  }
  if (method.startsWith("pi/")) {
    const native = obj(p.event);
    if (
      [
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
      ].includes(String(native.type))
    )
      tool(
        native,
        native.type === "tool_execution_start"
          ? "started"
          : native.type === "tool_execution_end"
            ? "finished"
            : "updated",
      );
    if (native.type === "message_update" && Array.isArray(native.changes))
      for (const change of native.changes)
        if (obj(change).type === "thinking_delta") reason(obj(change).delta);
    if (native.type === "message_end") {
      const model = obj(native.entry).model;
      if (Array.isArray(model))
        for (const message of model)
          if (obj(message).role === "assistant")
            usage(obj(obj(message).usage), "response", {
              inputTokens: "input",
              outputTokens: "output",
              cachedInputTokens: "cacheRead",
            });
    }
  }
  if (method === "session/update") {
    const update = obj(p.update);
    if (update.sessionUpdate === "agent_thought_chunk")
      reason(obj(update.content).text);
    if (update.sessionUpdate === "usage_update")
      usage(update, "native", {
        inputTokens: "inputTokens",
        outputTokens: "outputTokens",
      });
    if (
      ["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))
    )
      tool(
        { ...update, id: update.toolCallId, name: update.title },
        ["completed", "failed"].includes(String(update.status))
          ? "finished"
          : update.sessionUpdate === "tool_call"
            ? "started"
            : "updated",
      );
  }
  if (method === "event") {
    const payload = obj(p.payload);
    if (p.type === "reasoning.delta") reason(payload.text);
    if (p.type === "usage" || p.type === "message.complete") {
      const u = obj(payload.usage);
      if (Object.keys(u).length)
        usage(u, "native", {
          inputTokens:
            typeof u.input_tokens === "number" ? "input_tokens" : "input",
          outputTokens:
            typeof u.output_tokens === "number" ? "output_tokens" : "output",
        });
    }
    if (["tool.start", "tool.result", "tool.complete"].includes(String(p.type)))
      tool(payload, p.type === "tool.start" ? "started" : "finished");
  }
  if (method === "agent") {
    const data = obj(p.data);
    if (p.stream === "reasoning") reason(data.delta);
    if (p.stream === "tool")
      tool(
        data,
        data.phase === "start"
          ? "started"
          : data.phase === "result"
            ? "finished"
            : "updated",
      );
    if (p.stream === "usage")
      usage(data, "native", {
        inputTokens: "input",
        outputTokens: "output",
        cachedInputTokens: "cacheRead",
      });
  }
  return output;
}
