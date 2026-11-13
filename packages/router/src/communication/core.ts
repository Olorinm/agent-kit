import { Message, SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { digest, key, terminal } from "../execution/protocol.js";
import { CliWork } from "../execution/work.js";
import { ChannelSendError, type ChannelAdapter, type ChannelContext, type ChannelMessage, type ReplyRoute, type ChannelContent, type MediaContent, type AttachmentReference, type RecordedAttachment,
  type NotifyPolicy, type NotifyPurpose } from "./types.js";
import { DurableStore } from "./store.js";
import { AgentLedger, type Claim, type Delivery, type DeliveryPurpose, type DeliveryStatus, type EventInput } from "../ledger/ledger.js";
import { recordReceipt, recordStart, type ChannelFacts } from "../ledger/ingress.js";

const messageSchema = z.object({
  externalId: z.string().min(1).max(512), sender: z.string().min(1).max(512), threadId: z.string().min(1).max(1024),
  scope: z.enum(["direct", "group"]), text: z.string().max(1_000_000),
  groupId: z.string().max(1024).optional(),
  forkFromThreadId: z.string().min(1).max(1024).optional(),
  reply: z.object({ target: z.string().min(1).max(1024), messageId: z.string().max(512), data: z.record(z.string(), z.string().max(8192)) }).strict(),
  attachments: z.array(z.object({ id: z.string().max(1024), name: z.string().max(512), mediaType: z.string().max(100), kind: z.enum(["image", "audio", "video", "file", "sticker"]).optional(), data: z.record(z.string(), z.unknown()).optional() }).strict()).max(30).optional(),
  quoted: z.object({ messageId: z.string().optional(), text: z.string().optional() }).strict().optional(),
  action: z.object({ token: z.string().max(128) }).strict().optional(),
  event: z.object({ type: z.string().max(100), data: z.record(z.string(), z.unknown()) }).strict().optional(),
  native: z.record(z.string(), z.unknown()).optional(),
  mentions: z.object({ self: z.boolean(), all: z.boolean() }).strict().optional(),
  privateGroup: z.boolean().optional(),
}).strict();
export interface ConnectionDefinition {
  id: string;
  /** Explicitly linked owner identities share a main conversation only in private chats. */
  ownerAddresses: string[];
  /** Additional peers and groups have isolated conversations. */
  peerAddresses?: string[];
  groupIds?: string[];
  /** The connection notifies the owner (a one-way push channel such as Bark). */
  notify?: NotifyPolicy;
}
/** A received channel message, read from its ledger claim (`ledger_ingress`) and pending input. */
export interface ChannelInput {
  id: string; connectionId: string; source: ChannelMessage;
  /** The session key (`c-…`) the message belongs to. */
  conversationId: string; replyRoute: ReplyRoute;
  receivedAt: string; hash: string;
  /** `received`: waiting for dispatch. `submitted`: its turn runs. `done`: settled. `ignored`: never became work. */
  state: "received" | "ignored" | "submitted" | "done";
  taskId?: string;
  reason?: string;
  /** Server-derived, same-group parent context, pinned when the topic message arrives. */
  forkFromContextId?: string;
  /** The ledger conversation (`cv_…`); absent for a sender that was not admitted. */
  channelConversationId?: string;
}
/** The state of a send as the channel tool and the delivery API report it. */
export type SendState = "queued" | "submitting" | "accepted" | "failed" | "uncertain";
const sendState: Record<DeliveryStatus, SendState> = { created: "queued", queued: "queued", sending: "submitting", sent: "accepted", suppressed: "accepted",
  replied: "accepted", rejected: "failed", unknown: "uncertain" };
type Outbound = Omit<EventInput, "role" | "senderType" | "senderId" | "turnId"> & Partial<Pick<EventInput, "role" | "senderType" | "senderId">> & { turnId: string | null };
/**
 * Person identity for a channel core (ADR 0005 phase 6). Owner resolution looks the sender up
 * by person; `/link` pairing runs at receipt, before the sender check, and writes nothing to any transcript.
 */
export interface CoreIdentity {
  /** The sender's person, or undefined for an unknown identity. */
  person(connectionId: string, source: ChannelMessage): string | undefined;
  /**
   * Pairing control path. Undefined: not a pairing command. Otherwise the reply to send on the message's own route
   * (none for a command in a group, so a code is never confirmed in front of others).
   */
  pair(connectionId: string, source: ChannelMessage): { reply?: string | undefined } | undefined;
  /** Called for each accepted owner message resolved by person (`last_seen_at`). */
  seen?(connectionId: string, source: ChannelMessage): void;
}
interface Connection { definition: ConnectionDefinition; adapter: ChannelAdapter; reload?: () => ChannelAdapter; lastError: string; connected: boolean; failures: number; nextStart: number; }

/**
 * Channel-neutral receipt, conversation mapping and delivery. The agent ledger is the only record: a received message
 * is its claim (`ledger_ingress`), work waiting for dispatch is a pending input, and everything sent is a delivery row.
 */
export class CommunicationCore {
  private readonly connections = new Map<string, Connection>();
  private dispatching = false;
  private flushing = false;
  private lastError = "";
  control?: (input: ChannelInput) => Promise<boolean>;
  readonly ledger: AgentLedger;
  ownerPersonId: string | undefined;
  persons: ((connectionId: string, sender: string) => string | undefined) | undefined;
  identity: CoreIdentity | undefined;
  /** A browser has the session's chat open (owner presence); such a chat needs no push. */
  watching: ((sessionKey: string) => boolean) | undefined;
  constructor(readonly agentId: string, readonly store: DurableStore, readonly work: CliWork, private readonly validate: () => void = () => {}) {
    this.ledger = AgentLedger.open(store);
  }
  private get facts(): ChannelFacts {
    return { agentId: this.agentId, ownerPersonId: this.ownerPersonId, channel: (id) => this.kindOf(id),
      account: (id) => this.store.get<string>("communication_checkpoints", key(id, "account")) ?? id,
      ...(this.persons ? { person: this.persons } : {}) };
  }
  /** The event is the delivery (the owner's web surface): nothing is queued for the connection. */
  private recordedOnly(connectionId: string): boolean { return this.connections.get(connectionId)?.adapter.ledgerDelivery === true; }
  /** The stored message of a claim with its dispatch state. `fallback` stands in for a message whose content was removed. */
  private view(claim: Claim, fallback?: ChannelMessage): ChannelInput | undefined {
    const source = (claim.source ?? fallback) as ChannelMessage | undefined;
    if (!source) return undefined;
    const pending = this.ledger.input(claim.inputId), taskId = (pending?.turn_id as string | null | undefined) ?? undefined;
    const reason = (pending?.reason as string | null | undefined) ?? claim.reason ?? undefined;
    const state = !pending ? claim.state === "accepted" ? "done" : "ignored"
      : pending.state === "queued" || pending.state === "starting" ? "received"
      : pending.state === "dropped" ? "ignored" : pending.state === "control" ? "done"
      : ["completed", "failed", "canceled"].includes(this.ledger.turn(taskId ?? "")?.state ?? "") ? "done" : "submitted";
    return { id: claim.inputId, connectionId: claim.connectionId, source, conversationId: claim.sessionKey ?? "",
      replyRoute: { connectionId: claim.connectionId, ...source.reply }, receivedAt: new Date(claim.receivedAt).toISOString(), hash: claim.hash, state,
      ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}), ...(claim.forkFrom ? { forkFromContextId: claim.forkFrom } : {}),
      ...(claim.conversationId ? { channelConversationId: claim.conversationId } : {}) };
  }
  /** A received message by its input id. */
  inputById(inputId: string): ChannelInput | undefined {
    const claim = this.ledger.claimByInput(inputId);
    return claim ? this.view(claim) : undefined;
  }
  /** The session's messages that became turns, newest first. */
  sessionInputs(sessionKey: string): ChannelInput[] {
    return this.ledger.startedClaims(sessionKey).flatMap((claim) => this.view(claim) ?? []);
  }
  /**
   * Record an outbound event and queue its delivery, in the caller's transaction. `fresh` is false when the delivery
   * (or, on a recorded-only connection, the event) already exists, so a repeated call sends nothing twice.
   */
  private outbound(input: ChannelInput, delivery: { id: string; purpose: DeliveryPurpose; text: string; content?: ChannelContent | undefined;
    turnId?: string | undefined; originTurnId?: string | undefined; activity?: { key: string; active: boolean } | undefined; route?: ReplyRoute | undefined },
    event: Outbound | null, deliver = true): { eventId: string | undefined; fresh: boolean } {
    const ledger = this.ledger, channel = this.kindOf(input.connectionId), queued = deliver && !this.recordedOnly(input.connectionId);
    if (queued && ledger.delivery(delivery.id)) return { eventId: ledger.delivery(delivery.id)!.eventId ?? undefined, fresh: false };
    let eventId: string | undefined, fresh = true;
    if (event && ledger.session(input.conversationId)) {
      const appended = ledger.append(ledger.turn(event.turnId ?? "")?.sessionKey ?? input.conversationId, { role: "assistant", senderType: "agent", senderId: this.agentId,
        conversationId: input.channelConversationId ?? null, ...event, body: { ...event.body, channel } });
      eventId = appended.event.eventId; fresh = !appended.duplicate;
    }
    if (queued) fresh = ledger.createDelivery({ deliveryId: delivery.id, eventId: eventId ?? null, conversationId: input.channelConversationId ?? "",
      connectionId: input.connectionId, route: { ...(delivery.route ?? input.replyRoute), channel }, purpose: delivery.purpose, text: delivery.text,
      ...(delivery.content ? { content: delivery.content } : {}), turnId: delivery.turnId, originTurnId: delivery.originTurnId, activity: delivery.activity });
    return { eventId, fresh };
  }

  register(definition: ConnectionDefinition, adapter: ChannelAdapter, reload?: () => ChannelAdapter): void {
    if (this.connections.has(definition.id)) throw new Error("duplicate_connection_id");
    const fingerprint = digest({ agentId: this.agentId, kind: adapter.kind, ...definition });
    const existing = this.store.get<{ kind: string; agentId: string }>("communication_connections", definition.id);
    if (existing && (existing.kind !== adapter.kind || existing.agentId !== this.agentId)) throw new Error("connection_identity_changed");
    this.store.set("communication_connections", definition.id, { kind: adapter.kind, agentId: this.agentId, fingerprint });
    this.connections.set(definition.id, { definition, adapter, ...(reload ? { reload } : {}), lastError: "", connected: false, failures: 0, nextStart: 0 });
    // A send that was in flight when the process stopped: sent again when that is safe, otherwise its outcome is unknown.
    this.ledger.atomic(() => {
      for (const row of this.ledger.sendingDeliveries(definition.id))
        this.ledger.deliveryStatus(row.deliveryId, row.activity || adapter.retrySafe ? "queued" : "unknown", { error: "send_interrupted" });
    });
  }
  context(connectionId: string): ChannelContext {
    this.connection(connectionId);
    return {
      receive: (message) => { this.receive(connectionId, message); },
      checkpoint: ((name: string, value?: unknown) => {
        if (value === undefined) return this.store.get("communication_checkpoints", key(connectionId, name));
        this.store.set("communication_checkpoints", key(connectionId, name), value);
      }) as ChannelContext["checkpoint"],
      error: (code) => { this.connection(connectionId).lastError = code; },
      disconnected: (error) => {
        const connection = this.connection(connectionId); connection.connected = false; connection.lastError = error;
        connection.nextStart = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(++connection.failures, 6));
      },
    };
  }
  async start(): Promise<void> { await this.reconnect(); }
  async reconnect(now = Date.now()): Promise<void> {
    await Promise.all([...this.connections].map(async ([id, connection]) => {
      if (connection.connected || connection.nextStart > now) return;
      connection.nextStart = Number.MAX_SAFE_INTEGER;
      try {
        if (connection.failures) { await connection.adapter.stop(); if (connection.reload) connection.adapter = connection.reload(); }
        await connection.adapter.start(this.context(id)); connection.connected = true;
        connection.lastError = ""; connection.failures = 0;
      } catch (error) {
        connection.lastError = code(error); await connection.adapter.stop().catch(() => {});
        connection.nextStart = now + Math.min(60_000, 1000 * 2 ** Math.min(++connection.failures, 6));
      }
    }));
  }
  async stop(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map(async (connection) => {
      await connection.adapter.stop(); connection.connected = false;
      connection.nextStart = Number.MAX_SAFE_INTEGER;
    }));
  }
  /**
   * Receipt (ADR 0005 6.1), in one transaction (the caller's when there is one): the claim with the message, the
   * transcript event and the pending input. A redelivered message returns its stored record.
   */
  receive(connectionId: string, input: ChannelMessage): ChannelInput {
    this.validate();
    const source = messageSchema.parse(input);
    const { definition, adapter } = this.connection(connectionId);
    const id = digest(key(this.agentId, connectionId, source.externalId));
    const hash = digest(source);
    const existing = this.ledger.claimFor(connectionId, source.externalId);
    if (existing) {
      if (existing.hash !== hash) throw new Error("channel_event_id_reused_with_different_payload");
      return this.view(existing, source)!;
    }
    const pairing = !adapter.ledgerDelivery && !source.event && !source.action && !source.attachments?.length ? this.identity?.pair(connectionId, source) : undefined;
    if (pairing) return this.receivePairing(connectionId, id, hash, source, pairing.reply);
    const owner = this.isOwner(connectionId, source);
    if (owner && !definition.ownerAddresses.includes(source.sender)) { try { this.identity?.seen?.(connectionId, source); } catch { /* Bookkeeping only. */ } }
    // An owner addressing this agent (or everyone) in a group starts work without a group allowlist.
    const addressed = source.scope === "group" && owner && Boolean(source.mentions?.self || source.mentions?.all);
    const allowed = source.scope === "direct" ? owner || Boolean(definition.peerAddresses?.includes(source.sender)) :
      addressed || adapter.groupPolicy?.(source) === "open" ||
        Boolean(definition.groupIds?.includes(source.groupId ?? source.threadId)) && (owner || Boolean(definition.peerAddresses?.includes(source.sender)));
    const oversized = Buffer.byteLength(source.text) > 24_000;
    const conversationId = `c-${digest(key(this.agentId, source.scope === "direct" && owner ? "owner-main" :
      key(connectionId, source.scope, source.threadId, source.scope === "direct" ? source.sender : "group"))).slice(0, 40)}`;
    // A provider topic may inherit only its own group's main session, never an owner DM or another group.
    const parentId = source.scope === "group" && source.forkFromThreadId && source.forkFromThreadId === source.groupId && source.threadId !== source.groupId
      ? `c-${digest(key(this.agentId, key(connectionId, "group", source.groupId, "group"))).slice(0, 40)}` : undefined;
    const forkFromContextId = parentId ? this.ledger.contextFor(parentId) : undefined;
    const record: ChannelInput = { id, connectionId, source, conversationId, hash, receivedAt: new Date().toISOString(),
      ...(forkFromContextId ? { forkFromContextId } : {}),
      replyRoute: { connectionId, ...source.reply }, state: allowed && (source.text.trim() || source.attachments?.length || source.action || source.event) && !oversized ? "received" : "ignored",
      ...(oversized ? { reason: "input_too_large" } : {}) };
    const noticeId = allowed && oversized ? digest(key(id, "input-too-large")) : undefined;
    return this.commitReceipt(adapter, record, () => recordReceipt(this.ledger, this.facts, record, { owner, allowed, oversized, noticeId }));
  }
  /**
   * A receipt is one unit. When it cannot be recorded, a `strictReceipt` adapter gets the error (its caller retries);
   * every other channel acknowledges the message, which is kept in `ledger_ingress_failures` with the error, so a
   * message that cannot be recorded never stops the channel's cursor or the messages behind it. A redelivery is tried again.
   */
  private commitReceipt(adapter: ChannelAdapter, record: ChannelInput, write: () => void): ChannelInput {
    const ledger = this.ledger, { connectionId, source } = record, outer = this.store.db.isTransaction;
    try {
      ledger.unit(() => { write(); ledger.clearIngressFailure(connectionId, source.externalId); });
    } catch (error) {
      if (adapter.strictReceipt || outer && !this.store.db.isTransaction) throw error;
      ledger.failIngress({ connectionId, externalId: source.externalId, inputId: record.id, hash: record.hash, source,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      this.lastError = "receipt_not_recorded";
      return { ...record, state: "ignored", reason: "receipt_not_recorded" };
    }
    return this.inputById(record.id) ?? record;
  }
  /**
   * A `/link` command (ADR 0005 18.4): the claim is `ignored` with reason `pairing`, no conversation, event or turn is
   * created, and the code is not kept (the claim stores a placeholder; the hash still dedupes redelivery).
   * The reply is a notice on the message's own route without a transcript event.
   */
  private receivePairing(connectionId: string, id: string, hash: string, source: z.infer<typeof messageSchema>, reply: string | undefined): ChannelInput {
    const { native: _native, quoted: _quoted, ...rest } = source;
    const record: ChannelInput = { id, connectionId, source: { ...rest, text: "/link ********" }, hash, receivedAt: new Date().toISOString(),
      conversationId: `c-${digest(key(this.agentId, key(connectionId, source.scope, source.threadId, source.scope === "direct" ? source.sender : "group"))).slice(0, 40)}`,
      replyRoute: { connectionId, ...source.reply }, state: "ignored", reason: "pairing" };
    return this.commitReceipt(this.connection(connectionId).adapter, record, () => {
      const ledger = this.ledger;
      if (ledger.claim({ connectionId, externalId: source.externalId, inputId: id, hash, source: record.source, sessionKey: record.conversationId }).duplicate) return;
      ledger.settleClaim(connectionId, source.externalId, "ignored", { reason: "pairing" });
      // A stranger has no conversation, so the reply is a delivery without one.
      if (reply) ledger.createDelivery({ deliveryId: digest(key(id, "pairing")), eventId: null, conversationId: "", connectionId,
        route: { ...record.replyRoute, channel: this.kindOf(connectionId) }, purpose: "notice", text: reply });
    });
  }
  /**
   * Owner check (ADR 0005 18.1): the sender resolves to the agent owner's person. Configured `ownerAddresses` are
   * still honored directly for one release; they are also seeded as `config` identities.
   */
  isOwner(connectionId: string, source: ChannelMessage): boolean {
    if (this.connections.get(connectionId)?.definition.ownerAddresses.includes(source.sender)) return true;
    return Boolean(this.identity && this.ownerPersonId && this.identity.person(connectionId, source) === this.ownerPersonId);
  }
  /** Dispatch (ADR 0005 6.2): pending inputs in receipt order become turns, or are consumed by a control command. */
  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    const ledger = this.ledger;
    try {
      for (const id of ledger.dueInputs()) {
        this.validate();
        // Earlier items await; re-read so an input redacted or settled meanwhile is not dispatched from a stale list.
        const pending = ledger.input(id);
        if (!pending || !["queued", "starting"].includes(String(pending.state))) continue;
        const value = this.inputById(id);
        if (!value) { ledger.updateInput(id, "dropped", { reason: "input_missing" }); continue; }
        // A message on a connection that is gone (a removed channel kind or a deleted connection) has no route. It must not stall the queue,
        // and it is settled so that bringing the connection back does not run it late.
        if (!this.connections.has(value.connectionId)) { ledger.updateInput(id, "dropped", { reason: "connection_removed" }); continue; }
        // Taken by the dispatcher: a later redaction no longer drops it. After a crash `starting` is retried with the
        // same message id, and CliWork returns the same task.
        if (pending.state === "queued") ledger.updateInput(id, "starting");
        if (this.control && await this.control(value)) { ledger.updateInput(id, "control", { reason: "control" }); continue; }
        if (value.source.action) {
          ledger.atomic(() => { this.notice(value, "这个按钮已失效，请根据当前提问重新操作。", "stale-action"); ledger.updateInput(id, "control", { reason: "stale_action" }); });
          continue;
        }
        const resumable = (item: ChannelInput) => Boolean(item.taskId) && item.conversationId === value.conversationId &&
          (item.connectionId === value.connectionId && item.source.sender === value.source.sender || this.isOwnerInput(item) && this.isOwnerInput(value));
        // A reset (ADR 16.3) opens a new execution context: turns of earlier windows are never resumed.
        const window = ledger.session(value.conversationId)?.window;
        const current = (item: ChannelInput) => window === undefined || window === 1 || ledger.turn(item.taskId ?? "")?.window === window;
        const prior = this.sessionInputs(value.conversationId).find(resumable);
        const resumeFrom = prior && current(prior) ? prior : undefined;
        const previous = resumeFrom?.taskId ? await this.work.get(resumeFrom.taskId) : undefined;
        const resume = previous && [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(previous.status?.state ?? 0);
        let quote = value.source.quoted?.text;
        if (!quote && value.source.quoted?.messageId) {
          const quotedId = value.source.quoted.messageId;
          const target = ledger.event(ledger.platformEvent(value.connectionId, quotedId) ?? quotedId);
          if (target && target.sessionKey === value.conversationId && typeof target.body.text === "string" && !target.body.redacted) quote = target.body.text;
        }
        if (!quote && value.source.quoted?.messageId) {
          try { quote = await this.connection(value.connectionId).adapter.readQuote?.(value.source); }
          catch { this.connection(value.connectionId).lastError = "quoted_message_unavailable"; }
        }
        const prepared = this.connection(value.connectionId).adapter.turnContext?.(value.source);
        let text = [prepared?.text ?? "", quote ? `引用消息：${quote}` : value.source.quoted?.messageId ? `引用消息 ID：${value.source.quoted.messageId}` : "", value.source.text,
          value.source.event ? JSON.stringify(value.source.event) : "",
          ...(value.source.attachments ?? []).map((item) => `附件：${item.name} (${item.mediaType})`)].filter(Boolean).join("\n");
        if (Buffer.byteLength(text) > 24_000) text = Buffer.from(text).subarray(0, 23_500).toString("utf8") + "\n[消息上下文已截短；原始消息可通过 channel message 工具读取。]";
        // Execution tools need provider IDs; the internal session ID cannot fetch channel history.
        // Select routing facts explicitly: raw events and reply data may contain provider secrets.
        const channelContext = { channel: this.connection(value.connectionId).adapter.kind, connectionId: value.connectionId,
          scope: value.source.scope, conversationId: value.replyRoute.target, messageId: value.replyRoute.messageId,
          senderId: value.source.sender, ...(value.source.quoted?.messageId ? { quotedMessageId: value.source.quoted.messageId } : {}) };
        // The window's context id (window 1 is the session key), so a reset starts a new Host session.
        const contextId = ledger.contextFor(value.conversationId);
        const request = SendMessageRequest.fromJSON({ message: { messageId: `channel-${id}`, contextId,
          ...(resume ? { taskId: previous!.id } : {}), role: "ROLE_USER",
          parts: [{ text }, { text: `Channel context (provider routing IDs): ${JSON.stringify(channelContext)}` }] }, configuration: { returnImmediately: true } });
        // Both steps are independently durable. The stable message ID closes the restart window.
        const task = await this.work.send(request, { sender: resume ? this.work.inspect(previous!.id).from : key("channel", value.connectionId, value.source.sender),
          room: value.conversationId, approved: true });
        ledger.atomic(() => recordStart(ledger, this.facts, value, task.id, this.isOwnerInput(value)));
        prepared?.commit();
      }
      this.publishResults();
      this.lastError = "";
    } catch (error) { this.lastError = code(error); throw error; }
    finally { this.dispatching = false; }
  }
  private publishResults(): void {
    const ledger = this.ledger;
    for (const { id: eventId, value: task } of this.work.events()) {
      const input = this.input(task.id);
      if (!input) continue; // Not channel work (for example a work session event).
      this.store.transaction(() => {
        // The connection may be gone: the result is still recorded, and flush settles its delivery as rejected.
        const adapter = this.connections.get(input.connectionId)?.adapter;
        const capabilities = adapter?.capabilitiesFor?.(input.replyRoute) ?? adapter?.capabilities;
        if (adapter?.activity && capabilities?.native.includes("reaction")) {
          const active = task.status?.state === TaskState.TASK_STATE_WORKING;
          this.outbound(input, { id: digest(key(input.id, "activity", String(active))), purpose: "activity", text: "", turnId: task.id,
            activity: { key: input.id, active } }, null);
        }
        const finalId = digest(key(task.id, "final"));
        // Published once: the turn then has its final event (kept on the turn after a purge) or its reply delivery.
        if (terminal(task) && !ledger.turn(task.id)?.finalEventId && !ledger.delivery(finalId)) {
          const parts = task.artifacts.flatMap((artifact) => artifact.parts);
          const answer = this.store.get<string>("communication_results", task.id) ??
            parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
          const fallback = task.status?.state === TaskState.TASK_STATE_CANCELED ? "已取消。" :
            task.status?.state === TaskState.TASK_STATE_COMPLETED ? "已完成。" :
              task.status?.message?.parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n") || "本轮执行失败，请查看运行状态。";
          const text = answer || fallback;
          const { eventId: finalEventId } = this.outbound(input, { id: finalId, purpose: "reply", text, turnId: task.id },
            { kind: "message", turnId: task.id, idempotencyKey: `turn:${task.id}:final`, body: { text, final: true } });
          const state = task.status?.state === TaskState.TASK_STATE_COMPLETED ? "completed" : task.status?.state === TaskState.TASK_STATE_CANCELED ? "canceled" : "failed";
          ledger.turnState(task.id, state, { agentId: this.agentId, ...(finalEventId ? { finalEventId } : {}), ...(state === "failed" ? { error: text.slice(0, 500) } : {}) });
          if (task.status?.state !== TaskState.TASK_STATE_CANCELED) this.notifyOwner("reply", input, text, `turn:${task.id}`);
        }
        if (!terminal(task) && task.status?.message) {
          const text = task.status.message.parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
          if (text) {
            const id = digest(key(task.id, "notice", text));
            this.outbound(input, { id, purpose: "notice", text, turnId: task.id }, { kind: "notice", turnId: task.id, idempotencyKey: `notice:${id}`, body: { text, level: "info" } });
          }
        }
        this.work.ack(eventId);
      });
    }
  }
  saveResult(taskId: string, answer: string): boolean {
    if (!this.input(taskId)) return false;
    const previous = this.store.get<string>("communication_results", taskId);
    if (previous !== undefined && previous !== answer) throw new Error("execution_result_changed");
    this.store.set("communication_results", taskId, answer);
    return true;
  }
  /** A later window's execution context (`<key>.w<n>`) belongs to its session. */
  private sessionOf(contextId: string): string { return this.ledger.sessionForContext(contextId) ?? contextId; }
  isOwnerTask(conversationId: string, taskId: string): boolean {
    const input = this.input(taskId);
    return Boolean(input && input.conversationId === this.sessionOf(conversationId) && this.isOwnerInput(input));
  }
  /** The owner's turn in a group of only the owner and the owner's agents, as reported at receipt. */
  isPrivateGroupOwnerTask(conversationId: string, taskId: string): boolean {
    const input = this.input(taskId);
    return Boolean(input && input.conversationId === this.sessionOf(conversationId) && input.source.scope === "group" && input.source.privateGroup === true &&
      this.isOwner(input.connectionId, input.source));
  }
  /** Flush (ADR 0005 6.4): queued deliveries that are due are sent through their connection. */
  async flush(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const ledger = this.ledger;
    try {
      for (const id of ledger.dueDeliveries(now)) {
        this.validate();
        const value = ledger.delivery(id);
        if (!value || value.status !== "queued") continue;
        const connection = this.connections.get(value.connectionId);
        if (!connection) { ledger.atomic(() => ledger.deliveryStatus(id, "rejected", { error: "connection_removed" })); continue; }
        if (!connection.connected) continue;
        const { channel: _channel, ...route } = value.route as ReplyRoute & { channel?: string };
        // A working marker is only set while its turn still works on that input.
        if (value.activity?.active && ((await this.work.get(value.turnId!)).status?.state !== TaskState.TASK_STATE_WORKING || this.input(value.turnId!)?.id !== value.activity.key)) {
          ledger.atomic(() => ledger.deliveryStatus(id, "suppressed")); continue;
        }
        const attempts = value.attempts + 1;
        ledger.atomic(() => ledger.deliveryStatus(id, "sending", { attempts }));
        try {
          const content = value.content as ChannelContent | null;
          const streamed = value.turnId && value.purpose === "reply" && this.store.get("communication_streams", value.turnId);
          const receipt = value.activity && connection.adapter.activity
            ? await connection.adapter.activity(route, value.activity.active, value.activity.key)
            : streamed && !content && connection.adapter.progress
            ? await connection.adapter.progress(route, value.text, value.turnId!, true)
            : content && connection.adapter.sendContent ? await connection.adapter.sendContent(route, content, id)
            : await connection.adapter.send(route, value.text, id);
          ledger.atomic(() => ledger.deliveryStatus(id, "sent", { platformMessageId: receipt.externalId }));
        } catch (error) {
          const disposition = value.activity ? (attempts < 5 ? "retry" : "failed") :
            error instanceof ChannelSendError ? error.disposition : connection.adapter.retrySafe ? "retry" : "uncertain";
          const nextAt = now + Math.max(error instanceof ChannelSendError ? error.retryAfterMs : 0, Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)));
          ledger.atomic(() => ledger.deliveryStatus(id, disposition === "retry" ? "queued" : disposition === "failed" ? "rejected" : "unknown", { error: code(error), nextAt }));
        }
      }
    } catch (error) { this.lastError = code(error); throw error; }
    finally { this.flushing = false; }
  }
  /** Connections, the newest received messages and sends, and receipts that could not be recorded. */
  status() {
    const ledger = this.ledger;
    return { agentId: this.agentId, error: this.lastError || null, connections: [...this.connections].map(([id, connection]) => ({ id, kind: connection.adapter.kind,
      started: connection.connected, capabilities: connection.adapter.capabilities ?? null, error: connection.lastError || null })),
      inbox: ledger.recentClaims().flatMap((claim) => this.view(claim) ?? []).map((value) => ({ id: value.id, connectionId: value.connectionId,
        sender: value.source.sender, threadId: value.source.threadId, conversationId: value.conversationId,
        state: value.state, taskId: value.taskId ?? null, reason: value.reason ?? null })),
      outbox: ledger.recentDeliveries().map((value) => ({ id: value.deliveryId, taskId: value.turnId,
        connectionId: value.connectionId, state: sendState[value.status], attempts: value.attempts, error: value.error })),
      receiptFailures: ledger.ingressFailures().map((value) => ({ id: value.inputId, connectionId: value.connectionId, error: codeOf(value.error),
        receivedAt: new Date(value.receivedAt).toISOString() })) };
  }
  /** The newest received message of a turn (a resumed turn has several). */
  input(taskId: string): ChannelInput | undefined {
    const inputId = this.ledger.inputForTurn(taskId);
    return inputId ? this.inputById(inputId) : undefined;
  }
  notice(input: ChannelInput, text: string, suffix: string, content?: ChannelContent): string {
    const id = digest(key(input.id, suffix)), question = suffix.startsWith("question:");
    // A question is recorded as a `card` event by the component that owns the call, which binds this delivery to it.
    this.ledger.atomic(() => {
      const { fresh } = this.outbound(input, { id, purpose: question ? "card" : "notice", text, content }, question ? null
        : { kind: "notice", turnId: null, role: "system", senderType: "system", senderId: "router", idempotencyKey: `notice:${id}`, body: { text, level: "info" } });
      if (fresh && question) this.notifyOwner("question", input, text, `notice:${id}`);
    });
    return id;
  }
  async attachments(taskId: string): Promise<MediaContent[]> {
    const input = this.input(taskId); if (!input) return [];
    const cached = this.store.get<MediaContent[]>("communication_media", input.id); if (cached) return cached;
    const adapter = this.connection(input.connectionId).adapter;
    const items: MediaContent[] = []; let size = 0;
    for (const attachment of input.source.attachments ?? []) {
      if (attachment.kind === "sticker" && adapter.capabilities?.receive.includes("sticker-reference")) continue;
      if (!adapter.readAttachment) throw new Error("channel_attachment_read_unsupported");
      const item = await adapter.readAttachment(input.source, attachment);
      size += Buffer.byteLength(item.data, "base64"); if (size > 30 * 1024 * 1024) throw new Error("attachments_too_large");
      items.push(item);
    }
    if (items.length) this.store.set("communication_media", input.id, items);
    return items;
  }
  async progress(taskId: string, text: string): Promise<void> {
    const input = this.input(taskId); if (!input || !text) return;
    const connection = this.connections.get(input.connectionId);
    if (!connection?.connected || !connection.adapter.progress || !this.capabilities(taskId)?.stream) return;
    const receipt = await connection.adapter.progress(input.replyRoute, text, taskId, false);
    this.store.set("communication_progress_messages", taskId, receipt.externalId.split(","));
    this.store.set("communication_streams", taskId, true);
  }
  capabilities(taskId: string) { const input = this.input(taskId); if (!input) return undefined;
    const adapter = this.connections.get(input.connectionId)?.adapter; return adapter?.capabilitiesFor?.(input.replyRoute) ?? adapter?.capabilities; }
  /** True while the connection is registered. Records of a removed connection stay readable but have no route. */
  connected(connectionId: string): boolean { return this.connections.has(connectionId); }
  /** Registered connection ids. */
  connectionIds(): string[] { return [...this.connections.keys()]; }
  /**
   * An owner's direct input. A sender that became the owner by pairing is the owner only in owner-main; its earlier
   * peer conversations keep their peer rights (ADR 0005 18.1: a conversation never moves).
   * On a connection that is gone the record speaks for itself: only an owner's direct message is in owner-main.
   */
  isOwnerInput(input: ChannelInput) {
    if (input.source.scope !== "direct") return false;
    const ownerMain = input.conversationId === `c-${digest(key(this.agentId, "owner-main")).slice(0, 40)}`;
    const connection = this.connections.get(input.connectionId);
    if (!connection) return ownerMain;
    if (connection.definition.ownerAddresses.includes(input.source.sender)) return true;
    return ownerMain && this.isOwner(input.connectionId, input.source);
  }
  /** The record of a content send: its delivery row, or its event on a connection where the event is the delivery. */
  private contentSent(input: ChannelInput, id: string, eventKey = `content:${id}`): { row: Delivery } | { eventId: string } | undefined {
    const row = this.ledger.delivery(id);
    if (row) return { row };
    const event = this.ledger.eventByKey(input.conversationId, eventKey);
    return event ? { eventId: event.eventId } : undefined;
  }
  /**
   * `queueContent` for the channel tool. On a transcript channel (web) the media is stored first (ADR 0005 16.5) and the
   * content event carries it as attachments; a retry with the same send key stores nothing again.
   */
  async submitContent(taskId: string, content: ChannelContent, sendKey: string): Promise<string> {
    const input = this.input(taskId); if (!input) throw new Error("channel_task_not_found");
    const recorded = this.connection(input.connectionId).adapter.recordedMedia;
    if (!content.media?.length || !recorded || this.contentSent(input, digest(key(taskId, "content", sendKey)))) return this.queueContent(taskId, content, sendKey);
    const items = await recorded.store(content.media);
    try { return this.queueContent(taskId, content, sendKey, { attachments: items }); }
    catch (error) { recorded.release(items); throw error; }
  }
  /**
   * `transcript`: the notice is recorded on the session and delivered to no channel (ADR 16.6 `web`). `push`: the
   * notice is also sent to that notify connection, whether or not a browser has the chat open.
   */
  queueContent(taskId: string, content: ChannelContent, sendKey: string,
    options: { notice?: string; attachments?: RecordedAttachment[]; transcript?: boolean; push?: string } = {}): string {
    const input = this.input(taskId); if (!input) throw new Error("channel_task_not_found");
    // A schedule notice whose session only has a removed connection: the transcript is its delivery.
    const adapter = options.notice ? this.connections.get(input.connectionId)?.adapter : this.connection(input.connectionId).adapter;
    if ((content.html || content.media?.length || content.card || content.buttons?.length) && !adapter?.sendContent) throw new Error("channel_content_unsupported");
    const capabilities = this.capabilities(taskId);
    if (content.html && !capabilities?.send.includes("html")) throw new Error("channel_html_unsupported");
    if (content.media?.length && !capabilities?.send.some((kind) => ["file", "image", "audio", "video"].includes(kind))) throw new Error("channel_media_unsupported");
    if (!content.text && !content.html && !content.media?.length && !content.card && !content.buttons?.length) throw new Error("channel_content_empty");
    if (content.card && !capabilities?.send.includes("card")) throw new Error("channel_card_unsupported");
    const id = digest(key(taskId, "content", sendKey)), recorded = options.attachments?.length ? options.attachments : undefined;
    // Recorded media lives in the blob store; the delivery keeps no copy of its bytes.
    const { media: _media, ...rest } = content;
    let bound = false;
    this.ledger.atomic(() => {
      const { eventId, fresh } = this.outbound(input, { id, purpose: "content", text: content.text, content: recorded ? rest : content, originTurnId: taskId },
        options.notice ? { kind: "notice", turnId: null, idempotencyKey: options.notice, body: { text: content.text, level: "info", origin: "schedule" } }
          : { kind: "message", turnId: taskId, idempotencyKey: `content:${id}`, body: { text: content.text, ...(content.html ? { html: content.html } : {}),
            ...(recorded ? { attachments: recorded } : content.media?.length ? { media: content.media.map((item) => ({ name: item.name, contentType: item.mediaType })) } : {}) } },
        !options.transcript && Boolean(adapter));
      if (!fresh) return;
      if (recorded && eventId) { adapter!.recordedMedia!.bind(this.ledger, eventId, recorded); bound = true; }
      if (options.notice && options.push) this.queueNotification(options.push, "schedule", input, content.text, options.notice);
      else if (options.notice) this.notifyOwner("schedule", input, content.text, options.notice, { webOnly: options.transcript });
    });
    // Not recorded (a duplicate): its stored media has no event.
    if (recorded && !bound) adapter?.recordedMedia?.release(recorded);
    return id;
  }
  /**
   * Owner notifications (one-way push channels). An answer, a question or a schedule notice that reaches the owner only
   * through a transcript surface (web), or through no live connection at all, is queued as plain text to every
   * connection whose notify policy covers its purpose. Other channels deliver to the owner's own app, which notifies
   * by itself, and a chat open in a browser needs no push. A notification is a delivery without a transcript event:
   * it repeats an event that is already recorded.
   */
  private notifyOwner(purpose: NotifyPurpose, input: ChannelInput, text: string, ref: string, options: { webOnly?: boolean | undefined } = {}, now = Date.now()): void {
    if (!text.trim() || !this.isOwnerInput(input)) return;
    const origin = this.connections.get(input.connectionId);
    if (!options.webOnly && origin && !origin.adapter.ledgerDelivery) return;
    const covers = (policy: NotifyPolicy) => purpose === "reply" ? policy.replies && now - Date.parse(input.receivedAt) >= policy.replyAfterSeconds * 1000
      : purpose === "question" ? policy.questions : policy.schedules;
    const targets = [...this.connections].filter(([, connection]) => connection.definition.notify && covers(connection.definition.notify));
    if (!targets.length) return;
    try { if (this.watching?.(input.conversationId)) return; } catch { /* Presence is a hint: an unknown state notifies. */ }
    for (const [connectionId] of targets) this.queueNotification(connectionId, purpose, input, text, ref);
  }
  private queueNotification(connectionId: string, purpose: NotifyPurpose, input: ChannelInput, text: string, ref: string): string {
    if (!this.notifies(connectionId)) throw new Error("notify_connection_not_found");
    const id = digest(key(ref, connectionId, "notify"));
    this.ledger.createDelivery({ deliveryId: id, eventId: null, conversationId: input.channelConversationId ?? "", connectionId, purpose: "notice", text,
      route: { connectionId, target: "owner", messageId: "", data: { purpose, sessionKey: input.conversationId }, channel: this.kindOf(connectionId) } });
    return id;
  }
  /** A registered connection that notifies the owner (a one-way push channel). */
  notifies(connectionId: string): boolean { return Boolean(this.connections.get(connectionId)?.definition.notify); }
  /** The state of an owner notification. */
  notification(id: string) {
    const row = this.ledger.delivery(id);
    if (!row || (row.route as ReplyRoute).target !== "owner" || row.turnId || row.originTurnId) throw new Error("channel_delivery_not_found");
    return { id, state: sendState[row.status], externalId: row.platformMessageId, error: row.error };
  }
  /** The state of a content send of a turn. `eventKey` names the event of a send that was only recorded. */
  delivery(taskId: string, id: string, eventKey?: string): { id: string; state: SendState; externalId: string | null; error: string | null } {
    const input = this.input(taskId), sent = input && this.contentSent(input, id, eventKey);
    if (!sent) throw new Error("channel_delivery_not_found");
    if ("eventId" in sent) return { id, state: "accepted", externalId: sent.eventId, error: null };
    if (sent.row.originTurnId !== taskId) throw new Error("channel_delivery_not_found");
    return { id, state: sendState[sent.row.status], externalId: sent.row.platformMessageId, error: sent.row.error };
  }
  async native(taskId: string, operation: string, args: Record<string, unknown>) {
    const input = this.input(taskId); if (!input) throw new Error("channel_task_not_found");
    const adapter = this.connection(input.connectionId).adapter;
    if (!adapter.native || !this.capabilities(taskId)?.native.includes(operation)) throw new Error("channel_native_operation_unsupported");
    return adapter.native(input.replyRoute, operation, args);
  }
  /**
   * One attachment of a received message, for lazy promotion into the blob store (ADR 0005 16.5). Reuses the
   * model's media cache when the input was already read, so an expired platform resource can still be promoted.
   */
  async readStoredAttachment(inputId: string, reference: AttachmentReference): Promise<MediaContent> {
    const input = this.inputById(inputId); if (!input) throw new Error("channel_input_not_found");
    const adapter = this.connection(input.connectionId).adapter;
    const read = (input.source.attachments ?? []).filter((item) => !(item.kind === "sticker" && adapter.capabilities?.receive.includes("sticker-reference")));
    const index = read.findIndex((item) => item.id === reference.id), cached = this.store.get<MediaContent[]>("communication_media", inputId);
    if (index >= 0 && cached?.[index]) return cached[index]!;
    const attachment = (input.source.attachments ?? []).find((item) => item.id === reference.id);
    if (!attachment) throw new Error("channel_attachment_not_found");
    if (!adapter.readAttachment) throw new Error("channel_attachment_read_unsupported");
    return adapter.readAttachment(input.source, attachment);
  }
  /** The adapter kind, also of a connection that is no longer registered (its stored record stays). */
  private kindOf(id: string): string {
    return this.connections.get(id)?.adapter.kind ?? this.store.get<{ kind: string }>("communication_connections", id)?.kind ?? id;
  }
  private connection(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error("connection_not_found");
    return connection;
  }
}
const codeOf = (message: string) => /^[a-z0-9_:-]+$/.test(message) ? message : "channel_operation_failed";
function code(error: unknown): string { return error instanceof Error ? codeOf(error.message) : "channel_operation_failed"; }
