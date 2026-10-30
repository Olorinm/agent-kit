import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../types.js";
import { CodexAppServerClient, CodexRequestFailure } from "./client.js";

export interface CodexNativeAccess {
  /** Service-owner opt-in. This is an administrative API, not a model tool. */
  methods: "all" | string[];
  notifications?: "all" | string[];
  requestTimeoutMs?: number;
  callbackTimeoutMs?: number;
  eventLimit?: number;
}
export interface NativeRequestRecord {
  id: string; nativeId: string | number; method: string; params?: JsonValue;
  native: JsonValue;
  status: "pending" | "completed" | "expired" | "closed";
  deadlineAt: string; result?: JsonValue; error?: { code?: number; message: string; data?: JsonValue };
}

/** Full-duplex native extension. No method, input field, event or response is projected away. */
export class CodexNativeBridge {
  readonly epoch = randomUUID();
  private client?: CodexAppServerClient;
  private readonly cleanups: Array<() => void> = [];
  private sequence = 0;
  private readonly log: Array<{ sequence: number; event: JsonValue }> = [];
  private readonly records = new Map<string, NativeRequestRecord>();
  private readonly pending = new Map<string, (result?: JsonValue, error?: Error) => void>();
  constructor(private readonly connect: () => Promise<CodexAppServerClient>, readonly policy: CodexNativeAccess) {}
  private append(event: JsonValue) {
    this.log.push({ sequence: ++this.sequence, event: structuredClone(event) });
    while (this.log.length > (this.policy.eventLimit ?? 2000)) this.log.shift();
  }
  get attached() { return Boolean(this.client && !this.client.isClosed()); }
  attach(client: CodexAppServerClient) {
    if (this.client !== client) {
      this.closePending();
      for (const cleanup of this.cleanups.splice(0)) cleanup();
      this.client = client;
      this.cleanups.push(
        client.addNotificationHandler(n => this.append({ type: "notification", ...n })),
        client.addFallbackRequestHandler(r => this.callback(r)),
        client.addCloseHandler(error => { this.closePending(); this.append({ type: "closed", message: error.message }); }),
      );
      this.append({ type: "connected", initialize: client.initializeResponse ?? null });
    }
  }
  async ready() {
    const client = await this.connect();
    this.attach(client);
    return client;
  }
  async request(method: string, params?: JsonValue, signal?: AbortSignal) {
    this.allow(method, this.policy.methods);
    if (["initialize", "initialized"].includes(method)) throw new Error("native_initialization_owned_by_host");
    return (await this.ready()).request(method, params, { timeoutMs: this.policy.requestTimeoutMs ?? 60_000, signal });
  }
  async notify(method: string, params?: JsonValue) {
    this.allow(method, this.policy.notifications ?? []);
    if (["initialize", "initialized"].includes(method)) throw new Error("native_initialization_owned_by_host");
    (await this.ready()).notify(method, params);
  }
  private allow(method: string, permitted: "all" | string[]) {
    if (!method || method.length > 250 || /\s/.test(method) || (permitted !== "all" && !permitted.includes(method)))
      throw new Error("native_method_not_allowed");
  }
  events(after = 0, limit = 200, epoch?: string) {
    if (epoch && epoch !== this.epoch) throw new Error("native_event_epoch_changed");
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence || !Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("invalid_native_event_cursor");
    const events = this.log.filter(e => e.sequence > after).slice(0, limit);
    const cursor = events.at(-1)?.sequence ?? after;
    return { epoch: this.epoch, events, cursor, hasMore: cursor < this.sequence,
      historyTruncated: this.log.length > 0 && after < this.log[0]!.sequence - 1 };
  }
  requests() { return [...this.records.values()].map(r => structuredClone(r)); }
  resolve(id: string, response: { result?: JsonValue; error?: NativeRequestRecord["error"] }) {
    const r = this.records.get(id);
    if (!r) throw new Error("native_request_not_found");
    if (("result" in response) === ("error" in response)) throw new Error("native_response_requires_result_or_error");
    if (r.status === "completed") {
      if (!isDeepStrictEqual({ result: r.result, error: r.error }, { result: response.result, error: response.error }))
        throw new Error("native_response_conflict");
      return;
    }
    if (r.status !== "pending" || Date.now() >= Date.parse(r.deadlineAt)) throw new Error("native_request_not_pending");
    r.status = "completed"; r.result = response.result; r.error = response.error;
    this.pending.get(id)?.(response.result, response.error ? new CodexRequestFailure("remote", r.method,
      response.error.message, response.error.code, response.error.data) : undefined);
    this.append({ type: "request/completed", id });
  }
  private callback(request: { id: string | number; method: string; params?: JsonValue }): Promise<JsonValue> {
    if (this.pending.size >= 1000) throw new Error("native_request_limit");
    for (const [id, r] of this.records) if (this.records.size >= 2000 && r.status !== "pending") this.records.delete(id);
    const timeout = this.policy.callbackTimeoutMs ?? 120_000;
    const r: NativeRequestRecord = { id: randomUUID(), nativeId: request.id, method: request.method,
      native: structuredClone(request) as JsonValue,
      params: request.params, status: "pending", deadlineAt: new Date(Date.now() + timeout).toISOString() };
    this.records.set(r.id, r);
    this.append({ type: "request", request: r as unknown as JsonValue });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { r.status = "expired"; settle(undefined, new Error("native_request_expired")); }, timeout);
      timer.unref();
      const settle = (result?: JsonValue, error?: Error) => {
        if (!this.pending.delete(r.id)) return;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result ?? null);
      };
      this.pending.set(r.id, settle);
    });
  }
  private closePending() {
    for (const [id, settle] of this.pending) {
      const record = this.records.get(id); if (record) record.status = "closed";
      settle(undefined, new Error("native_connection_closed"));
    }
  }
  close() { this.closePending(); for (const cleanup of this.cleanups.splice(0)) cleanup(); }
}
