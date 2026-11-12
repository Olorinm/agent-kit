import { attachmentsSchema } from "../attachments.js";
import { timingSafeEqual } from "node:crypto";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import { jsonRpcHandler, restHandler, type UserBuilder } from "@a2a-js/sdk/server/express";
import { WorkError } from "../execution/work.js";
import { MatrixConnector, delay } from "./connector.js";
import { MatrixA2AHandler, requestSignal } from "../matrix/gateway.js";
import { agentCardRoute } from "../matrix/agent-card.js";
import { decodeRequest, mxid } from "../matrix/protocol.js";

/** One agent's gateway: the work queue, approvals and status for its runtime instances, and the Matrix social and A2A routes. */
export function createConnectorApp(connector: MatrixConnector, apiToken: string, publicBaseUrl: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    requestSignal.run(abort.signal, next);
  });
  const expected = Buffer.from(apiToken);
  const auth: RequestHandler = (req, res, next) => {
    const value = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
    const supplied = Buffer.from(value);
    if (!value || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      res.status(401).json({ error: "unauthorized" }); return;
    }
    next();
  };
  app.get("/health/live", (_req, res) => res.json({ status: "ok", transport: "matrix" }));
  // A dormant connector (Matrix off) never syncs; its work queue is ready as soon as it runs.
  const ready = () => Boolean(connector.transport.dormant) || Date.now() - connector.lastSyncAt < 90_000;
  app.get("/health/ready", auth, (_req, res) => res.status(ready() ? 200 : 503).json({
    status: ready() ? "ready" : "syncing", userId: connector.userId,
    lastSyncAt: connector.lastSyncAt, lastError: connector.lastError, ...(connector.transport.dormant ? { matrix: "dormant" } : {}),
  }));
  app.use(auth);
  // ADR 0005 19.2: the Matrix social API needs a homeserver. Work, inbox, requests and status keep working.
  // Case-insensitive like Express routing, so no spelling of the path bypasses it (the transport refuses anyway).
  app.use(/^\/api\/(contacts|blocked|invites|conversations|messages|rooms|events)(\/|$)/i, (_req, res, next) => {
    if (connector.transport.dormant) { res.status(409).json({ error: "matrix_disabled" }); return; }
    next();
  });
  app.use("/api/work/:id/update", express.json({ limit: 6_000_000 }));
  app.use(express.json({ limit: "64kb" }));
  app.get("/api/status", (_req, res) => {
    const counts: Record<string, Record<string, number>> = {};
    for (const collection of ["incoming", "outgoing", "outbox"]) {
      counts[collection] = {};
      for (const { value } of connector.store.entries<{ status: string }>(collection)) {
        counts[collection][value.status] = (counts[collection][value.status] ?? 0) + 1;
      }
    }
    res.json({ userId: connector.userId, execution: connector.cli ? "cli" : "a2a", lastSyncAt: connector.lastSyncAt, lastError: connector.lastError, counts,
      outboxErrors: connector.store.entries<{ status: string; error?: string }>("outbox")
        .filter((r) => r.value.status === "queued" && r.value.error).map((r) => ({ id: r.id, error: r.value.error })),
      protocolErrors: connector.store.entries("protocol_errors").slice(-20).map((r) => r.value) });
  });
  app.get("/api/contacts", (_req, res) => res.json({ data: connector.contacts() }));
  const social = () => { if (!connector.social) throw new Error("native_matrix_client_unavailable"); return connector.social; };
  app.post("/api/contacts", async (req, res) => {
    const contact = z.object({ address: mxid, note: z.string().max(500).default(""),
      tags: z.array(z.string().max(80)).max(32).default([]),
      receive: z.enum(["allow", "ask", "deny"]).default("ask"),
      execution: z.enum(["allow", "ask", "deny"]).default("ask") }).strict().parse(req.body);
    await connector.updateContact(contact);
    if (contact.receive === "deny" && connector.social) await connector.social.block(contact.address, true);
    res.status(201).json({ data: connector.contact(contact.address) });
  });
  app.delete("/api/contacts/:address", async (req, res) => { await connector.removeContact(mxid.parse(req.params.address)); res.status(204).end(); });
  app.get("/api/blocked", (_req, res) => res.json({ data: social().blocked() }));
  app.post("/api/blocked/:address", async (req, res) => { await social().block(mxid.parse(req.params.address), true); res.status(204).end(); });
  app.delete("/api/blocked/:address", async (req, res) => { await social().block(mxid.parse(req.params.address), false); res.status(204).end(); });
  app.get("/api/requests", (_req, res) => res.json({ data: connector.pending() }));
  app.post("/api/requests/:id/approve", (req, res) => {
    if (connector.cli?.has(req.params.id)) connector.cli.approve(req.params.id); else connector.approve(req.params.id);
    res.status(204).end();
  });
  app.post("/api/requests/:id/reject", (req, res) => {
    if (connector.cli?.has(req.params.id)) connector.cli.reject(req.params.id); else connector.deny(req.params.id);
    res.status(204).end();
  });
  const work = () => { if (!connector.cli) throw new WorkError("execution_is_bound_to_a2a_service"); return connector.cli; };
  app.get("/api/inbox", (req, res) => {
    const all = z.enum(["true", "false"]).default("false").parse(req.query.all) === "true";
    res.json({ data: work().list(all), requests: connector.pending().filter((r) => r.request.operation === "send").map((r) => ({
      id: r.id, from: r.sender, conversation: r.room, status: r.status === "uncertain" ? "uncertain" : "approval_required",
      reason: r.error ?? null, input: r.request.body.message, contextId: decodeRequest(r.request.body).message!.contextId,
    })) });
  });
  app.get("/api/work/:id", (req, res) => res.json(work().inspect(req.params.id)));
  app.post("/api/work/claim", async (req, res) => {
    const body = z.object({ worker: z.string().trim().min(1).max(160), id: z.string().min(1).max(255).optional(),
      wait: z.number().int().min(0).max(60).default(0) }).strict().parse(req.body);
    const deadline = Date.now() + body.wait * 1000;
    do {
      if (res.destroyed) return;
      res.locals.validateWorker?.();
      await connector.work();
      res.locals.validateWorker?.();
      const result = work().claim(res.locals.workerId ?? body.worker, body.id, Boolean(res.locals.workerId));
      if (result) { res.json(result); return; }
      if (Date.now() >= deadline) break;
      await delay(250);
    } while (!res.destroyed);
    if (!res.destroyed) res.json(null);
  });
  app.post("/api/work/:id/update", async (req, res) => {
    const body = z.object({ action: z.enum(["progress", "defer", "reply", "need-input", "fail", "cancelled"]),
      text: z.string().max(32000).default(""), data: z.record(z.string(), z.unknown()).optional(), attachments: attachmentsSchema.optional() }).strict().parse(req.body);
    if (body.action !== "cancelled" && !body.text.trim() && !(body.action === "reply" && (body.data || body.attachments?.length))) {
      throw new WorkError("message_required", 400);
    }
    res.locals.validateWorker?.();
    const result = work().update(req.params.id, body.action, body.text, body.data, res.locals.workerId, body.attachments);
    await connector.work(); res.json(result);
  });
  app.get("/api/invites", (_req, res) => res.json({ data: connector.store.entries("invites").map((r) => r.value) }));
  app.post("/api/invites/:room/accept", async (req, res) => {
    if (!connector.store.get("invites", req.params.room)) { res.status(404).json({ error: "invite_not_found" }); return; }
    if (connector.social) await connector.social.accept(req.params.room); else await connector.transport.join(req.params.room);
    res.status(204).end();
  });
  app.post("/api/invites/:room/reject", async (req, res) => { await social().leave(req.params.room); res.status(204).end(); });
  app.get("/api/conversations", (_req, res) => res.json({ data: connector.social?.conversations() ?? connector.store.entries("conversations").map((r) => r.value) }));
  app.post("/api/conversations", async (req, res) => {
    const body = z.object({ address: mxid }).strict().parse(req.body);
    res.status(201).json(await connector.conversation(body.address));
  });
  app.post("/api/messages", async (req, res) => {
    const body = z.object({ address: mxid, text: z.string().min(1), contextId: z.string().min(1).optional(), messageId: z.string().min(1).max(255).optional() }).strict().parse(req.body);
    res.status(202).json(await connector.say(body.address, body.text, body.contextId, body.messageId));
  });
  app.get("/api/rooms/:room/history", async (req, res) => {
    const from = z.string().optional().parse(req.query.from);
    res.json(await social().history(req.params.room, from));
  });
  app.post("/api/rooms/:room/read", async (req, res) => {
    const body = z.object({ eventId: z.string().optional() }).strict().parse(req.body ?? {});
    await social().read(req.params.room, body.eventId); res.status(204).end();
  });
  app.post("/api/rooms/:room/leave", async (req, res) => { await social().leave(req.params.room); res.status(204).end(); });
  app.get("/api/events", async (req, res) => {
    let cursor = z.coerce.number().int().min(0).safeParse(req.query.since ?? connector.store.get("meta", "timeline_cursor") ?? 0);
    if (!cursor.success) { res.status(400).json({ error: "invalid_cursor" }); return; }
    const room = z.string().optional().parse(req.query.room);
    const client = social(); let after = cursor.data;
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders();
    while (!res.destroyed) {
      const entries = client.entries(after, room);
      for (const entry of entries) {
        after = entry.cursor; res.write(`id: ${after}\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      if (!entries.length) res.write(": keepalive\n\n");
      await delay(1000);
    }
  });
  const handlers = new Map<string, ReturnType<typeof suite>>();
  const userBuilder: UserBuilder = async () => ({ isAuthenticated: true, userName: connector.userId });
  function suite(target: string) {
    const handler = new MatrixA2AHandler(connector, target, publicBaseUrl);
    return { card: agentCardRoute(handler),
      rest: restHandler({ requestHandler: handler, userBuilder }), rpc: jsonRpcHandler({ requestHandler: handler, userBuilder }) };
  }
  const route = (kind: "card" | "rest" | "rpc"): RequestHandler => (req, res, next) => {
    const target = mxid.parse(req.params.address);
    let handler = handlers.get(target);
    if (!handler) { handler = suite(target); handlers.set(target, handler); }
    return handler[kind](req, res, next);
  };
  app.use("/agents/:address/.well-known/agent-card.json", route("card"));
  app.use("/agents/:address/a2a/rest", route("rest"));
  app.use("/agents/:address/a2a/jsonrpc", route("rpc"));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") { res.status(413).json({ error: "request_too_large" }); return; }
    if (error instanceof WorkError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof z.ZodError ? "invalid_request" : "operation_failed" });
  });
  return app;
}
