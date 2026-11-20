import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { idSchema } from "./protocol.js";

/** Largest frame either side of a host link sends or accepts. */
export const LINK_FRAME_LIMIT = 16 * 1024 * 1024;
const ROUTER_BASE = "/_agent-router/v1";

/** What `agent-host link` stores in `<stateDirectory>/link.json`; `credential` is the device's secret. */
export const hostLinkFileSchema = z
  .object({
    url: z.url(),
    linkId: z.string().min(1).max(160),
    agentId: z.string().min(1).max(160),
    runtimeId: idSchema,
    credential: z.string().min(16).max(500),
  })
  .strict();
export type HostLinkFile = z.infer<typeof hostLinkFileSchema>;
export const hostLinkFile = (stateDirectory: string) => join(stateDirectory, "link.json");

/**
 * The Router's API base for an address a person typed: the origin, or the address that already ends in
 * `/_agent-router/v1`. A credential is only sent over TLS, or to this machine.
 */
export function routerBaseUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("invalid_router_url");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("router_url_requires_https");
  const base = url.href.replace(/\/+$/, "");
  return base.endsWith(ROUTER_BASE) ? base : base + ROUTER_BASE;
}

export async function readHostLink(stateDirectory: string): Promise<HostLinkFile | undefined> {
  try {
    return hostLinkFileSchema.parse(JSON.parse(await readFile(hostLinkFile(stateDirectory), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Exchange a pairing code for this device's credential and store it for `agent-host serve`. */
export async function enrollHostLink(input: {
  url: string;
  code: string;
  deviceName: string;
  platform: string;
  runtime: { id: string; kernel: string };
  stateDirectory: string;
}): Promise<HostLinkFile> {
  const url = routerBaseUrl(input.url);
  const response = await fetch(`${url}/host-links/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ code: input.code, deviceName: input.deviceName, platform: input.platform, runtime: input.runtime }),
  });
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : `http_${response.status}`);
  const link = hostLinkFileSchema.parse({ url, linkId: value?.linkId, agentId: value?.agentId, runtimeId: input.runtime.id, credential: value?.credential });
  const file = hostLinkFile(input.stateDirectory), pending = `${file}.${process.pid}.tmp`;
  await writeFile(pending, JSON.stringify(link, null, 2) + "\n", { mode: 0o600 });
  await chmod(pending, 0o600);
  await rename(pending, file);
  return link;
}

/**
 * `online`: the Router accepted the credential. `offline`: not connected, a retry is scheduled. `rejected`: the
 * Router refused the credential (revoked, or replaced by a newer pairing); retried at the slowest interval.
 * `replaced`: another process connected with the same credential; this one stops.
 */
export type HostLinkState = "online" | "offline" | "rejected" | "replaced";
export interface HostLinkOptions {
  /** The Router's API base, as `routerBaseUrl` returns it. */
  url: string;
  credential: string;
  /** The one runtime the Router reaches through this link. */
  runtimeId: string;
  onState?(state: HostLinkState): void;
  /** Reconnect delay bounds; the delay doubles from `minMs` (default 1 s) up to `maxMs` (default 30 s). */
  retry?: { minMs: number; maxMs: number };
}
export interface HostLinkRequest { method: string; path: string; body?: unknown }

const inbound = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), heartbeatMs: z.number().int().min(10).max(600_000) }),
  z.object({ type: z.literal("request"), id: z.string().min(1).max(100), method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(4_000), body: z.unknown().optional() }),
]);

/**
 * The Host's side of a host link: one WebSocket it opens to the Router and keeps open. The Router sends
 * `{type:"request", id, method, path, body?}` and receives `{type:"response", id, status, body}`. A silent
 * connection is dropped and every loss is retried with exponential backoff.
 */
export function connectHostLink(
  options: HostLinkOptions,
  handle: (request: HostLinkRequest) => Promise<{ status: number; body: unknown }>,
): { close(): void } {
  const target = `${options.url.replace(/^http/, "ws")}/host-links/socket`;
  const minMs = options.retry?.minMs ?? 1_000, maxMs = options.retry?.maxMs ?? 30_000;
  let socket: WebSocket | undefined, timer: NodeJS.Timeout | undefined, attempt = 0, closed = false, last: HostLinkState | undefined;
  const report = (state: HostLinkState) => {
    if (state === last) return;
    last = state;
    try { options.onState?.(state); } catch { /* A reporting error never breaks the link. */ }
  };
  const retry = (state: "offline" | "rejected") => {
    report(state);
    if (state === "rejected") attempt = 30;
    const delay = Math.min(maxMs, minMs * 2 ** Math.min(attempt++, 30)) * (0.8 + Math.random() * 0.4);
    timer = setTimeout(open, delay);
    timer.unref();
  };
  const open = () => {
    if (closed) return;
    const ws = (socket = new WebSocket(target, { headers: { authorization: `Bearer ${options.credential}` },
      maxPayload: LINK_FRAME_LIMIT, handshakeTimeout: 15_000 }));
    let refused = false, silence = 30_000, watchdog: NodeJS.Timeout | undefined;
    const heard = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), silence);
      watchdog.unref();
    };
    heard();
    ws.on("error", (error) => {
      const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
      refused = status === "401" || status === "403";
    });
    ws.on("ping", heard);
    ws.on("message", (data) => {
      heard();
      let frame;
      try { frame = inbound.parse(JSON.parse(String(data))); } catch { return; }
      if (frame.type === "hello") {
        attempt = 0;
        silence = frame.heartbeatMs * 2.5;
        heard();
        report("online");
        return;
      }
      const { id, method, path, body } = frame;
      void handle({ method, path, body }).then(({ status, body }) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let text = JSON.stringify({ type: "response", id, status, body });
        if (Buffer.byteLength(text) > LINK_FRAME_LIMIT)
          text = JSON.stringify({ type: "response", id, status: 413, body: { error: "response_too_large" } });
        ws.send(text);
      });
    });
    ws.on("close", (code) => {
      clearTimeout(watchdog);
      if (socket === ws) socket = undefined;
      if (closed) return;
      if (code === 4001) return report("replaced");
      retry(refused || code === 4003 ? "rejected" : "offline");
    });
  };
  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.terminate();
    },
  };
}
