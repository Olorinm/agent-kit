import { SendMessageRequest } from "@a2a-js/sdk";
import { z } from "zod";
import { setTimeout as sleep } from "node:timers/promises";
import { notificationId, replyDeliveryId, type ChannelInput, type CommunicationCore, type OwnerRoute, type SendState } from "../communication/core.js";
import type { DurableStore } from "../communication/store.js";
import { ChannelHttpError } from "../http.js";
import type { HostAdmission, HostPort, HostRun, HostStartInput, NativeSessionInput } from "./host.js";
import { runtimeWorkingDirectory } from "./host.js";
import { DEFAULT_SETTINGS, type ExecutionSession, type RunBinding } from "./host-worker.js";
import { digest, key } from "./protocol.js";
import { CliWork, WorkError } from "./work.js";
import type { WorkInput, WorkSender } from "./delivery.js";
import { closeRequest, createRequest, displaySchema, displayTooLarge, expireRequests, ownerRequestSchema, requestCardId, requestDeliveryId,
  type OwnerRequestInput, type WorkDisplay } from "../ledger/requests.js";
import { AgentLedger, legacySession, type CardKind } from "../ledger/ledger.js";
import type { CardOrigin, CardView } from "../ledger/control.js";
import { personId } from "../ledger/registry.js";
import { WEB_CONNECTION } from "../ledger/surfaces.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
const settingsSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/), z.json())
  .refine(value => Object.keys(value).length <= 16 && Buffer.byteLength(JSON.stringify(value)) <= 4096, "settings_too_large");
const admissionSchema = z.object({ kind: z.enum(["owner", "delegation", "schedule"]), owner: z.string().min(1), agentId: z.string().min(1), reference: z.string().min(1),
  expiresAt: z.iso.datetime().optional(), maxToolCalls: z.number().int().min(0).max(1_000_000).optional(),
  toolGrants: z.object({ business: z.boolean().optional(), feishu: z.boolean().optional(),
    connectedApps: z.object({ connections: z.array(z.string().min(1)).max(100), operations: z.array(z.string().min(1)).max(1000).optional() }).strict().optional(),
  }).strict().optional(),
}).strict();
const replySchema = z.object({ connectionId: z.string().min(1).max(160).optional() }).strict();
const senderSchema = z.object({ kind: z.literal("agent"), id: identifier, name: z.string().trim().min(1).max(200) }).strict();
export interface WorkSessionSubmission {
  eventId: string; sessionId?: string | undefined; input: string; admission: HostAdmission;
  context?: unknown | undefined; inputItems?: Record<string, unknown>[] | undefined; settings?: Record<string, unknown> | undefined; mode?: "turn" | "compact" | undefined;
  /**
   * Answer the owner: the turn's answer, notices and cards go to the owner as a channel turn's do. Only for the owner
   * conversation (`openOwnerConversation`). `connectionId` follows the rule of `deliver`: omitted, the connection the owner
   * was last on; `web`, the transcript only; a notify connection, the transcript and a push; another connection, the
   * owner's conversation on it.
   */
  reply?: { connectionId?: string | undefined } | undefined;
  /**
   * Who the input is from when it is another agent's message. It is recorded as the sender of the input event and
   * told to the model with the source of the delivery. Only for delegated and scheduled work: the owner's own work
   * is the owner's.
   */
  sender?: WorkSender | undefined;
  /**
   * Whether Router states the provenance of a delivered input itself. The default notice says that no person wrote the
   * input and that it grants nothing; a product whose own text already says who sent it and where the answer goes sets
   * this to `false`, so the model reads one statement instead of two that can disagree. Only meaningful together with
   * `sender`, and only for a runtime that takes text rather than a native tool output.
   */
  notice?: boolean | undefined;
  /**
   * What to show for this input: a JSON object the product defines, at most 64,000 bytes serialized. For example the
   * message as its sender wrote it, when `input` is the text written for the model. It is recorded on the input event
   * and returned by the web chat API as the event's `display`. Router does not interpret it, and it never reaches the
   * model: it is no part of the input, the context, the admission or the Host request. Like every other member it
   * belongs to the submission, so the same `eventId` with another `display` is `work_event_id_reused`.
   */
  display?: WorkDisplay | undefined;
}
/**
 * Where a turn that answers the owner sends its answer, and what became of that send. `pending` until the answer is
 * recorded; `web`: recorded on the transcript, which is its delivery; `suppressed`: recorded only, because the owner
 * has no conversation on the named connection (`error`); otherwise the state of the send on `connectionId`.
 */
export interface WorkReplyReceipt { connectionId: string; state: "pending" | "web" | "suppressed" | SendState; externalId: string | null; error: string | null }
interface SessionMetadata { createdAt: string; title?: string; parentSessionId?: string; archived?: boolean; }
/** What a routed output reports about its route: the connection, whether that is a push, and why it is only recorded. */
interface RouteFacts { connectionId: string; push?: boolean; error?: string }
interface WorkEvent { eventId: string; sessionId: string; hash: string; taskId: string; reply?: RouteFacts; }
interface RequestRecord { hash: string; cardId: string; route: RouteFacts; expiresAt: string }
export type { OwnerRequestInput, WorkDisplay } from "../ledger/requests.js";
export type { WorkSender } from "./delivery.js";
/** An owner request as the product reads it (`WorkSessions.request`). */
export interface OwnerRequestResult {
  eventId: string; cardId: string; sessionId: string; expiresAt: string;
  /** `expired`: nobody answered before `expiresAt`, or the owner cleared the conversation. `withdrawn`: `withdrawRequest`. */
  status: "pending" | "answered" | "expired" | "withdrawn";
  /** The `id` of the chosen choice, when answered. */
  choice?: string;
  /** The person who answered, and where. */
  answeredBy?: string; surface?: "web" | "channel";
  settledAt?: string;
  /** Where the card was sent beside the transcript, and what became of that send. */
  delivery: WorkReplyReceipt;
}
/** One entry of `WorkSessions.settlements`: a work event whose turn ended, or an owner request that was closed. */
export type Settlement = { seq: number; settledAt: string } & ({ kind: "work"; event: WorkEventResult } | { kind: "request"; request: OwnerRequestResult });
/** A card of a work event's turn that waits for the owner: an approval or question its run asked. */
export interface WorkPendingCard {
  cardId: string;
  /** The web chat that shows the card and takes its answer: `dm:<agentId>` for the owner conversation, else `obs:<agentId>:<sessionId>`. */
  chatId: string;
  kind: CardKind; text: string; choices: Array<{ choiceId: string; label: string }>; deadlineAt: string | null;
  origin?: CardOrigin;
}
export interface WorkEventResult {
  eventId: string; taskId: string; sessionId: string; status: string; answer: string;
  runId?: string; error?: string; outcomeUnknown: boolean;
  /** Present while the turn waits for the owner to answer; the turn continues when every card is answered or closed. */
  pendingCards?: WorkPendingCard[];
  /** Present for a submission with `reply`. */
  reply?: WorkReplyReceipt;
}
const routeFacts = (route: OwnerRoute, requested: string | undefined): RouteFacts =>
  route.push ? { connectionId: route.push, push: true } : route.error ? { connectionId: requested ?? route.connectionId, error: route.error } : { connectionId: route.connectionId };
export interface WorkSessionWaitOptions {
  after?: string | undefined; timeoutMs?: number | undefined; signal?: AbortSignal | undefined;
  /** Trusted tool-execution context. Never accept these fields from model input. */
  waitingRunId?: string | undefined; waitingReference?: string | undefined; waitingCallId?: string | undefined;
}
export interface WorkDependencyWait {
  runId: string; reference: string; callId: string; taskIds: string[]; deadlineAt: number; reserve: boolean;
}

/** One agent's authenticated embedding boundary. Callers must authenticate the owner before
 * obtaining this object. Model text and channel ingress never have access to this port. */
export class WorkSessions {
  private channelForks: Promise<void> = Promise.resolve();
  constructor(readonly agentId: string, readonly owner: string, readonly runtimeId: string,
    readonly instanceId: string, readonly store: DurableStore, readonly work: CliWork,
    readonly host: HostPort, readonly communication: CommunicationCore,
    private readonly validate: () => void = () => {},
    private readonly dependencyWait?: (input: WorkDependencyWait) => () => void) {
    // A work event's turn ended: recorded with the task's terminal state, in the same transaction (`settlements`).
    work.settled = (task) => {
      const ledger = AgentLedger.open(this.store), inputId = ledger.inputForTurn(task.id);
      if (inputId?.startsWith("work:") && this.store.get("work_session_inputs", task.id)) ledger.settle("work", inputId.slice("work:".length));
    };
  }

  private async forward<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ChannelHttpError) {
        const native = error.nativeError as { code?: unknown } | undefined;
        if (native?.code === -32601) throw new WorkError("native_method_unsupported", 409, error.nativeError);
        if (native?.code === -32600 || native?.code === -32602) throw new WorkError("native_request_invalid", 400, error.nativeError);
        if ([400, 401, 403, 404, 409, 413, 422].includes(error.status)) throw new WorkError(error.code, error.status, error.nativeError);
        if (error.nativeError !== undefined) throw new WorkError("native_request_failed", 502, error.nativeError);
      }
      if (error instanceof WorkError) throw error;
      throw new WorkError("host_request_failed", 502);
    }
  }

  list() {
    this.validate();
    return this.store.entries<ExecutionSession>("execution_sessions").map(({ id }) => this.getSession(id));
  }
  getSession(sessionId: string) {
    this.validate(); identifier.parse(sessionId);
    const binding = this.store.get<ExecutionSession>("execution_sessions", sessionId);
    if (!binding) throw new WorkError("session_not_found", 404);
    const metadata = this.store.get<SessionMetadata>("work_sessions", sessionId);
    return { sessionId, runtimeId: binding.runtimeId, ...metadata,
      ownerConversation: Boolean(this.ownerInput(sessionId)),
      runs: this.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
        .filter(run => run.contextId === sessionId).map(run => ({ taskId: run.taskId, runId: run.runId ?? null, phase: run.phase, error: run.error ?? null })) };
  }
  private ownerInput(sessionId: string): ChannelInput | undefined { return this.ownerInputs(sessionId)[0]; }
  /** The session's owner messages that became turns, newest first. */
  private ownerInputs(sessionId: string): ChannelInput[] {
    return this.communication.sessionInputs(sessionId).filter(input => this.communication.isOwnerInput(input));
  }
  private get ownerSession(): string { return legacySession(this.agentId, "owner-main"); }
  private hostSession(contextId: string): string { return `h-${digest(key(this.agentId, this.instanceId, contextId)).slice(0, 40)}`; }
  /**
   * The agent's owner conversation: the one session every owner channel shares. It exists after this call even when
   * the owner has never written, as the session an owner message would have opened: the same ledger session (the
   * agent's writable chat in the web), the same Host session and so the same native thread, with the definition an
   * owner turn gives it. A later owner message continues it.
   */
  openOwnerConversation(): { sessionId: string } {
    this.validate();
    const sessionId = this.ownerSession, ledger = AgentLedger.open(this.store);
    ledger.atomic(() => {
      ledger.ensureSession(sessionId, "owner_main", "owner-main");
      // The session and its current window (a reset opens another context).
      for (const contextId of new Set([sessionId, ledger.contextFor(sessionId)])) {
        if (this.store.get("execution_sessions", contextId)) continue;
        this.store.set("execution_sessions", contextId, { sessionId: this.hostSession(contextId), runtimeId: this.runtimeId, channelTools: true } satisfies ExecutionSession);
        this.store.set("work_sessions", contextId, { createdAt: new Date().toISOString() } satisfies SessionMetadata);
      }
    });
    return { sessionId };
  }
  validateTarget(sessionId: string) {
    this.getSession(sessionId);
    if (!this.ownerInput(sessionId)) throw new WorkError("notification_requires_owner_conversation", 403);
    return { sessionId, ownerConversation: true as const };
  }
  private binding(sessionId: string) {
    this.getSession(sessionId);
    return this.store.get<ExecutionSession>("execution_sessions", sessionId)!;
  }
  private reserve(sessionId: string) {
    identifier.parse(sessionId);
    if (!this.store.get<ExecutionSession>("execution_sessions", sessionId)) {
      this.store.set("execution_sessions", sessionId, { sessionId: this.hostSession(sessionId), runtimeId: this.runtimeId } satisfies ExecutionSession);
      this.store.set("work_sessions", sessionId, { createdAt: new Date().toISOString() } satisfies SessionMetadata);
    }
    return this.binding(sessionId);
  }
  async submit(input: WorkSessionSubmission): Promise<WorkEventResult> {
    this.validate(); identifier.parse(input.eventId);
    admissionSchema.parse(input.admission);
    if (input.admission.agentId !== this.agentId || input.admission.owner !== this.owner || !input.admission.reference)
      throw new WorkError("work_admission_scope_mismatch", 403);
    const hash = digest(input), existing = this.store.get<WorkEvent>("work_session_events", input.eventId);
    if (existing) {
      if (existing.hash !== hash) throw new WorkError("work_event_id_reused", 409);
      return this.get(input.eventId);
    }
    if (input.admission.expiresAt && Date.parse(input.admission.expiresAt) <= Date.now()) throw new WorkError("work_admission_expired", 403);
    if (input.admission.kind === "schedule" && !input.admission.toolGrants) throw new WorkError("scheduled_work_grants_required", 403);
    if (Buffer.byteLength(input.input) > 24_000) throw new WorkError("work_input_too_large", 413);
    const sessionId = input.sessionId ?? `w-${digest(key(this.agentId, input.eventId)).slice(0, 40)}`;
    const reply = input.reply === undefined ? undefined : replySchema.parse(input.reply);
    const sender = input.sender === undefined ? undefined : senderSchema.parse(input.sender);
    if (sender && input.admission.kind === "owner") throw new WorkError("work_sender_admission_mismatch", 403);
    const display = input.display === undefined ? undefined : displaySchema.parse(input.display);
    if (display && displayTooLarge(display)) throw new WorkError("work_display_too_large", 413);
    if (reply) {
      if (sessionId !== this.ownerSession) throw new WorkError("reply_requires_owner_conversation", 403);
      if (input.mode === "compact") throw new WorkError("compaction_reply_unsupported", 400);
      if (reply.connectionId !== undefined && reply.connectionId !== WEB_CONNECTION && !this.communication.connected(reply.connectionId))
        throw new WorkError("delivery_connection_not_found", 404);
    }
    // Work in the owner conversation never opens it as anything else, whether or not the owner has written yet.
    if (sessionId === this.ownerSession) this.openOwnerConversation();
    // A ledger session that was reset (ADR 0005 16.3) runs new work in its current window's execution context.
    const contextId = AgentLedger.open(this.store).contextFor(sessionId);
    // Existing owner chats retain their native catalog, but this work has no channel reply route.
    // The execution handler denies channel tools without a separately admitted channel message.
    const priorBinding = this.store.get<ExecutionSession>("execution_sessions", contextId);
    if (priorBinding && priorBinding.channelTools === undefined && this.ownerInput(sessionId))
      this.store.set("execution_sessions", contextId, { ...priorBinding, channelTools: priorBinding.tools !== false });
    if (contextId !== sessionId && !this.store.get<ExecutionSession>("execution_sessions", contextId) && this.ownerInput(sessionId))
      this.store.set("execution_sessions", contextId, { sessionId: this.hostSession(contextId), runtimeId: this.runtimeId, channelTools: true } satisfies ExecutionSession);
    const binding = this.reserve(contextId);
    if (this.store.get<SessionMetadata>("work_sessions", sessionId)?.archived) throw new WorkError("session_archived", 409);
    // Frozen at submission, as a channel turn's reply route is frozen at receipt.
    const route = reply ? this.communication.ownerRoute(sessionId, reply.connectionId) : undefined;
    this.work.submit(SendMessageRequest.fromJSON({ message: {
      messageId: `work-event-${digest(key(this.agentId, input.eventId))}`, contextId,
      role: input.admission.kind === "owner" ? "ROLE_USER" : "ROLE_AGENT", parts: [{ text: input.input }],
    }, configuration: { returnImmediately: true } }), {
      sender: `product:${this.agentId}`, room: `work:${sessionId}`, approved: true,
    }, task => {
      this.store.set("work_session_inputs", task.id, { sessionId: binding.sessionId, runtimeId: binding.runtimeId,
        instructions: "", input: input.input, admission: input.admission,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.inputItems ? { inputItems: input.inputItems } : {}),
        ...(input.settings ? { settings: input.settings } : {}), ...(input.mode ? { mode: input.mode } : {}),
        ...(sender ? { sender } : {}),
        ...(input.notice === undefined ? {} : { notice: input.notice }),
      } satisfies WorkInput);
      this.store.set("work_session_events", input.eventId, { eventId: input.eventId, sessionId, taskId: task.id, hash,
        ...(route ? { reply: routeFacts(route, reply!.connectionId) } : {}) } satisfies WorkEvent);
      this.record({ ...input, sender, display }, sessionId, task.id, route);
    });
    return this.get(input.eventId);
  }
  /**
   * ADR 0005 6.7: the submitted input and its turn, in the target or a fresh work session, with the admission. With an
   * owner route (ADR 20.2) the input keeps it, and the turn answers along it. `display` is kept here only: on the event.
   */
  private record(input: WorkSessionSubmission, sessionId: string, taskId: string, route?: OwnerRoute) {
    const ledger = AgentLedger.open(this.store);
    ledger.atomic(() => {
      const kind = input.admission.kind === "owner" ? "work" : input.admission.kind;
      if (sessionId === this.ownerSession) ledger.ensureSession(sessionId, "owner_main", "owner-main");
      else ledger.ensureSession(sessionId, kind, `${kind}:${sessionId}`);
      const owner = input.admission.kind === "owner", sender = input.sender;
      const event = ledger.append(sessionId, { kind: "message", role: "user", senderType: owner ? "person" : sender ? "agent" : "system",
        senderId: owner ? personId(this.owner) : sender ? sender.id : input.admission.kind, idempotencyKey: `work:${input.eventId}`, turnId: taskId,
        ...(route?.conversationId ? { conversationId: route.conversationId } : {}),
        body: { text: input.input, origin: owner ? "work" : input.admission.kind, reference: input.admission.reference,
          ...(sender ? { sender: { kind: sender.kind, id: sender.id, name: sender.name } } : {}),
          ...(input.display ? { display: input.display } : {}) } }).event;
      ledger.queueInput(`work:${input.eventId}`, sessionId, event.eventId, undefined, route ? { route } : {});
      ledger.updateInput(`work:${input.eventId}`, "started", { turnId: taskId });
      ledger.ensureTurn({ turnId: taskId, sessionKey: sessionId, admission: kind, originEventId: event.eventId, originConversationId: route?.conversationId ?? null,
        replyRoute: route ? { connectionId: route.connectionId, target: route.target, messageId: route.messageId, data: route.data } : null });
      ledger.turnState(taskId, "queued", { agentId: this.agentId });
    });
  }
  /**
   * What became of routed output: `deliveryId` is its channel send, `ref` the reference of its push, and `recorded`
   * says its event is on the transcript.
   */
  private receipt(facts: RouteFacts, deliveryId: string, ref: string, recorded: boolean): WorkReplyReceipt {
    const none = { externalId: null, error: null };
    if (!recorded) return { connectionId: facts.connectionId, state: "pending", ...none };
    if (facts.error) return { connectionId: facts.connectionId, state: "suppressed", externalId: null, error: facts.error };
    // A push that was not queued (an empty or canceled answer) leaves the transcript as the delivery.
    const sent = this.communication.sent(facts.push ? notificationId(ref, facts.connectionId) : deliveryId);
    return sent ? { connectionId: facts.connectionId, ...sent } : { connectionId: facts.connectionId, state: "web", ...none };
  }
  lookup(eventId: string): WorkEventResult | null {
    this.validate();
    return this.store.get("work_session_events", eventId) ? this.get(eventId) : null;
  }
  get(eventId: string): WorkEventResult {
    this.validate();
    const event = this.store.get<WorkEvent>("work_session_events", eventId);
    if (!event) throw new WorkError("work_event_not_found", 404);
    const task = this.work.inspect(event.taskId), native = this.store.get<HostRun>("execution_results", event.taskId);
    const run = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value).reverse().find(value => value.taskId === event.taskId);
    const ledger = this.communication.ledger, chatId = ledger.session(event.sessionId)?.kind === "owner_main" ? `dm:${this.agentId}` : `obs:${this.agentId}:${event.sessionId}`;
    const pendingCards = ledger.openCards({ turnId: event.taskId }).filter(card => card.source !== "router" && !card.answerKey).map((card): WorkPendingCard => {
      const body = (ledger.event(card.eventId)?.body.card ?? {}) as Partial<CardView>;
      return { cardId: card.cardId, chatId, kind: card.kind, text: body.text ?? "", choices: (body.choices ?? []).map(({ choiceId, label }) => ({ choiceId, label })),
        deadlineAt: card.deadlineAt === null ? null : new Date(card.deadlineAt).toISOString(), ...(body.origin ? { origin: body.origin } : {}) };
    });
    return { eventId, taskId: event.taskId, sessionId: event.sessionId,
      status: run?.phase === "unknown" ? "unknown" : task.status === "canceled" ? "cancelled" : task.status,
      answer: native?.answer ?? "", ...(run?.runId ? { runId: run.runId } : {}),
      ...(run?.error ? { error: run.error } : native?.outcome?.error ? { error: native.outcome.error } : {}),
      outcomeUnknown: run?.phase === "unknown" || native?.outcome?.outcomeUnknown === true,
      ...(pendingCards.length ? { pendingCards } : {}),
      // The answer is recorded when the channel core has published the turn's result.
      ...(event.reply ? { reply: this.receipt(event.reply, replyDeliveryId(event.taskId), `turn:${event.taskId}`,
        Boolean(AgentLedger.open(this.store).turn(event.taskId)?.finalEventId)) } : {}) };
  }
  async cancel(eventId: string) { const event = this.get(eventId); await this.work.cancel(event.taskId); return this.get(eventId); }
  read(sessionId: string) { return this.native(sessionId, { action: "read" }); }
  history(sessionId: string, options: { cursor?: string; limit?: number; itemsView?: "notLoaded" | "summary" | "full"; sortDirection?: "asc" | "desc" } = {}) {
    return this.native(sessionId, { action: "history", ...options });
  }
  async steer(sessionId: string, input: string) {
    const binding = this.binding(sessionId);
    if (!this.host.steer) throw new WorkError("host_steer_unsupported", 409);
    const run = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
      .find(run => run.sessionId === binding.sessionId && run.phase === "running" && run.runId);
    if (!run?.runId) throw new WorkError("active_run_not_found", 404);
    await this.forward(() => this.host.steer!(run.runId!, input));
  }
  /** Wait on durable Router observations; it does not wake a Host or hold the worker's dispatch loop. */
  async wait(eventIds: string[], options: WorkSessionWaitOptions = {}) {
    if (!eventIds.length || eventIds.length > 8 || new Set(eventIds).size !== eventIds.length) throw new WorkError("invalid_wait_targets", 400);
    const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs ?? 30_000, 60_000));
    const first = eventIds.map(id => this.get(id));
    const contextual = options.waitingRunId !== undefined || options.waitingReference !== undefined || options.waitingCallId !== undefined;
    const after = options.after ?? (contextual ? digest(first) : undefined);
    const finished = (data: WorkEventResult[]) => contextual && data.every(value => value.outcomeUnknown || ["completed", "failed", "cancelled", "rejected", "unknown"].includes(value.status));
    let release: (() => void) | undefined;
    if (contextual) {
      if (!options.waitingRunId || !options.waitingReference || !options.waitingCallId) throw new WorkError("invalid_dependency_wait_context", 400);
      if (!this.dependencyWait) throw new WorkError("work_dependency_wait_unsupported", 409);
      release = this.dependencyWait({ runId: options.waitingRunId, reference: options.waitingReference, callId: options.waitingCallId,
        taskIds: first.map(value => value.taskId), deadlineAt: deadline, reserve: digest(first) === after && Date.now() < deadline && !finished(first) });
    }
    try {
      for (;;) {
        const data = eventIds.map(id => this.get(id)), cursor = digest(data);
        if (cursor !== after || Date.now() >= deadline || finished(data)) return { data, cursor };
        await sleep(Math.min(250, deadline - Date.now()), undefined, options.signal ? { signal: options.signal } : {});
      }
    } finally { release?.(); }
  }
  async native(sessionId: string, options: Omit<NativeSessionInput, "runtimeId" | "sessionId" | "targetSessionId" | "nativeSessionId">) {
    const binding = this.binding(sessionId);
    if (["list", "bindings", "adopt", "fork"].includes(options.action)) throw new WorkError("use_scoped_session_operation", 400);
    if (!this.host.nativeSessions) throw new WorkError("host_native_sessions_unsupported", 409);
    const result = await this.forward(() => this.host.nativeSessions!({ ...options, runtimeId: binding.runtimeId, sessionId: binding.sessionId }));
    if (["rename", "archive", "unarchive"].includes(options.action)) {
      const metadata = this.store.get<SessionMetadata>("work_sessions", sessionId) ?? { createdAt: new Date().toISOString() };
      this.store.set("work_sessions", sessionId, { ...metadata,
        ...(options.action === "rename" ? { title: options.name } : { archived: options.action === "archive" }) });
    }
    return result;
  }
  async fork(sessionId: string, targetSessionId: string, options: { entryId?: string | undefined; beforeEntryId?: string | undefined } = {}) {
    const binding = this.binding(sessionId); identifier.parse(targetSessionId);
    if (this.store.get("execution_sessions", targetSessionId)) throw new WorkError("target_session_exists", 409);
    if (!this.host.nativeSessions) throw new WorkError("host_native_sessions_unsupported", 409);
    const target = `h-${digest(key(this.agentId, this.instanceId, targetSessionId)).slice(0, 40)}`;
    const result = await this.forward(() => this.host.nativeSessions!({ action: "fork", runtimeId: binding.runtimeId, sessionId: binding.sessionId, targetSessionId: target, ...options }));
    this.store.transaction(() => {
      this.store.set("execution_sessions", targetSessionId, { ...binding, sessionId: target });
      this.store.set("work_sessions", targetSessionId, { createdAt: new Date().toISOString(), parentSessionId: sessionId });
    });
    return { ...this.getSession(targetSessionId), native: result };
  }
  /** Internal channel dispatch only. Parent scope is derived by CommunicationCore, never supplied by model text. */
  prepareChannelSession(contextId: string, taskId: string): Promise<void> {
    if (!this.communication.input(taskId)?.forkFromContextId || this.store.get("execution_sessions", contextId)) return Promise.resolve();
    // Host serializes management operations on the source. Do not race first messages from sibling topics.
    const next = this.channelForks.then(() => this.prepareChannelFork(contextId, taskId));
    this.channelForks = next.catch(() => {});
    return next;
  }
  private async prepareChannelFork(contextId: string, taskId: string): Promise<void> {
    this.validate();
    const input = this.communication.input(taskId);
    // Later reset windows deliberately start fresh. Existing topic bindings are always resumed.
    if (!input?.forkFromContextId || input.source.scope !== "group" || contextId !== input.conversationId ||
      this.store.get("execution_sessions", contextId)) return;
    const parent = input.forkFromContextId;
    const previous = this.store.get("channel_session_forks", contextId);
    if (previous) throw new WorkError("channel_session_fork_unconfirmed", 409);
    if (!this.store.get("execution_sessions", parent)) return; // No previous native group context exists to inherit.
    // Host fork is not retry-idempotent. Persist intent before the request; an interrupted/uncertain fork must
    // be reconciled explicitly, rather than silently starting empty or forking twice with a different target.
    this.store.set("channel_session_forks", contextId, { parentSessionId: parent, state: "submitting" });
    try {
      await this.fork(parent, contextId);
      this.store.set("channel_session_forks", contextId, { parentSessionId: parent, state: "completed" });
    } catch (error) {
      this.store.set("channel_session_forks", contextId, { parentSessionId: parent, state: "unconfirmed" });
      throw error;
    }
  }
  async discover() {
    this.validate();
    if (!this.host.discoverRuntime) throw new WorkError("host_discovery_unsupported", 409);
    return this.forward(() => this.host.discoverRuntime!(this.runtimeId));
  }
  /** The runtime's description as its Host reports it, including the owner's allowed settings. No native handshake. */
  async inspect() {
    this.validate();
    if (!this.host.inspectRuntime) throw new WorkError("host_runtime_inspection_unsupported", 409);
    return this.forward(() => this.host.inspectRuntime!(this.runtimeId));
  }
  /** Native settings (model, effort, ...) sent with every turn of this agent that does not select its own. */
  defaultSettings(): Record<string, unknown> {
    this.validate();
    return this.store.get<Record<string, unknown>>(DEFAULT_SETTINGS, "default") ?? {};
  }
  /**
   * Replace the agent's default settings; an empty selection removes them. Host checks every value against the
   * runtime owner's allowed list when a turn starts, so a selection that is no longer allowed fails that turn openly.
   */
  setDefaultSettings(selection: Record<string, unknown>) {
    this.validate();
    const settings = settingsSchema.parse(selection);
    if (Object.keys(settings).length) this.store.set(DEFAULT_SETTINGS, "default", settings);
    else this.store.delete(DEFAULT_SETTINGS, "default");
    return settings;
  }
  private nativeRequest(method: string, params: Record<string, unknown> = {}, runtimeId = this.runtimeId) {
    this.validate();
    if (!this.host.nativeRequest) throw new WorkError("host_native_extension_unsupported", 409);
    return this.forward(() => this.host.nativeRequest!(runtimeId, method, params));
  }
  async skills(forceReload = false) {
    this.validate();
    const cwd = await this.forward(() => runtimeWorkingDirectory(this.host, this.runtimeId));
    return this.nativeRequest("skills/list", { forceReload, cwds: [cwd] });
  }
  async configureSkill(path: string, enabled: boolean) {
    const inventory = await this.skills(true) as { data?: Array<{ skills?: Array<{ path?: string }> }> };
    if (!inventory?.data?.some(entry => entry.skills?.some(skill => skill.path === path))) throw new WorkError("skill_not_in_runtime_catalog", 403);
    return this.nativeRequest("skills/config/write", { path, enabled });
  }
  memoryStatus() { return this.nativeRequest("memory/status"); }
  private async nativeBinding(sessionId: string) {
    const binding = this.binding(sessionId);
    if (!this.host.nativeSessions) throw new WorkError("host_native_sessions_unsupported", 409);
    const response = await this.forward(() => this.host.nativeSessions!({ runtimeId: binding.runtimeId, action: "bindings" })) as { bindings?: Array<{ sessionId: string; nativeSessionId: string }> };
    const native = response.bindings?.find(row => row.sessionId === binding.sessionId);
    if (!native) throw new WorkError("native_session_binding_not_found", 404);
    return { runtimeId: binding.runtimeId, nativeSessionId: native.nativeSessionId };
  }
  async memoryMode(sessionId: string, mode: "enabled" | "disabled") {
    const binding = await this.nativeBinding(sessionId);
    return this.nativeRequest("thread/memoryMode/set", { threadId: binding.nativeSessionId, mode: z.enum(["enabled", "disabled"]).parse(mode) }, binding.runtimeId);
  }
  async readMemory(sessionId: string) {
    const binding = await this.nativeBinding(sessionId);
    return this.nativeRequest("thread/memory/read", { threadId: binding.nativeSessionId }, binding.runtimeId);
  }
  /**
   * A schedule notice (ADR 16.6). It is always recorded on the target session, which is its web delivery. `connectionId`:
   * - omitted: delivered on the newest owner conversation whose connection still exists (follows the owner);
   * - `web`: recorded only (channels that notify the owner may still push it, as for every web-only notice);
   * - a notify connection (push): recorded and pushed there, whether or not a browser has the chat open;
   * - another connection: delivered on its newest owner conversation, or recorded only with the receipt
   *   `suppressed` / `no_conversation_on_connection` when the owner has none there.
   */
  deliver(input: { eventId: string; targetSessionId: string; text: string; connectionId?: string | undefined }) {
    this.validate(); identifier.parse(input.eventId); this.validateTarget(input.targetSessionId);
    const target = input.connectionId;
    if (target !== undefined && target !== WEB_CONNECTION && !this.communication.connected(target)) throw new WorkError("delivery_connection_not_found", 404);
    const hash = digest(input), prior = this.store.get<{ hash: string }>("work_session_deliveries", input.eventId);
    if (prior && prior.hash !== hash) throw new WorkError("delivery_event_id_reused", 409);
    if (!prior) this.store.transaction(() => {
      // The newest route that still exists: an owner-main session outlives the channels it came through.
      const inputs = this.ownerInputs(input.targetSessionId);
      const push = target !== undefined && this.communication.notifies(target);
      const chosen = target === undefined ? inputs.find(item => this.communication.connected(item.connectionId)) ?? inputs[0]!
        : inputs.find(item => item.connectionId === (push ? WEB_CONNECTION : target));
      const record = chosen ?? inputs[0]!, transcript = target !== undefined && (!chosen || target === WEB_CONNECTION);
      const options = { notice: `schedule:${input.eventId}`, ...(transcript ? { transcript: true } : {}), ...(push ? { push: target } : {}) };
      const deliveryId = this.communication.queueContent(record.taskId!, { text: input.text }, `work-event:${input.eventId}`, options);
      const receipt = push ? { push: digest(key(`schedule:${input.eventId}`, target, "notify")) }
        : target === WEB_CONNECTION ? { state: "web" } : transcript ? { state: "suppressed", error: "no_conversation_on_connection" } : {};
      this.store.set("work_session_deliveries", input.eventId, { hash, taskId: record.taskId!, deliveryId, ...receipt });
    });
    return this.lookupDelivery(input.eventId)!;
  }
  /**
   * Ask the owner (ADR 0005 20.3): a card with choices in the owner conversation that belongs to no run, for a decision
   * the product needs from the owner about something that happens elsewhere. It is shown and answered like a card of a
   * run, on the web and on the route `connectionId` selects (the rule of `deliver`); the first answer wins. The same
   * `eventId` returns the same request. It ends answered, `expired` at `expiresAt`, or `withdrawn`. `display` is a JSON
   * object for the web chat API (`card.display`), as for `submit`.
   */
  request(input: OwnerRequestInput): OwnerRequestResult {
    this.validate();
    const request = ownerRequestSchema.parse(input), target = request.connectionId;
    const hash = digest(request), prior = this.store.get<RequestRecord>("work_session_requests", request.eventId);
    if (prior && prior.hash !== hash) throw new WorkError("owner_request_event_id_reused", 409);
    if (!prior) {
      if (!(Date.parse(request.expiresAt) > Date.now())) throw new WorkError("owner_request_expired", 400);
      if (request.display && displayTooLarge(request.display)) throw new WorkError("owner_request_display_too_large", 413);
      if (target !== undefined && target !== WEB_CONNECTION && !this.communication.connected(target)) throw new WorkError("delivery_connection_not_found", 404);
      const { sessionId } = this.openOwnerConversation();
      this.store.transaction(() => {
        const route = this.communication.ownerRoute(sessionId, target);
        createRequest(this.communication.ledger, this.communication, this.agentId, sessionId, request, route);
        this.store.set("work_session_requests", request.eventId, { hash, cardId: requestCardId(request.eventId), route: routeFacts(route, target),
          expiresAt: request.expiresAt } satisfies RequestRecord);
      });
    }
    return this.lookupRequest(request.eventId)!;
  }
  /** The request and its result, read from the ledger; a request past its deadline reads as `expired`. */
  lookupRequest(eventId: string): OwnerRequestResult | null {
    this.validate();
    const record = this.store.get<RequestRecord>("work_session_requests", eventId);
    if (!record) return null;
    const ledger = this.communication.ledger;
    expireRequests(ledger, this.communication);
    const card = ledger.cardRecord(record.cardId), base = { eventId, cardId: record.cardId, sessionId: this.ownerSession, expiresAt: record.expiresAt };
    const delivery = this.receipt(record.route, requestDeliveryId(eventId), `notice:${requestDeliveryId(eventId)}`, true);
    // The owner cleared the conversation: the card is gone and can no longer be answered.
    if (!card) { const at = ledger.settledAt("request", eventId); return { ...base, status: "expired", ...(at === undefined ? {} : { settledAt: new Date(at).toISOString() }), delivery }; }
    if (card.status === "pending") return { ...base, status: "pending", delivery };
    const settledAt = new Date(card.updatedAt).toISOString();
    if (card.status === "expired" || card.status === "canceled") return { ...base, status: card.status === "expired" ? "expired" : "withdrawn", settledAt, delivery };
    const choice = (card.result as { choice?: unknown } | null)?.choice;
    return { ...base, status: "answered", ...(typeof choice === "string" ? { choice } : {}), ...(card.answeredBy ? { answeredBy: card.answeredBy } : {}),
      ...(card.surface === "web" || card.surface === "channel" ? { surface: card.surface } : {}), settledAt, delivery };
  }
  /** Withdraw an unanswered request: its card closes, and an answer that arrives later is refused. Returns the request as it is now. */
  withdrawRequest(eventId: string): OwnerRequestResult {
    const current = this.lookupRequest(eventId);
    if (!current) throw new WorkError("owner_request_not_found", 404);
    const card = this.communication.ledger.cardRecord(current.cardId);
    if (card?.status === "pending") closeRequest(this.communication.ledger, this.communication, card, "canceled");
    return this.lookupRequest(eventId)!;
  }
  /**
   * What ended since a cursor (ADR 20.4): work events whose turn reached a terminal state, and owner requests that
   * were answered, expired or withdrawn, in the order that happened. The record is durable and its `seq` only grows,
   * so a reader that keeps the returned `cursor` sees every ending once, also after a restart of either side.
   */
  settlements(options: { after?: number | undefined; limit?: number | undefined } = {}): { data: Settlement[]; cursor: number } {
    this.validate();
    const after = z.number().int().min(0).parse(options.after ?? 0), limit = z.number().int().min(1).max(500).parse(options.limit ?? 100);
    expireRequests(this.communication.ledger, this.communication);
    const rows = this.communication.ledger.settlements(after, limit);
    const data = rows.flatMap((row): Settlement[] => {
      const head = { seq: row.seq, settledAt: new Date(row.settledAt).toISOString() };
      if (row.kind === "work") return this.store.get("work_session_events", row.eventId) ? [{ ...head, kind: "work", event: this.get(row.eventId) }] : [];
      const request = this.lookupRequest(row.eventId);
      return request ? [{ ...head, kind: "request", request }] : [];
    });
    return { data, cursor: rows.at(-1)?.seq ?? after };
  }
  /** Connections a schedule notice can name (`deliver` `connectionId`): `web` and every registered connection. */
  deliveryConnections(): string[] { return [...new Set([WEB_CONNECTION, ...this.communication.connectionIds()])]; }
  /** The connection `deliver` without `connectionId` would use now (`web` when the session has no live route). */
  deliveryConnection(sessionId: string): string {
    this.validate(); this.validateTarget(sessionId);
    return this.ownerInputs(sessionId).find(item => this.communication.connected(item.connectionId))?.connectionId ?? WEB_CONNECTION;
  }
  lookupDelivery(eventId: string) {
    this.validate();
    const prior = this.store.get<{ taskId: string; deliveryId: string; push?: string; state?: string; error?: string }>("work_session_deliveries", eventId);
    if (!prior) return null;
    if (prior.push) return this.communication.notification(prior.push);
    if (prior.state) return { id: prior.deliveryId, state: prior.state, externalId: null, error: prior.error ?? null };
    try { return this.communication.delivery(prior.taskId, prior.deliveryId, `schedule:${eventId}`); }
    catch (error) {
      // The notice was recorded on a transcript (its delivery) that was purged since.
      if (!(error instanceof Error) || error.message !== "channel_delivery_not_found") throw error;
      return { id: prior.deliveryId, state: "accepted", externalId: null, error: null };
    }
  }

}
