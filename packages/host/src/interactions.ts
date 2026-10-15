import type { InteractionContext } from "./agent.js";
import type { JsonObject, JsonValue } from "./types.js";

export interface NativeRequest {
  method: string;
  params?: JsonValue;
}
export interface InteractionChoice {
  id: string;
  label: string;
  scope?: "once" | "turn" | "session" | "always";
  allows?: boolean;
}
export interface Question {
  id: string;
  title: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  secret?: boolean;
}
/** Original request is always available; unknown forms never become an approval. */
export interface Interaction {
  kind: "approval" | "questions" | "form" | "url" | "native";
  title: string;
  choices?: InteractionChoice[];
  questions?: Question[];
  schema?: JsonObject;
  permissions?: JsonObject;
  url?: string;
  native: NativeRequest;
}
export type InteractionAnswer =
  | { choice: string }
  | { answers: Record<string, string | string[]> }
  | { action: "accept"; content?: JsonObject }
  | { action: "decline" | "cancel" }
  | { native: JsonValue };
export type InteractionHandler = (
  request: Interaction,
  context: InteractionContext,
) => Promise<InteractionAnswer>;

const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const rows = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const approval = (
  native: NativeRequest,
  title: string,
  choices: InteractionChoice[],
): Interaction => ({ kind: "approval", title, choices, native });
const choice = (
  id: string,
  label: string,
  allows: boolean,
  scope?: InteractionChoice["scope"],
): InteractionChoice => ({ id, label, allows, ...(scope ? { scope } : {}) });

export function describeInteraction(native: NativeRequest): Interaction {
  const p = object(native.params),
    method = native.method;
  if (
    method === "mcpServer/elicitation/request" &&
    object(p._meta).codex_approval_kind === "mcp_tool_call"
  ) {
    const persist = object(p._meta).persist;
    const scopes = Array.isArray(persist) ? persist : [persist];
    return approval(native, string(p.message, "Allow MCP tool?"), [
      choice("accept", "Allow once", true, "once"),
      ...(scopes.includes("session")
        ? [choice("session", "Allow for session", true, "session")]
        : []),
      ...(scopes.includes("always")
        ? [choice("always", "Always allow", true, "always")]
        : []),
      choice("decline", "Deny", false),
      choice("cancel", "Cancel", false),
    ]);
  }
  if (
    ["session/request_permission", "session/requestPermission"].includes(method)
  )
    return approval(
      native,
      string(object(p.toolCall).title, "Allow tool?"),
      rows(p.options).map((o) =>
        choice(
          string(o.optionId),
          string(o.name, string(o.optionId)),
          String(o.kind).startsWith("allow"),
          String(o.kind).endsWith("always") ? "always" : "once",
        ),
      ),
    );
  if (method === "item/permissions/requestApproval")
    return {
      ...approval(native, string(p.reason, "Grant requested permissions?"), [
        choice("turn", "Allow for this turn", true, "turn"),
        choice("session", "Allow for session", true, "session"),
        choice("deny", "Deny", false),
      ]),
      permissions: object(p.permissions),
    };
  if (method === "permission" || method === "pi/toolApproval")
    return approval(native, string(p.title, string(p.name, "Allow tool?")), [
      choice("allow", "Allow once", true, "once"),
      choice("deny", "Deny", false),
    ]);
  if (method === "approval")
    return approval(
      native,
      string(p.command, string(p.tool, "Allow operation?")),
      [
        choice("once", "Allow once", true, "once"),
        choice("session", "Allow for session", true, "session"),
        choice("always", "Always allow", true, "always"),
        choice("deny", "Deny", false),
      ].filter((c) => !Array.isArray(p.choices) || p.choices.includes(c.id)),
    );
  if (method === "exec.approval.requested") {
    const request = object(p.request);
    return approval(
      native,
      string(request.command, "Allow command?"),
      [
        choice("allow-once", "Allow once", true, "once"),
        choice("allow-always", "Always allow", true, "always"),
        choice("deny", "Deny", false),
      ].filter(
        (c) =>
          (!Array.isArray(request.allowedDecisions) ||
            request.allowedDecisions.includes(c.id)) &&
          (!Array.isArray(request.unavailableDecisions) ||
            !request.unavailableDecisions.includes(c.id)),
      ),
    );
  }
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(method)
  ) {
    // Complex native decisions (rule amendments, network policy) remain explicit native replies.
    const allowed = Array.isArray(p.availableDecisions)
      ? p.availableDecisions
      : ["accept", "acceptForSession", "decline", "cancel"];
    return approval(
      native,
      string(p.command, string(p.reason, "Allow operation?")),
      [
        choice("accept", "Allow once", true, "once"),
        choice("acceptForSession", "Allow for session", true, "session"),
        choice("decline", "Deny", false),
        choice("cancel", "Cancel", false),
      ].filter((c) => allowed.includes(c.id)),
    );
  }
  if (
    ["item/tool/requestUserInput", "AskUserQuestion", "clarify"].includes(
      method,
    )
  ) {
    const source = method === "AskUserQuestion" ? object(p.input) : p;
    let questions = rows(source.questions);
    if (!questions.length && typeof source.question === "string")
      questions = [source];
    return {
      kind: "questions",
      title: "Answer questions",
      native,
      questions: questions.map((q, i) => ({
        id: string(
          q.id,
          string(
            q.qid,
            method === "AskUserQuestion"
              ? string(q.question, String(i))
              : String(i),
          ),
        ),
        title: string(q.question, string(q.prompt, string(q.header))),
        options: Array.isArray(q.options)
          ? q.options.map((o) =>
              typeof o === "string"
                ? { label: o }
                : {
                    label: string(object(o).label),
                    description: string(object(o).description),
                  },
            )
          : undefined,
        multiple: q.multiSelect === true || q.multiple === true,
        secret: q.isSecret === true,
      })),
    };
  }
  if (
    method === "elicitation/create" ||
    method === "mcpServer/elicitation/request"
  ) {
    const url = string(p.url);
    return {
      kind: url ? "url" : "form",
      title: string(p.message, "Additional information requested"),
      native,
      ...(url ? { url } : { schema: object(p.requestedSchema) }),
    };
  }
  return { kind: "native", title: method, native };
}

/** Convert only representable decisions; the adapter/native engine remains the permission authority. */
export function answerInteraction(
  interaction: Interaction,
  answer: InteractionAnswer,
): JsonValue {
  if ("native" in answer) return answer.native;
  const { method } = interaction.native,
    p = object(interaction.native.params);
  const cancel = "action" in answer && answer.action !== "accept";
  if (interaction.kind === "approval") {
    const selected =
      "choice" in answer
        ? interaction.choices?.find((c) => c.id === answer.choice)
        : undefined;
    if (!selected && !cancel) throw new Error("invalid_interaction_choice");
    if (method === "mcpServer/elicitation/request")
      return {
        action: selected?.allows
          ? "accept"
          : (selected?.id ?? ("action" in answer ? answer.action : "cancel")),
        ...(selected?.scope === "session" || selected?.scope === "always"
          ? { _meta: { persist: selected.scope } }
          : {}),
      };
    if (method === "item/permissions/requestApproval")
      return {
        permissions: selected?.allows ? object(p.permissions) : {},
        scope: selected?.id === "session" ? "session" : "turn",
      };
    if (method.startsWith("session/"))
      return selected
        ? { outcome: { outcome: "selected", optionId: selected.id } }
        : { outcome: { outcome: "cancelled" } };
    if (method === "permission")
      return {
        behavior: selected?.allows ? "allow" : "deny",
        ...(selected?.allows
          ? { updatedInput: object(p.input) }
          : { message: "Declined by user" }),
      };
    if (method === "pi/toolApproval")
      return selected?.allows ? {} : { block: "Declined by user" };
    if (method === "approval") return { choice: selected?.id ?? "deny" };
    if (method === "exec.approval.requested")
      return { decision: selected?.id ?? "deny" };
    return { decision: selected?.id ?? "cancel" };
  }
  if (interaction.kind === "questions") {
    if (cancel)
      return method === "AskUserQuestion"
        ? { behavior: "deny", message: "Questions cancelled" }
        : { answers: {} };
    if (!("answers" in answer)) throw new Error("interaction_answers_required");
    for (const q of interaction.questions ?? [])
      if (!(q.id in answer.answers)) throw new Error(`missing_answer:${q.id}`);
    if (method === "item/tool/requestUserInput")
      return {
        answers: Object.fromEntries(
          Object.entries(answer.answers).map(([id, a]) => [
            id,
            { answers: Array.isArray(a) ? a : [a] },
          ]),
        ),
      };
    const answers = Object.fromEntries(
      Object.entries(answer.answers).map(([id, a]) => [
        id,
        Array.isArray(a) ? a.join(", ") : a,
      ]),
    );
    if (method === "AskUserQuestion")
      return {
        behavior: "allow",
        updatedInput: { ...object(p.input), answers },
      };
    return { answers };
  }
  if (["form", "url"].includes(interaction.kind)) {
    if (!("action" in answer)) throw new Error("interaction_action_required");
    return answer.action === "accept"
      ? {
          action: "accept",
          ...(answer.content ? { content: answer.content } : {}),
        }
      : { action: answer.action };
  }
  if (cancel) return null;
  throw new Error("native_interaction_reply_required");
}

export async function routeInteraction<C extends InteractionContext>(
  handlers: {
    onInteraction?: InteractionHandler;
    onRequest?: (request: any, context: C) => Promise<JsonValue | undefined>;
  },
  native: NativeRequest,
  context: C,
): Promise<JsonValue | undefined> {
  context.signal.throwIfAborted();
  if (!handlers.onInteraction) return handlers.onRequest?.(native, context);
  const interaction = describeInteraction(native);
  if (interaction.kind === "native" && handlers.onRequest)
    return handlers.onRequest(native, context);
  const answer = await handlers.onInteraction(interaction, context);
  context.signal.throwIfAborted();
  return answerInteraction(interaction, answer);
}
