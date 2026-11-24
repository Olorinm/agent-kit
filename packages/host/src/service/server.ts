import { unknownCapabilities } from "../capabilities.js";
import { fingerprintJson } from "../codex/session.js";
import { CodexRequestFailure } from "../codex/client.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ProductTool, TurnOutcome } from "../agent.js";
import { CallBroker } from "./calls.js";
import { TaskStore } from "./store.js";
import {
  HostError,
  idSchema,
  startRunSchema,
  attachmentSchema,
  toolSchema,
  type RunRecord,
  type StartRun,
  type RuntimeDescription,
} from "./protocol.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  saveRunAttachment,
} from "./files.js";
import type { ServiceRuntime } from "./runtime.js";
import { connectHostLink, type HostLinkOptions } from "./link.js";

export interface HostServerOptions {
  runtimes: ServiceRuntime[];
  stateDirectory: string;
  token: string;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  eventLimit?: number;
  durableEventLimit?: number;
  interactionTimeoutMs?: number;
  /** Product tools callable by native session ID within a trusted local sandbox. Disabled by default. */
  sessionRelayTools?: string[];
  /** Trusted local file access is opt-in, separate from native Agent permissions. */
  workspaceFiles?: boolean;
  /** Keep an outbound connection to a Router that may exchange messages with one runtime (see docs/host-link.md). */
  link?: HostLinkOptions;
}
interface Call { method: string; url: string; body(limit?: number): Promise<unknown> }
interface Answer { status: number; value: unknown }
const answer = (status: number, value: unknown): Answer => ({ status, value });
/** What a host link may ask for: health, its runtime's description, and runs with their events and calls. */
function linkAllows(method: string | undefined, path: string[]): boolean {
  const [, area, second, third, , last] = path;
  if (method === "GET")
    return (path.length === 2 && (area === "health" || area === "runtimes")) ||
      (area === "runs" && (path.length === 3 || (path.length === 4 && (third === "events" || third === "calls"))));
  if (method !== "POST") return false;
  if (area === "runtimes") return path.length === 3 && second === "inspect";
  return area === "runs" && (path.length === 2 || (path.length === 4 && (third === "cancel" || third === "steer")) ||
    (path.length === 6 && third === "calls" && last === "result"));
}
/** A linked submission is a message for the linked runtime: it defines no instructions, tools, native items or files. */
function linkStart(value: unknown, runtimeId: string): unknown {
  const input = z.record(z.string(), z.unknown()).parse(value);
  for (const field of ["instructions", "tools", "toolOutput", "inputItems", "attachments"]) {
    const supplied = input[field];
    if (supplied !== undefined && supplied !== "" && !(Array.isArray(supplied) && !supplied.length))
      throw new HostError(403, `link_field_not_allowed:${field}`);
  }
  if (input.runtimeId !== runtimeId) throw new HostError(403, "link_runtime_not_allowed");
  if (input.context !== undefined && JSON.stringify(input.context).length > 4_000)
    throw new HostError(413, "link_context_too_large");
  return input;
}
interface ActiveRun {
  record: RunRecord;
  runtime: ServiceRuntime;
  controller: AbortController;
  broker: CallBroker;
  done: Promise<void>;
  sessionId: string;
  tools: ProductTool[];
  /** Shell commands of this run that are executing now, keyed `threadId:itemId`, with their turn. */
  commands: Map<string, string>;
  nativeSessionId?: string;
  relayed: number;
}
const relayFields = { threadId: z.string().min(1).max(200), tool: z.string().min(1).max(200), input: z.json() };
const relaySchema = z.union([
  z.object({ ...relayFields, callId: z.string().min(1).max(200) }).strict(),
  z.object({ ...relayFields, kernel: idSchema }).strict(),
]);
/** Tracks Codex commandExecution items so a relay request can be tied to the command that sent it. */
function trackCommand(commands: Map<string, string>, event: { type: string; [key: string]: unknown }) {
  if (event.type !== "native.notification") return;
  const notification = event.notification as { method?: string; params?: Record<string, unknown> };
  const params = notification.params ?? {}, item = params.item as { id?: unknown; type?: unknown } | undefined;
  if (item?.type !== "commandExecution" || typeof item.id !== "string") return;
  const thread = typeof params.threadId === "string" ? params.threadId : String(event.threadId ?? "");
  const turn = typeof params.turnId === "string" ? params.turnId : String(event.turnId ?? "");
  if (notification.method === "item/started") commands.set(`${thread}:${item.id}`, turn);
  if (notification.method === "item/completed") commands.delete(`${thread}:${item.id}`);
}

export async function startAgentHostServer(options: HostServerOptions) {
  if (!options.token || options.token.length < 16)
    throw new Error("host_token_must_be_at_least_16_characters");
  const runtimes = new Map<string, ServiceRuntime>();
  for (const runtime of options.runtimes) {
    idSchema.parse(runtime.id);
    if (!runtime.configurationKey || runtimes.has(runtime.id))
      throw new Error("invalid_runtime_configuration");
    runtimes.set(runtime.id, runtime);
  }
  const interactionTimeoutMs = options.interactionTimeoutMs ?? 1_800_000;
  if (!Number.isInteger(interactionTimeoutMs) || interactionTimeoutMs < 1 || interactionTimeoutMs > 86_400_000)
    throw new Error("invalid_interaction_timeout");
  if (options.link && !runtimes.has(options.link.runtimeId)) throw new Error("link_runtime_not_found");
  const store = new TaskStore(
    join(resolve(options.stateDirectory), "tasks.sqlite"),
    options.eventLimit,
    options.durableEventLimit,
  );
  const active = new Map<string, ActiveRun>();
  const managing = new Set<string>();
  let closing = false;
  let persistenceFailed = false;
  let closed: Promise<void> | undefined;
  const getRuntime = (id: string) => {
    const runtime = runtimes.get(id);
    if (!runtime) throw new HostError(404, "runtime_not_found");
    return runtime;
  };
  const getRun = (id: string) => {
    const run = store.run(id);
    if (!run) throw new HostError(404, "run_not_found");
    return run;
  };
  const describe = async (
    runtime: ServiceRuntime,
  ): Promise<RuntimeDescription> => {
    const capabilities = structuredClone(
      runtime.capabilities ?? unknownCapabilities(runtime.kernel, "http"),
    );
    capabilities.kernel = runtime.kernel;
    capabilities.mode = "http";
    if (!runtime.inputs?.attachments)
      capabilities.features["input.attachments"] = {
        status: "unsupported",
        reason: "host_not_integrated",
        details: "This runtime has not enabled attachment delivery.",
      };
    else if (!runtime.capabilities)
      capabilities.features["input.attachments"] = {
        status: "supported",
        details: "The custom runtime explicitly accepts workspace attachments.",
      };
    if (!runtime.capabilities && runtime.inputs)
      capabilities.features["input.images"] =
        runtime.inputs.images === "native"
          ? { status: "supported" }
          : runtime.inputs.images === "negotiated"
            ? {
                status: "conditional",
                reason: "native_negotiation_required",
              }
            : {
                status: "unsupported",
                reason: "host_not_integrated",
                details:
                  "Image bytes are available as workspace files, without native image-block delivery.",
              };
    // `input.nativeItems` is the gate of `inputItems` and of a standalone `toolOutput` turn (see `start`).
    for (const [name, enabled] of [
      ["controls.steer", Boolean(runtime.steer)],
      ["controls.compact", Boolean(runtime.supportsCompaction)],
      ["input.nativeItems", Boolean(runtime.inputItems)],
    ] as const) {
      if (!enabled)
        capabilities.features[name] = {
          status: "unsupported",
          reason: "host_not_integrated",
        };
      else if (capabilities.features[name].status === "unknown")
        capabilities.features[name] = { status: "supported" };
    }
    return {
      id: runtime.id,
      kernel: runtime.kernel,
      cwd: runtime.cwd,
      model: runtime.model,
      capabilities,
      allowedSettings: runtime.allowedSettings,
      controls: {
        steer: Boolean(runtime.steer),
        compact: Boolean(runtime.supportsCompaction),
      },
      ...(runtime.inputs ? { inputs: runtime.inputs } : {}),
      ...((await runtime.inspect?.()) ?? { available: true }),
    };
  };

  /** Runs one product tool of the active run on behalf of a shell command that is executing in it. */
  async function relay(input: z.infer<typeof relaySchema>, peer: string | undefined) {
    const legacy = "callId" in input;
    const kernel = legacy ? "codex" : input.kernel;
    const bySession = options.sessionRelayTools?.includes(input.tool) === true;
    const key = legacy ? `${input.threadId}:${input.callId}` : "";
    let task: ActiveRun | undefined;
    if (bySession) {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? ""))
        throw new HostError(403, "relay_requires_local_session");
      const matches = [...active.values()].filter(candidate =>
        candidate.runtime.kernel === kernel && candidate.nativeSessionId !== undefined &&
        (kernel === "pi" ? `${candidate.runtime.id}:${candidate.nativeSessionId}` : candidate.nativeSessionId) === input.threadId);
      if (matches.length !== 1 || matches[0]!.controller.signal.aborted)
        throw new HostError(403, "relay_session_not_running");
      task = matches[0]!;
    } else {
      if (!legacy) throw new HostError(403, "session_relay_not_enabled");
      const find = () => [...active.values()].find(candidate => candidate.commands.has(key));
      task = find();
      // Codex may spawn the command before the Host receives its item/started notification.
      for (let waited = 0; !task && waited < 5_000; waited += 50) {
        await new Promise(resolve => setTimeout(resolve, 50));
        task = find();
      }
      if (!task || task.controller.signal.aborted) throw new HostError(403, "relay_command_not_running");
    }
    const tool = task.tools.find((candidate) => candidate.name === input.tool && !candidate.namespace);
    if (!tool?.execute) throw new HostError(404, "relay_tool_not_available");
    if (task.relayed >= 200) throw new HostError(429, "relay_limit");
    const source = !bySession && legacy ? input.callId : task.record.id;
    const callId = `relay:${source}:${++task.relayed}`;
    const threadId = task.nativeSessionId ?? input.threadId;
    const context = { sessionId: task.sessionId, runId: task.record.id, threadId,
      turnId: task.commands.get(key) ?? "", signal: task.controller.signal, callId };
    store.append(task.record, { type: "tool.started", runId: task.record.id, threadId, turnId: context.turnId,
      callId, tool: tool.name, input: input.input });
    const result = await tool.execute(input.input, context);
    store.append(task.record, { type: "tool.finished", runId: task.record.id, threadId, turnId: context.turnId,
      callId, tool: tool.name, result });
    return { result };
  }

  async function execute(task: ActiveRun, input: StartRun) {
    const { record, runtime, controller, broker } = task;
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    const timeout = setTimeout(
      () => controller.abort(new Error("run_deadline_exceeded")),
      input.timeoutMs,
    );
    timeout.unref();
    let enteredRuntime = false;
    try {
      const attachments = input.attachments.map((item) => ({
        ...item,
        path: saveRunAttachment(runtime.cwd, input.sessionId, item),
      }));
      enteredRuntime = true;
      for await (const event of runtime.run({
        sessionId: input.sessionId,
        runId: record.id,
        input: input.input,
        inputItems: input.inputItems,
        toolOutput: input.toolOutput,
        attachments,
        settings: input.settings,
        mode: input.mode,
        instructions: input.instructions,
        context:
          typeof input.context === "string"
            ? input.context
            : input.context
              ? JSON.stringify(input.context)
              : undefined,
        tools: task.tools,
        signal: controller.signal,
        onRequest: (request, context) => broker.interaction(request, context),
      })) {
        if (event.runId !== record.id)
          throw new Error("runtime_event_run_mismatch");
        if (event.type === "session.bound" && typeof event.threadId === "string") task.nativeSessionId = event.threadId;
        trackCommand(task.commands, event as unknown as { type: string });
        if (event.type === "turn.finished") {
          outcome = event.outcome;
          continue;
        }
        if (event.type === "model.response") {
          record.answer = event.text;
          record.outputAvailable = true;
        }
        store.append(record, event);
      }
    } catch (error) {
      outcome = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        outcomeUnknown: enteredRuntime,
      };
    } finally {
      clearTimeout(timeout);
      broker.close();
      try {
        store.finish(record, outcome);
      } finally {
        active.delete(record.id);
      }
    }
  }

  async function start(input: StartRun, linked = false): Promise<RunRecord> {
    const runtime = getRuntime(input.runtimeId);
    const submissionHash = fingerprintJson(input);
    const priorSubmission = () => {
      const prior = input.requestKey ? store.submission(input.runtimeId, input.requestKey) : undefined;
      if (prior && prior.hash !== submissionHash) throw new HostError(409, "request_key_conflict");
      return prior?.run;
    };
    const prior = priorSubmission();
    if (prior) return prior;
    if (input.settings && Object.keys(input.settings).length) {
      if (!runtime.validateSettings)
        throw new HostError(409, "runtime_settings_unsupported");
      try {
        runtime.validateSettings(input.settings);
      } catch (error) {
        throw new HostError(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const inspected = await describe(runtime);
    const concurrent = priorSubmission();
    if (concurrent) return concurrent;
    if (!inspected.available)
      throw new HostError(409, inspected.reason ?? "runtime_unavailable");
    if (closing) throw new HostError(503, "host_closing");
    if (persistenceFailed) throw new HostError(503, "host_storage_failed");
    if (input.mode === "compact" && !runtime.supportsCompaction)
      throw new HostError(409, "compaction_unsupported");
    if (input.attachments.length && !runtime.inputs?.attachments)
      throw new HostError(409, "attachments_unsupported");
    if (input.mode === "compact" && input.attachments.length)
      throw new HostError(400, "compaction_attachments_unsupported");
    if (input.inputItems?.length && !runtime.inputItems) throw new HostError(409, "native_input_items_unsupported");
    if (input.toolOutput && !runtime.inputItems) throw new HostError(409, "native_tool_output_unsupported");
    if (input.mode === "compact" && input.inputItems?.length) throw new HostError(400, "compaction_input_items_unsupported");
    if (
      [...active.values()].some(
        (item) => item.record.sessionId === input.sessionId,
      )
    )
      throw new HostError(409, "session_busy");
    if (
      [...active.values()].filter((item) => item.runtime === runtime).length >=
      (runtime.maxConcurrentRuns ?? 16)
    )
      throw new HostError(409, "runtime_busy");
    if (managing.has(input.sessionId)) throw new HostError(409, "session_busy");
    const previous = store.session(input.sessionId);
    if (previous?.nativeDeletedAt)
      throw new HostError(409, "native_session_deleted");
    const definition = {
      runtimeId: input.runtimeId,
      instructions: input.instructions,
      tools: input.tools,
      configurationKey: runtime.configurationKey,
      // A session the link started is continued only through the link, and a local session never through it.
      ...(linked ? { origin: "link" as const } : {}),
    };
    if (previous) {
      const { id: _id, createdAt: _createdAt, ...existing } = previous;
      if (!isDeepStrictEqual(existing, definition))
        throw new HostError(409, "session_configuration_conflict");
    }
    const record: RunRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      createdAt: new Date().toISOString(),
      status: "running",
      answer: "",
      outputAvailable: false,
      sequence: 0,
    };
    store.createRun(record, previous ?? { ...definition, id: input.sessionId, createdAt: record.createdAt },
      input.requestKey ? { key: input.requestKey, hash: submissionHash } : undefined);
    const controller = new AbortController();
    const broker = new CallBroker(
      store,
      record.id,
      controller.signal,
      interactionTimeoutMs,
    );
    const task: ActiveRun = {
      record,
      runtime,
      controller,
      broker,
      done: Promise.resolve(),
      sessionId: input.sessionId,
      tools: broker.tools(input.tools),
      commands: new Map(),
      relayed: 0,
    };
    active.set(record.id, task);
    task.done = Promise.resolve().then(() => execute(task, input));
    // A storage failure must remain visible, never an unhandled background rejection.
    void task.done.catch((error: unknown) => {
      persistenceFailed = true;
      console.error("Agent Host task persistence failed:", error);
      controller.abort(error);
      for (const running of active.values()) running.controller.abort(error);
    });
    return { ...record };
  }

  const failure = (error: unknown): Answer => ({
    status:
      error instanceof HostError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : (error as NodeJS.ErrnoException)?.code === "ENOENT"
            ? 404
            : 500,
    value: {
      error:
        error instanceof z.ZodError
          ? "invalid_request"
          : error instanceof Error
            ? error.message
            : "host_error",
      ...(error instanceof CodexRequestFailure ? { nativeError: { kind: error.kind, method: error.method, code: error.code, data: error.data } } : {}),
    },
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const failed = failure(error);
      reply(response, failed.status, failed.value);
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    if (origin) {
      if (!options.allowedOrigins?.includes(origin))
        throw new HostError(403, "origin_not_allowed");
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader(
          "access-control-allow-headers",
          "authorization, content-type",
        );
        response.setHeader(
          "access-control-allow-methods",
          "GET, POST, OPTIONS",
        );
        response.writeHead(204).end();
        return;
      }
    }
    // Relay requests use an active native command receipt or an explicitly enabled local session binding.
    if (request.method === "POST" && (request.url ?? "").split("?")[0] === "/v1/relay")
      return reply(response, 200, await relay(relaySchema.parse(await body(request, 1_000_000)), request.socket.remoteAddress));
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HostError(401, "unauthorized");
    const { status, value } = await route({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      body: (limit) => body(request, limit),
    });
    reply(response, status, value);
  }
  /**
   * The v1 operations, apart from transport: the HTTP listener calls this for the owner, the host link for a
   * Router that may only exchange messages with one runtime (`linked`).
   */
  async function route(call: Call, linked?: string): Promise<Answer> {
    if (closing) throw new HostError(503, "host_closing");
    if (persistenceFailed) throw new HostError(503, "host_storage_failed");
    const url = new URL(call.url, "http://agent-host.local");
    const path = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = call.method;
    if (path[0] !== "v1") throw new HostError(404, "route_not_found");
    if (linked && !linkAllows(method, path)) throw new HostError(403, "link_route_not_allowed");
    /** A link reaches its one runtime only. */
    const visible = (runtimeId: string) => {
      if (linked && runtimeId !== linked) throw new HostError(403, "link_runtime_not_allowed");
      return getRuntime(runtimeId);
    };
    /** The local working directory is not part of what a link is told. */
    const outline = async (runtime: ServiceRuntime) => {
      const { cwd, ...description } = await describe(runtime);
      return linked ? description : { ...description, cwd };
    };
    if (method === "GET" && path.join("/") === "v1/runs/by-request") {
      const runtimeId = idSchema.parse(url.searchParams.get("runtimeId"));
      visible(runtimeId);
      const requestKey = z.string().min(1).max(500).parse(url.searchParams.get("requestKey"));
      return answer(200, { run: store.submission(runtimeId, requestKey)?.run ?? null });
    }
    if (method === "POST" && path.join("/") === "v1/runtimes/native") {
      const input = z.object({ runtimeId: idSchema, method: z.string().min(1).max(250), params: z.json().optional(), notification: z.boolean().optional() }).strict().parse(await call.body());
      const native = getRuntime(input.runtimeId).native;
      if (!native) throw new HostError(403, "native_access_not_enabled");
      if (input.notification) { await native.notify(input.method, input.params); return answer(200, {}); }
      return answer(200, { result: (await native.request(input.method, input.params)) ?? null });
    }
    if (path[1] === "runtimes" && path[2] && path[3]?.startsWith("native-")) {
      const native = getRuntime(path[2]).native;
      if (!native) throw new HostError(403, "native_access_not_enabled");
      if (!native.attached) await native.ready();
      if (method === "GET" && path.length === 4 && path[3] === "native-events")
        return answer(200, native.events(Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 200), url.searchParams.get("epoch") ?? undefined));
      if (method === "GET" && path.length === 4 && path[3] === "native-requests")
        return answer(200, { requests: native.requests(), epoch: native.epoch });
      if (method === "POST" && path.length === 6 && path[3] === "native-requests" && path[5] === "result") {
        const input = z.object({ result: z.json().optional(), error: z.object({ code: z.number().optional(), message: z.string(), data: z.json().optional() }).strict().optional() }).strict().parse(await call.body());
        native.resolve(path[4]!, input); return answer(200, {});
      }
      throw new HostError(404, "route_not_found");
    }
    if (method === "GET" && path.length === 2 && path[1] === "health")
      return answer(200, { ok: true, protocolVersion: 1,
        capabilities: linked ? { runIdempotency: true } : { runIdempotency: true, nativeSessionManagement: true, nativeRpc: true, inputItems: true } });
    if (method === "GET" && path.length === 2 && path[1] === "runtimes")
      return answer(200, {
        runtimes: await Promise.all([...runtimes.values()].filter((runtime) => !linked || runtime.id === linked).map(outline)),
      });
    if (method === "POST" && path.join("/") === "v1/runtimes/inspect") {
      const input = z
        .object({ runtimeId: idSchema })
        .strict()
        .parse(await call.body());
      return answer(200, await outline(visible(input.runtimeId)));
    }
    if (method === "POST" && path.join("/") === "v1/runtimes/discover") {
      const input = z
        .object({ runtimeId: idSchema })
        .strict()
        .parse(await call.body());
      const runtime = getRuntime(input.runtimeId);
      const discovered = await runtime.discover?.();
      return answer(200, {
        ...(await describe(runtime)),
        ...discovered,
        discovery: discovered ? "native" : "static",
      });
    }
    if (method === "POST" && path.join("/") === "v1/native-sessions") {
      const input = z
        .object({
          runtimeId: idSchema,
          action: z.enum(["list", "bindings", "read", "history", "items", "fork", "delete", "rename", "archive", "unarchive", "adopt"]),
          sessionId: idSchema.optional(),
          targetSessionId: idSchema.optional(),
          nativeSessionId: z.string().min(1).max(1000).optional(),
          instructions: z.string().max(200_000).optional(),
          tools: z.array(toolSchema).max(100).optional(),
          entryId: z.string().max(1000).optional(),
          beforeEntryId: z.string().max(1000).optional(),
          name: z.string().min(1).max(1000).optional(),
          turnId: z.string().max(1000).optional(),
          sortDirection: z.enum(["asc", "desc"]).optional(),
          itemsView: z.enum(["notLoaded", "summary", "full"]).optional(),
          archived: z.boolean().optional(),
          searchTerm: z.string().max(1000).optional(),
          sourceKinds: z.array(z.string()).max(100).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          cursor: z.string().max(10000).optional(),
        })
        .strict()
        .parse(await call.body());
      const runtime = getRuntime(input.runtimeId),
        manager = runtime.sessions;
      if (!manager) throw new HostError(409, "native_sessions_unsupported");
      const query = {
        cwd: runtime.cwd,
        limit: input.limit,
        cursor: input.cursor,
        turnId: input.turnId, sortDirection: input.sortDirection, itemsView: input.itemsView,
        archived: input.archived, searchTerm: input.searchTerm, sourceKinds: input.sourceKinds,
        signal: AbortSignal.timeout(60_000),
      };
      if (input.action === "list")
        return answer(200, await manager.list(query));
      if (input.action === "bindings")
        return answer(200, { bindings: await manager.bindings() });
      if (!input.sessionId) throw new HostError(400, "session_id_required");
      if (input.action === "adopt") {
        if (!runtime.adopt || !input.nativeSessionId) throw new HostError(409, "native_session_adopt_unavailable");
        if (store.session(input.sessionId) || managing.has(input.sessionId)) throw new HostError(409, "target_session_exists");
        managing.add(input.sessionId);
        try {
          const result = await runtime.adopt(input.sessionId, input.nativeSessionId, input.instructions ?? "", input.tools ?? []);
          store.saveSession({ id: input.sessionId, runtimeId: runtime.id, instructions: input.instructions ?? "", tools: input.tools ?? [], configurationKey: runtime.configurationKey, createdAt: new Date().toISOString() });
          return answer(200, result);
        } finally { managing.delete(input.sessionId); }
      }
      const session = store.session(input.sessionId);
      if (!session || session.runtimeId !== runtime.id)
        throw new HostError(404, "session_not_found");
      if (session.nativeDeletedAt)
        throw new HostError(409, "native_session_deleted");
      if (session.configurationKey !== runtime.configurationKey)
        throw new HostError(409, "session_configuration_conflict");
      if (manager.supportsConcurrentReads) {
        if (input.action === "read") return answer(200, await manager.read(input.sessionId, query));
        if (input.action === "history") return answer(200, await manager.history(input.sessionId, query));
        if (input.action === "items") return answer(200, await manager.items(input.sessionId, query));
      }
      const ids = [
        input.sessionId,
        ...(input.targetSessionId ? [input.targetSessionId] : []),
      ];
      if (
        ids.some(
          (id) =>
            managing.has(id) ||
            ([...active.values()].some((r) => r.record.sessionId === id) &&
              !(input.action === "fork" && manager.supportsConcurrentForks && id === input.sessionId)),
        )
      )
        throw new HostError(409, "session_busy");
      if (
        input.action === "fork" &&
        (!input.targetSessionId || store.session(input.targetSessionId))
      )
        throw new HostError(409, "fork_target_required_or_exists");
      ids.forEach((id) => managing.add(id));
      try {
        if (input.action === "read") return answer(200, await manager.read(input.sessionId, query));
        if (input.action === "items") return answer(200, await manager.items(input.sessionId, query));
        if (input.action === "rename") {
          if (!input.name) throw new HostError(400, "session_name_required");
          await manager.rename(input.sessionId, input.name); return answer(200, {});
        }
        if (input.action === "archive" || input.action === "unarchive") {
          await manager.archive(input.sessionId, input.action === "archive"); return answer(200, {});
        }
        if (input.action === "history")
          return answer(200,
            await manager.history(input.sessionId, query),
          );
        if (input.action === "fork") {
          const fork = await manager.fork(
            input.sessionId,
            input.targetSessionId!,
            { ...query, entryId: input.entryId, beforeEntryId: input.beforeEntryId },
          );
          store.saveSession({
            ...session,
            id: input.targetSessionId!,
            createdAt: new Date().toISOString(),
          });
          return answer(200, fork);
        }
        const deleted = await manager.delete(input.sessionId, query);
        store.saveSession({
          ...session,
          nativeDeletedAt: new Date().toISOString(),
        });
        return answer(200, deleted);
      } finally {
        ids.forEach((id) => managing.delete(id));
      }
    }
    if (method === "GET" && path.length === 2 && path[1] === "sessions")
      return answer(200, { sessions: store.sessions() });
    if (path[1] === "runs" && path.length === 2) {
      if (method === "POST")
        return answer(202,
          await start(startRunSchema.parse(linked ? linkStart(await call.body(44_000_000), linked) : await call.body(44_000_000)), Boolean(linked)),
        );
      if (method === "GET")
        return answer(200, {
          runs: store.runs(url.searchParams.get("sessionId") ?? undefined),
        });
    }
    if (path[1] === "runs" && path[2]) {
      const run = getRun(idSchema.parse(path[2]));
      if (linked && run.runtimeId !== linked) throw new HostError(404, "run_not_found");
      if (method === "GET" && path.length === 3)
        return answer(200, run);
      if (path.length === 4 && path[3] === "events" && method === "GET") {
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .max(run.sequence)
          .parse(url.searchParams.get("after") ?? 0);
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(1_000)
          .parse(url.searchParams.get("limit") ?? 200);
        return answer(200, store.events(run, after, limit));
      }
      if (path.length === 4 && path[3] === "cancel" && method === "POST") {
        const task = active.get(run.id);
        task?.controller.abort(new Error("run_cancelled"));
        return answer(200, { cancellationRequested: Boolean(task) });
      }
      if (path.length === 4 && path[3] === "steer" && method === "POST") {
        const { input } = z
          .object({ input: z.string().min(1).max(100_000) })
          .strict()
          .parse(await call.body());
        const task = active.get(run.id);
        if (!task) throw new HostError(409, "run_not_active");
        if (!task.runtime.steer)
          throw new HostError(409, "steering_unsupported");
        await task.runtime.steer(run.sessionId, input);
        return answer(200, { ok: true });
      }
      if (path.length === 4 && path[3] === "calls" && method === "GET")
        return answer(200, { calls: store.calls(run.id) });
      if (
        path.length === 6 &&
        path[3] === "calls" &&
        path[5] === "result" &&
        method === "POST"
      ) {
        const { result } = z
          .object({ result: z.json() })
          .strict()
          .parse(await call.body(44_000_000));
        const broker =
          active.get(run.id)?.broker ??
          new CallBroker(store, run.id, AbortSignal.abort(), 0);
        broker.resolve(idSchema.parse(path[4]), result);
        return answer(200, { ok: true });
      }
    }
    if (
      options.workspaceFiles &&
      path[1] === "sessions" &&
      path[2] &&
      path[3] === "files" &&
      path.length === 4
    ) {
      const session = store.session(idSchema.parse(path[2]));
      if (!session) throw new HostError(404, "session_not_found");
      const root = getRuntime(session.runtimeId).cwd;
      if (method === "GET") {
        const file = url.searchParams.get("path") ?? "";
        return answer(200,
          url.searchParams.get("list") === "true"
            ? { entries: listWorkspaceFiles(root, file) }
            : readWorkspaceFile(
                root,
                file,
                z
                  .enum(["utf8", "base64"])
                  .parse(url.searchParams.get("encoding") ?? "utf8"),
              ),
        );
      }
      if (method === "POST") {
        const input = z
          .object({
            path: z.string().min(1),
            content: z.string().max(42_000_000),
            encoding: z.enum(["utf8", "base64"]).default("utf8"),
            expectedRevision: z.string().nullable().optional(),
          })
          .strict()
          .parse(await call.body(44_000_000));
        if (input.encoding === "base64")
          attachmentSchema.shape.data.parse(input.content);
        return answer(200,
          writeWorkspaceFile(
            root,
            input.path,
            input.content,
            input.expectedRevision,
            input.encoding,
          ),
        );
      }
    }
    throw new HostError(404, "route_not_found");
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    await Promise.allSettled(
      options.runtimes.map((runtime) => runtime.close()),
    );
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("host_address_unavailable");
  const link = options.link && connectHostLink(options.link, async ({ method, path, body }) => {
    try {
      const { status, value } = await route({ method, url: path,
        body: async () => { if (body === undefined) throw new HostError(415, "json_required"); return body; } }, options.link!.runtimeId);
      return { status, body: value };
    } catch (error) {
      const failed = failure(error);
      return { status: failed.status, body: failed.value };
    }
  });
  const addressHost = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return {
    url: `http://${addressHost}:${address.port}`,
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      link?.close();
      closed = (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        for (const task of active.values())
          task.controller.abort(new Error("host_shutdown"));
        const closingRuntimes = Promise.allSettled(
          options.runtimes.map((runtime) => runtime.close()),
        );
        await Promise.allSettled([...active.values()].map((task) => task.done));
        const results = await closingRuntimes;
        store.close();
        await stopped;
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
      return closed;
    },
  };
}

function reply(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
async function body(
  request: IncomingMessage,
  limit = 2_000_000,
): Promise<unknown> {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HostError(415, "json_required");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > limit) throw new HostError(413, "request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
