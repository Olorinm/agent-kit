import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { DurableStore } from "../communication/store.js";
import { ChannelHttpError } from "../http.js";
import { activeFailures, newPairingCode, nextFailure, normalizeCode, type PairingFailures } from "../ledger/pairing-codes.js";
import { HOST_OFFLINE, HostRuns, type HostPort, type HostStartInput, type HostTransport } from "./host.js";
import { digest } from "./protocol.js";
import { WorkError } from "./work.js";

const ROOT = "/_agent-router/v1/host-links";
/** The WebSocket a linked Agent Host opens, with `Authorization: Bearer <device credential>`. */
export const HOST_LINK_SOCKET_PATH = `${ROOT}/socket`;
/** Where a Host exchanges a pairing code for its device credential. */
export const HOST_LINK_ENROLL_PATH = `${ROOT}/enroll`;
/** Largest frame either side of a host link sends or accepts. */
export const HOST_LINK_FRAME_LIMIT = 16 * 1024 * 1024;
const BINDING = "link:", LINKS = "host_links", CODES = "host_link_codes", FAILURES = "host_link_failures";

/** A machine whose Agent Host keeps a connection to Router for one agent. */
export interface HostLink {
  id: string; agentId: string; deviceName: string; platform: string;
  /** The one runtime of that Host which Router reaches. */
  runtime: { id: string; kernel: string };
  online: boolean; createdAt: string;
  /** When the Host last connected or disconnected; null before its first connection. */
  lastOnlineAt: string | null;
}
/**
 * `enrolled`: a Host exchanged a pairing code. `online` / `offline`: its connection opened or was lost. `revoked`:
 * the link was revoked, replaced by a new pairing of the same agent, or removed with its agent.
 * `binding` is the Host binding of the link (`host: { binding, runtimeId: link.runtime.id }`).
 */
export interface HostLinkEvent { type: "enrolled" | "online" | "offline" | "revoked"; owner: string; link: HostLink; binding: string }
interface StoredLink extends Omit<HostLink, "online"> { owner: string; credentialHash: string }
interface StoredCode { owner: string; agentId: string; expiresAt: number }
interface Connection {
  ws: WebSocket; alive: boolean; heartbeat: NodeJS.Timeout;
  pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
}

export const hostLinkCodeRequest = z.object({ agentId: z.uuid() }).strict();
export const hostLinkEnrollRequest = z.object({
  code: z.string().min(8).max(32),
  deviceName: z.string().trim().min(1).max(100),
  platform: z.string().regex(/^[a-z0-9]{1,32}$/),
  runtime: z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/), kernel: z.string().regex(/^[a-z0-9-]{1,48}$/) }).strict(),
}).strict();
const response = z.object({ type: z.literal("response"), id: z.string(), status: z.number().int().min(100).max(599), body: z.unknown() });

/** A linked Host takes messages only, and is offline whenever its machine is not connected. */
class LinkedHost extends HostRuns {
  readonly restricted = true;
  constructor(http: HostTransport, readonly online: () => boolean) { super(http); }
  override async start(input: HostStartInput) {
    const { instructions, tools, toolOutput, inputItems, attachments, ...message } = input;
    if (instructions || tools?.length || toolOutput || inputItems?.length || attachments?.length)
      throw new ChannelHttpError(422, "host_link_accepts_messages_only");
    return super.start({ ...message, instructions: "" });
  }
  /** A page that does not fit one frame is read in smaller pages. */
  override async events(id: string, after: number, limit = 200): ReturnType<HostRuns["events"]> {
    try { return await super.events(id, after, limit); }
    catch (error) {
      if (!(error instanceof ChannelHttpError) || error.code !== "response_too_large" || limit <= 1) throw error;
      return this.events(id, after, Math.floor(limit / 2));
    }
  }
}

/**
 * Host links: an Agent Host on a machine without a public address connects to Router and keeps the connection open;
 * Router sends its Host requests through it. The owner creates a pairing code for an agent, the Host exchanges it
 * for a device credential (stored here as a hash), and from then on connects with that credential. An agent has at
 * most one link. Implements `HostBindingProvider` for the bindings `link:<linkId>`.
 */
export class HostLinks {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: HOST_LINK_FRAME_LIMIT });
  private readonly live = new Map<string, Connection>();
  private readonly listeners = new Set<(event: HostLinkEvent) => unknown>();
  private readonly heartbeatMs: number;
  private readonly requestTimeoutMs: number;
  private sequence = 0;
  private closed = false;
  constructor(private readonly store: DurableStore, private readonly owns: (owner: string, agentId: string) => boolean,
    options: { heartbeatMs?: number; requestTimeoutMs?: number } = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 20_000; this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }
  static binding(linkId: string): string { return BINDING + linkId; }
  static isBinding(binding: string): boolean { return binding.startsWith(BINDING); }
  private static codeHash(normalized: string) { return digest(["host-link-code", normalized]); }
  private view(link: StoredLink): HostLink {
    const { owner: _owner, credentialHash: _hash, ...view } = link;
    return { ...view, online: this.live.has(link.id) };
  }
  private links() { return this.store.entries<StoredLink>(LINKS).map(({ value }) => value); }
  private emit(type: HostLinkEvent["type"], link: StoredLink) {
    const event = { type, owner: link.owner, link: this.view(link), binding: HostLinks.binding(link.id) };
    for (const listener of this.listeners) {
      try { void Promise.resolve(listener(event)).catch(() => {}); } catch { /* A listener never breaks a link. */ }
    }
  }
  /** Called for every change of a link's state; returns the function that stops it. */
  subscribe(listener: (event: HostLinkEvent) => unknown): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** A single-use pairing code (one hour) for one of the owner's agents. It replaces the agent's earlier unused code. */
  createCode(owner: string, agentId: string, now = Date.now()): { code: string; expiresAt: string } {
    if (!this.owns(owner, agentId)) throw new WorkError("agent_not_found", 404);
    return this.store.transaction(() => {
      for (const { id, value } of this.store.entries<StoredCode>(CODES)) if (value.expiresAt <= now || value.agentId === agentId) this.store.delete(CODES, id);
      const { normalized, code, expires } = newPairingCode(now);
      this.store.set(CODES, HostLinks.codeHash(normalized), { owner, agentId, expiresAt: expires } satisfies StoredCode);
      return { code, expiresAt: new Date(expires).toISOString() };
    });
  }
  /**
   * Exchange a pairing code for a device credential. `client` identifies who is asking (the request's address): five
   * wrong codes within an hour lock that client out for an hour. The credential is returned once and never stored.
   */
  enroll(input: z.infer<typeof hostLinkEnrollRequest>, client: string, now = Date.now()): { linkId: string; agentId: string; credential: string } {
    const clientKey = digest(["host-link-client", client]);
    const failures = activeFailures(this.store.get<PairingFailures>(FAILURES, clientKey), now);
    if (failures.lockedUntil > now) throw new WorkError("host_link_enroll_locked", 429);
    const codeId = HostLinks.codeHash(normalizeCode(input.code)), code = this.store.get<StoredCode>(CODES, codeId);
    if (!code || code.expiresAt <= now || !this.owns(code.owner, code.agentId)) {
      const next = nextFailure(failures, now);
      this.store.transaction(() => {
        for (const { id, value } of this.store.entries<PairingFailures>(FAILURES)) if (activeFailures(value, now) !== value) this.store.delete(FAILURES, id);
        this.store.set(FAILURES, clientKey, next);
      });
      throw next.lockedUntil ? new WorkError("host_link_enroll_locked", 429) : new WorkError("host_link_code_invalid", 401);
    }
    const credential = `ahl_${randomBytes(32).toString("base64url")}`;
    const link: StoredLink = { id: `hl_${randomBytes(12).toString("hex")}`, owner: code.owner, agentId: code.agentId, credentialHash: digest(credential),
      deviceName: input.deviceName, platform: input.platform, runtime: input.runtime, createdAt: new Date(now).toISOString(), lastOnlineAt: null };
    const replaced = this.links().filter((item) => item.agentId === link.agentId);
    this.store.transaction(() => {
      this.store.delete(CODES, codeId); this.store.delete(FAILURES, clientKey);
      for (const item of replaced) this.store.delete(LINKS, item.id);
      this.store.set(LINKS, link.id, link);
    });
    for (const item of replaced) this.dropped(item);
    this.emit("enrolled", link);
    return { linkId: link.id, agentId: link.agentId, credential };
  }
  list(owner: string): HostLink[] { return this.links().filter((link) => link.owner === owner).map((link) => this.view(link)); }
  /** The link of an agent, if it has one. */
  get(agentId: string): HostLink | undefined {
    const link = this.links().find((item) => item.agentId === agentId);
    return link && this.view(link);
  }
  /** Whether the agent's linked Host is connected now. */
  online(agentId: string): boolean { return this.get(agentId)?.online === true; }
  /** Revoke one of the owner's links: its credential stops working and its connection is closed. */
  revoke(owner: string, linkId: string): void {
    const link = this.store.get<StoredLink>(LINKS, linkId);
    if (!link || link.owner !== owner) throw new WorkError("host_link_not_found", 404);
    this.store.delete(LINKS, link.id); this.dropped(link);
  }
  /** Remove the link of an agent that is being deleted. */
  remove(agentId: string): void {
    for (const link of this.links().filter((item) => item.agentId === agentId)) { this.store.delete(LINKS, link.id); this.dropped(link); }
    for (const { id, value } of this.store.entries<StoredCode>(CODES)) if (value.agentId === agentId) this.store.delete(CODES, id);
  }
  private dropped(link: StoredLink) {
    const connection = this.live.get(link.id);
    if (connection) { this.detach(link.id, connection); connection.ws.close(4003, "revoked"); }
    this.emit("revoked", link);
  }
  private linked(agentId: string, binding: string): StoredLink | undefined {
    const link = HostLinks.isBinding(binding) ? this.store.get<StoredLink>(LINKS, binding.slice(BINDING.length)) : undefined;
    return link?.agentId === agentId ? link : undefined;
  }
  /** `HostBindingProvider.assertReady`: 404 `host_link_not_found` for a link that no longer exists, 503 `host_offline` while it is not connected. */
  assertReady(agentId: string, binding: string): void {
    const link = this.linked(agentId, binding);
    if (!link) throw new WorkError("host_link_not_found", 404);
    if (!this.live.has(link.id)) throw new WorkError(HOST_OFFLINE, 503);
  }
  /** `HostBindingProvider.host`. A binding whose link is gone yields a Host that is never online. */
  host(agentId: string, binding: string): HostPort {
    const http = this.http(agentId, binding);
    return new LinkedHost(http, () => { const link = this.linked(agentId, binding); return Boolean(link && this.live.has(link.id)); });
  }
  /** `HostBindingProvider.http`: the link as a transport for the Host's v1 paths. */
  http(agentId: string, binding: string): HostTransport {
    return { baseUrl: binding, request: (path, options) => this.request(this.linked(agentId, binding)?.id, path, options?.body) };
  }
  private request(linkId: string | undefined, path: string, body?: unknown): Promise<any> {
    const connection = linkId === undefined ? undefined : this.live.get(linkId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) return Promise.reject(new ChannelHttpError(503, HOST_OFFLINE));
    const id = String(++this.sequence);
    const frame = JSON.stringify({ type: "request", id, method: body === undefined ? "GET" : "POST", path, ...(body === undefined ? {} : { body }) });
    if (Buffer.byteLength(frame) > HOST_LINK_FRAME_LIMIT) return Promise.reject(new ChannelHttpError(413, "host_link_request_too_large"));
    return new Promise((resolve, reject) => {
      const settle = (error: Error) => { if (connection.pending.delete(id)) { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => settle(new ChannelHttpError(504, "host_link_timeout")), this.requestTimeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      // A frame handed to the socket may have arrived: only a later lookup can tell.
      connection.ws.send(frame, (error) => { if (error) settle(new ChannelHttpError(502, "host_link_interrupted")); });
    });
  }
  /** HTTP upgrade for the link socket. Returns false for other paths. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (new URL(req.url ?? "/", "http://router.local").pathname !== HOST_LINK_SOCKET_PATH) return false;
    const credential = /^Bearer (ahl_[A-Za-z0-9_-]{16,200})$/.exec(req.headers.authorization ?? "")?.[1];
    const hash = credential && digest(credential), link = hash ? this.links().find((item) => item.credentialHash === hash) : undefined;
    if (!link || this.closed) { socket.end(`HTTP/1.1 ${link ? "503 Service Unavailable" : "401 Unauthorized"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return true; }
    this.sockets.handleUpgrade(req, socket, head, (ws) => this.accept(ws, link.id));
    return true;
  }
  private accept(ws: WebSocket, linkId: string) {
    const link = this.store.get<StoredLink>(LINKS, linkId);
    if (!link || this.closed) { ws.close(4003, "revoked"); return; }
    // One connection per link: the newer one is the machine as it is now.
    const previous = this.live.get(linkId);
    if (previous) { this.detach(linkId, previous); previous.ws.close(4001, "replaced"); }
    const connection: Connection = { ws, alive: true, pending: new Map(), heartbeat: setInterval(() => {
      if (!connection.alive) { ws.terminate(); return; }
      connection.alive = false; ws.ping();
    }, this.heartbeatMs) };
    connection.heartbeat.unref();
    this.live.set(linkId, connection);
    ws.on("pong", () => { connection.alive = true; });
    ws.on("error", () => { /* `close` follows. */ });
    ws.on("message", (data) => {
      connection.alive = true;
      let frame;
      try { frame = response.parse(JSON.parse(String(data))); } catch { return; }
      const pending = connection.pending.get(frame.id);
      if (!pending) return;
      connection.pending.delete(frame.id); clearTimeout(pending.timer);
      const value = frame.body as Record<string, unknown> | null;
      if (frame.status >= 400) pending.reject(new ChannelHttpError(frame.status, typeof value?.error === "string" ? value.error : `http_${frame.status}`, value?.nativeError));
      else if (!value || typeof value !== "object") pending.reject(new Error("invalid_service_response"));
      else pending.resolve(value);
    });
    ws.on("close", () => {
      if (!this.detach(linkId, connection) || this.closed) return;
      const current = this.seen(linkId);
      if (current) this.emit("offline", current);
    });
    ws.send(JSON.stringify({ type: "hello", linkId, agentId: link.agentId, heartbeatMs: this.heartbeatMs }));
    const current = this.seen(linkId)!;
    if (!previous) this.emit("online", current);
  }
  /** Records that the link's connection state changed now. */
  private seen(linkId: string): StoredLink | undefined {
    const link = this.store.get<StoredLink>(LINKS, linkId);
    if (!link) return undefined;
    const current = { ...link, lastOnlineAt: new Date().toISOString() };
    this.store.set(LINKS, linkId, current);
    return current;
  }
  /** Stops a connection's timers and fails what it was waiting for. True when it was the link's live connection. */
  private detach(linkId: string, connection: Connection): boolean {
    clearInterval(connection.heartbeat);
    for (const [id, pending] of connection.pending) {
      connection.pending.delete(id); clearTimeout(pending.timer);
      pending.reject(new ChannelHttpError(502, "host_link_interrupted"));
    }
    return this.live.get(linkId) === connection && this.live.delete(linkId);
  }
  close(): void {
    this.closed = true;
    for (const [linkId, connection] of this.live) { this.detach(linkId, connection); connection.ws.close(1012, "restart"); }
    this.sockets.close();
  }
}
