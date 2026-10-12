import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  listSessions as listNativeSessions,
  getSessionMessages,
  forkSession as forkNativeSession,
  deleteSession as deleteNativeSession,
} from "@anthropic-ai/claude-agent-sdk";
import { SessionManager, sessionPage } from "../sessions.js";
import { projectProgress } from "../progress.js";
import { routeInteraction, type InteractionHandler } from "../interactions.js";
import { mcpToolResult } from "../image-content.js";
import { createHash, randomUUID } from "node:crypto";
import {
  query as nativeQuery,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncEventQueue } from "../async-event-queue.js";
import {
  MemoryBindingStore,
  type AgentEvent,
  type BindingStore,
  type InteractionContext,
  type ProductTool,
  type TurnOutcome,
} from "../agent.js";
import type { JsonObject, JsonValue } from "../types.js";
import { ClaudeQueryHost, type ClaudeQueryFunction } from "./query.js";
import { userMessage } from "./query.js";
import { createClaudeMcpServer } from "./schema.js";

export interface ClaudeRunRequest {
  onInteraction?: InteractionHandler;
  sessionId: string;
  runId?: string;
  cwd: string;
  instructions: string;
  context?: string;
  input: string;
  mode?: "turn" | "compact";
  /** Native message blocks, including document input. */
  content?: SDKUserMessage["message"]["content"];
  images?: Array<{ mediaType: string; data: string }>;
  tools?: ProductTool[];
  signal?: AbortSignal;
  model?: string;
  /** Native SDK options, including hooks, effort, MCP, budget and settings. */
  native?: Options;
  bindings?: BindingStore;
  bindingFingerprint?: string;
  onRequest?(
    request: { method: string; params: JsonObject },
    context: InteractionContext,
  ): Promise<JsonValue | undefined>;
}
export interface ClaudeAgentOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  bindings?: BindingStore;
  query?: ClaudeQueryFunction;
  cancellationGraceMs?: number;
  native?: Options;
}

export class ClaudeAgent {
  private readonly host: ClaudeQueryHost;
  private readonly bindings: BindingStore;
  private readonly active = new Map<string, AbortController>();
  private readonly inputs = new Map<
    string,
    { sessionId: string; queue: AsyncEventQueue<SDKUserMessage> }
  >();
  async steer(sessionId: string, input: string) {
    const active = this.inputs.get(sessionId);
    if (!active) throw new Error("run_not_found");
    active.queue.push({
      ...userMessage(input, active.sessionId),
      uuid: randomUUID(),
      priority: "now",
    });
  }
  async discover(cwd: string): Promise<JsonObject> {
    const input = new AsyncEventQueue<SDKUserMessage>();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const query = (this.options.query ?? nativeQuery)({
      prompt: input,
      options: {
        ...this.options.native,
        cwd,
        env: {
          ...process.env,
          ...this.options.env,
          ...this.options.native?.env,
        },
        pathToClaudeCodeExecutable:
          this.options.command ??
          this.options.native?.pathToClaudeCodeExecutable,
        abortController: controller,
      },
    });
    try {
      const initialized = object(await query.initializationResult());
      return object(
        json({
          commands: initialized.commands ?? [],
          models: initialized.models ?? [],
          accountConfigured: Boolean(initialized.account),
        }),
      );
    } finally {
      clearTimeout(timeout);
      input.close();
      query.close();
    }
  }
  get sessions(): SessionManager {
    const sdkOptions = (cwd?: string) => ({
      dir: cwd,
      sessionStore: this.options.native?.sessionStore,
    });
    const env = {
      ...process.env,
      ...this.options.env,
      ...this.options.native?.env,
    };
    const isolated =
      !this.options.native?.sessionStore &&
      env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR;
    const offset = (cursor?: string) => {
      if (cursor !== undefined && !/^\d+$/.test(cursor))
        throw new Error("invalid_session_cursor");
      return cursor ? Number(cursor) : 0;
    };
    const page = async (
      action: "list" | "history",
      id: string | undefined,
      o: import("../sessions.js").SessionQuery,
    ) => {
      o.signal?.throwIfAborted();
      const from = offset(o.cursor),
        limit = o.limit ?? 100;
      const options = {
        ...sdkOptions(o.cwd),
        limit,
        offset: from,
        ...(action === "history" ? { includeSystemMessages: true } : {}),
      };
      const items = isolated
        ? await sdkSessionWorker(action, id, options, env, o.signal)
        : action === "list"
          ? await listNativeSessions(options)
          : await getSessionMessages(id!, options);
      return sessionPage(
        items,
        undefined,
        Array.isArray(items) && items.length === limit
          ? String(from + limit)
          : undefined,
      );
    };
    return (this.sessionManager ??= new SessionManager(
      this.bindings,
      (id) => this.active.has(id),
      {
        list: (o) => page("list", undefined, o),
        history: (id, o) => page("history", id, o),
        fork: async (id, o) => {
          const options = { ...sdkOptions(o.cwd), upToMessageId: o.entryId };
          const result = isolated
            ? await sdkSessionWorker("fork", id, options, env, o.signal)
            : await forkNativeSession(id, options);
          return String(object(result).sessionId ?? "");
        },
        delete: async (id, o) => {
          if (
            this.options.native?.sessionStore &&
            !this.options.native.sessionStore.delete
          )
            throw new Error("native_session_store_delete_unsupported");
          if (isolated)
            await sdkSessionWorker(
              "delete",
              id,
              sdkOptions(o.cwd),
              env,
              o.signal,
            );
          else await deleteNativeSession(id, sdkOptions(o.cwd));
        },
      },
    ));
  }
  private sessionManager?: SessionManager;
  constructor(private readonly options: ClaudeAgentOptions = {}) {
    this.host = new ClaudeQueryHost(options.query);
    this.bindings = options.bindings ?? new MemoryBindingStore();
  }
  async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    this.host.close();
  }
  async *run(request: ClaudeRunRequest): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const producer = this.execute(request, controller, queue).finally(() =>
      queue.close(),
    );
    try {
      for await (const event of queue) yield* projectProgress(event);
    } finally {
      controller.abort();
      request.signal?.removeEventListener("abort", abort);
      await producer;
    }
  }

  private async execute(
    request: ClaudeRunRequest,
    controller: AbortController,
    queue: AsyncEventQueue<AgentEvent>,
  ) {
    const runId = request.runId ?? randomUUID();
    const context: InteractionContext = {
      sessionId: request.sessionId,
      runId,
      threadId: "",
      turnId: "",
      signal: controller.signal,
    };
    const emit = (event: AgentEvent) => queue.push(event);
    emit({ type: "turn.started", runId });
    let text = "";
    let registered = false;
    let started = false;
    let resultSeen = false;
    let compacted = false;
    let inputQueue: AsyncEventQueue<SDKUserMessage> | undefined;
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    try {
      this.sessionManager?.assertIdle(request.sessionId);
      if (this.active.has(request.sessionId)) throw new Error("session_busy");
      this.active.set(request.sessionId, controller);
      registered = true;
      context.signal.throwIfAborted();
      const native = { ...this.options.native, ...request.native };
      const fingerprint =
        request.bindingFingerprint ??
        createHash("sha256")
          .update(
            JSON.stringify({
              cwd: request.cwd,
              instructions: request.instructions,
              tools: request.tools?.map(({ execute: _, ...spec }) => spec),
              env: this.options.env,
              command: this.options.command,
              settingSources: native.settingSources,
            }),
          )
          .digest("hex");
      const store = request.bindings ?? this.bindings;
      const binding = await store.get(request.sessionId);
      if (binding && binding.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      if (request.mode === "compact" && !binding)
        throw new Error("session_not_found");
      const sessionId = binding?.threadId ?? randomUUID();
      context.threadId = sessionId;
      let callSequence = 0;
      const toolNames = new Set(request.tools?.map((tool) => tool.name) ?? []);
      const mcp = request.tools?.length
        ? createClaudeMcpServer({
            name: "agent_host",
            version: "0.1.0",
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: object(tool.inputSchema),
            })),
            call: async (name, input) => {
              const tool = request.tools!.find((tool) => tool.name === name);
              if (!tool) throw new Error("tool_not_available");
              const callId = `${runId}:tool:${++callSequence}`;
              context.signal.throwIfAborted();
              if (!tool.execute) throw new Error("tool_not_available");
              emit({
                type: "tool.started",
                runId,
                callId,
                tool: tool.name,
                input: json(input),
              });
              const execution = await abortable(
                tool.execute(json(input), { ...context, callId }),
                context.signal,
              ).catch((error) => ({
                success: false,
                contentItems: [
                  { type: "inputText" as const, text: String(error) },
                ],
              }));
              const { result, content } = mcpToolResult(execution);
              emit({
                type: "tool.finished",
                runId,
                callId,
                tool: tool.name,
                result,
              });
              return {
                isError: !result.success,
                content,
              };
            },
          })
        : undefined;
      const nativePermission = native.canUseTool;
      const nativeElicitation = native.onElicitation;
      const options: Options = {
        ...native,
        cwd: request.cwd,
        env: { ...process.env, ...this.options.env, ...native.env },
        pathToClaudeCodeExecutable:
          this.options.command ?? native.pathToClaudeCodeExecutable,
        abortController: controller,
        includePartialMessages: true,
        includeHookEvents: true,
        supportedDialogKinds: native.supportedDialogKinds ?? [],
        settingSources: native.settingSources ?? ["user", "project", "local"],
        permissionMode: native.permissionMode ?? "default",
        model: request.model ?? native.model,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: request.instructions,
        },
        ...(binding
          ? { resume: sessionId, sessionId: undefined }
          : { sessionId, resume: undefined }),
        mcpServers: {
          ...native.mcpServers,
          ...(mcp ? { agent_host: mcp } : {}),
        },
        canUseTool: async (name, input, options) => {
          if (
            name.startsWith("mcp__agent_host__") &&
            toolNames.has(name.slice("mcp__agent_host__".length))
          )
            return { behavior: "allow", toolUseID: options.toolUseID };
          if (nativePermission)
            return await abortable(
              nativePermission(name, input, options),
              context.signal,
            );
          const answer = object(
            await abortable(
              routeInteraction(
                request,
                {
                  method:
                    name === "AskUserQuestion"
                      ? "AskUserQuestion"
                      : "permission",
                  params: object(
                    json({
                      name,
                      input,
                      toolUseID: options.toolUseID,
                      mcpServer: options.mcpServer,
                      defaultToNo: options.defaultToNo,
                      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
                    }),
                  ),
                },
                context,
              ),
              context.signal,
            ),
          );
          if (answer.behavior === "allow")
            return {
              behavior: "allow",
              toolUseID: options.toolUseID,
              updatedInput: object(answer.updatedInput ?? input),
            };
          return {
            behavior: "deny",
            toolUseID: options.toolUseID,
            message:
              typeof answer.message === "string"
                ? answer.message
                : "The product declined this operation.",
          };
        },
        onElicitation: async (elicitation, options) => {
          if (nativeElicitation)
            return await abortable(
              nativeElicitation(elicitation, options),
              context.signal,
            );
          const answer = object(
            await abortable(
              routeInteraction(
                request,
                {
                  method: "elicitation/create",
                  params: object(json(elicitation)),
                },
                context,
              ),
              context.signal,
            ),
          );
          if (answer.action !== "accept") return { action: "decline" };
          const content: Record<string, string | number | boolean | string[]> =
            {};
          for (const [key, value] of Object.entries(object(answer.content))) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              (Array.isArray(value) &&
                value.every((item) => typeof item === "string"))
            )
              content[key] = value as string | number | boolean | string[];
          }
          return { action: "accept", content };
        },
      };
      const prompt =
        request.mode === "compact"
          ? `/compact${request.input ? " " + request.input : ""}`
          : [request.context, request.input].filter(Boolean).join("\n\n");
      if (
        request.images?.some(
          (image) =>
            !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
              image.mediaType,
            ),
        )
      )
        throw new Error("claude_image_type_unsupported");
      inputQueue = new AsyncEventQueue<SDKUserMessage>();
      const initial = userMessage(prompt, sessionId);
      if (request.content && request.mode !== "compact")
        initial.message.content = Array.isArray(request.content)
          ? [{ type: "text", text: prompt }, ...request.content]
          : prompt + "\n" + request.content;
      else if (request.images?.length)
        initial.message.content = [
          { type: "text", text: prompt },
          ...request.images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mediaType as "image/png",
              data: image.data,
            },
          })),
        ];
      inputQueue.push(initial);
      context.signal.addEventListener("abort", () => inputQueue?.close(), {
        once: true,
      });
      if (request.mode !== "compact")
        this.inputs.set(request.sessionId, { sessionId, queue: inputQueue });
      started = true;
      for await (const message of this.host.stream({
        sessionId,
        prompt: inputQueue,
        afterMessage: async (message) => {
          if (
            message.type === "result" ||
            (message.type === "system" &&
              message.subtype === "compact_boundary")
          ) {
            this.inputs.delete(request.sessionId);
            inputQueue?.close();
          }
        },
        options:
          request.mode === "compact"
            ? { ...options, verbatimPrompts: false }
            : options,
        cancellationGraceMs: this.options.cancellationGraceMs,
      })) {
        if (message.type === "system" && message.subtype === "init") {
          if (message.session_id !== sessionId)
            throw new Error("native_session_id_mismatch");
          await store.set(request.sessionId, {
            threadId: sessionId,
            fingerprint,
          });
          emit({
            type: "session.bound",
            runId,
            threadId: sessionId,
            resumed: !!binding,
          });
        }
        emit({
          type: "native.notification",
          runId,
          threadId: sessionId,
          turnId: "",
          notification: { method: "claude.message", params: json(message) },
        });
        if (
          message.type === "stream_event" &&
          message.event.type === "content_block_delta" &&
          message.event.delta.type === "text_delta"
        ) {
          text += message.event.delta.text;
          emit({
            type: "assistant.delta",
            runId,
            text: message.event.delta.text,
          });
        }
        if (message.type === "system" && message.subtype === "compact_boundary")
          compacted = true;
        if (message.type === "result") {
          resultSeen = true;
          if (message.subtype === "success") text = message.result || text;
          outcome = message.is_error
            ? {
                status: "failed",
                error:
                  message.subtype === "success"
                    ? message.result
                    : message.errors.join("\n"),
              }
            : { status: "completed" };
        }
      }
      if (request.mode === "compact")
        outcome = compacted
          ? { status: "completed" }
          : {
              status: "failed",
              error: "compaction_not_confirmed",
              outcomeUnknown: true,
            };
    } catch (error) {
      outcome =
        context.signal.aborted && !started
          ? { status: "cancelled" }
          : {
              status: context.signal.aborted ? "cancelled" : "failed",
              error: error instanceof Error ? error.message : String(error),
              ...(started && !resultSeen ? { outcomeUnknown: true } : {}),
            };
    } finally {
      inputQueue?.close();
      if (registered) this.inputs.delete(request.sessionId);
      controller.abort();
      if (registered) this.active.delete(request.sessionId);
      emit({ type: "model.response", runId, text });
      emit({ type: "turn.finished", runId, outcome });
    }
  }
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function sdkSessionWorker(
  action: string,
  id: string | undefined,
  options: unknown,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./session-worker.js", import.meta.url))],
      { env, stdio: ["pipe", "pipe", "pipe"], signal },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 32_000_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      error = (error + String(chunk)).slice(-4000);
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) => {
      if (code !== 0)
        return reject(new Error(error || "native_session_helper_failed"));
      try {
        resolve(JSON.parse(output));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify({ action, id, options }));
  });
}
