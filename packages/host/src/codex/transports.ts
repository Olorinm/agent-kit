import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import type { CodexJsonRpcTransport } from "./client.js";
import type { RpcMessage, RpcRequest, RpcResponse } from "./types.js";

export type CodexRemoteEndpoint =
  | { type: "websocket"; url: string; headers?: Record<string, string> }
  | { type: "unix"; path: string };

/** Connect to an existing native server. Closing this adapter never terminates that server. */
export async function connectCodexTransport(endpoint: CodexRemoteEndpoint, timeoutMs = 15_000): Promise<CodexJsonRpcTransport> {
  const messages = new Set<(message: RpcMessage) => void>();
  const closes = new Set<(error: Error) => void>();
  const buffered: RpcMessage[] = [];
  let closed: Error | undefined;
  const receive = (data: string) => {
    let value: RpcMessage;
    try { value = JSON.parse(data); } catch { finish(new Error("invalid_native_json")); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { finish(new Error("invalid_native_message")); return; }
    if (!messages.size) { if (buffered.length >= 1000) finish(new Error("native_message_buffer_limit")); else buffered.push(value); }
    else for (const handler of messages) handler(value);
  };
  let disconnect = () => {};
  const finish = (error: Error) => { if (closed) return; closed = error; disconnect(); for (const handler of closes) handler(error); };
  let send: (message: RpcRequest | RpcResponse) => void;
  if (endpoint.type === "websocket") {
    const url = new URL(endpoint.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid_codex_websocket_url");
    const socket = new WebSocket(url, { headers: endpoint.headers, handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 * 1024 });
    disconnect = () => socket.close();
    socket.on("message", data => receive(data.toString()));
    socket.on("close", () => finish(new Error("native_connection_closed")));
    socket.on("error", error => finish(error));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("native_connection_closed")));
    });
    send = message => socket.send(JSON.stringify(message));
  } else {
    const socket = createConnection(endpoint.path);
    const lines = createInterface({ input: socket });
    disconnect = () => { lines.close(); socket.destroy(); };
    lines.on("line", receive);
    socket.on("close", () => finish(new Error("native_connection_closed")));
    socket.on("error", finish);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { disconnect(); reject(new Error("native_connect_timeout")); }, timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
    send = message => { socket.write(`${JSON.stringify(message)}\n`); };
  }
  return {
    send(message) { if (closed) throw closed; send(message); },
    onMessage(handler) { messages.add(handler); for (const value of buffered.splice(0)) handler(value); return () => { messages.delete(handler); }; },
    onClose(handler) { closes.add(handler); if (closed) queueMicrotask(() => handler(closed!)); return () => { closes.delete(handler); }; },
    close() { finish(new Error("native_connection_closed_by_host")); },
  };
}
