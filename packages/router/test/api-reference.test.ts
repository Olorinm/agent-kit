import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter, routerApiReference } from "../src/server.js";
import { SOCKET_PATH, routerRouteScope } from "../src/api-reference.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

interface Layer { route?: { path: string; methods: Record<string, boolean> }; handle: { stack?: Layer[] } }
/**
 * Every `(method, path)` registered on the Router app. Express keeps a mounted router's path only as a matcher, so the
 * mount path of each nested router is recorded from the `use` call that mounts it while the app is built.
 */
function registeredRoutes() {
  const mounts = new Map<unknown, string>();
  const use = express.Router.prototype.use;
  vi.spyOn(express.Router.prototype, "use").mockImplementation(function (this: express.Router, ...args: unknown[]) {
    const path = typeof args[0] === "string" ? args[0].replace(/\/$/, "") : "";
    for (const handler of args.flat()) if (typeof handler === "function" && Array.isArray((handler as { stack?: unknown }).stack)) mounts.set(handler, path);
    return Reflect.apply(use, this, args) as express.Router;
  });
  const stateDir = mkdtempSync(join(tmpdir(), "router-api-reference-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const router = createRouter({ serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1", stateDir });
  cleanup.push(() => router.close());
  const routes: string[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      else if (Array.isArray(layer.handle.stack)) {
        if (!mounts.has(layer.handle)) throw new Error("nested_router_without_recorded_mount_path");
        walk(layer.handle.stack, prefix + mounts.get(layer.handle));
      }
    }
  };
  walk((router.app as unknown as { router: { stack: Layer[] } }).router.stack, "");
  return { router, routes };
}

describe("routerApiReference", () => {
  it("lists exactly the routes registered on the Router app, plus the event socket", () => {
    const { router, routes } = registeredRoutes();
    // The walk reached the nested routers: connection routes and the web API.
    expect(routes).toContain("GET /_agent-router/v1/connection-options");
    expect(routes).toContain("PATCH /_agent-router/v1/web/groups/:roomId");
    expect(new Set(routes).size).toBe(routes.length);
    const documented = routerApiReference.map((route) => `${route.method} ${route.path}`);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.filter((route) => route !== `GET ${SOCKET_PATH}`).sort()).toEqual([...routes].sort());
    // The socket is served by the upgrade handler, not by an Express route.
    const upgrade = (url: string) => {
      const socket = { end: vi.fn() };
      return { handled: router.upgrade({ url, headers: {} } as IncomingMessage, socket as unknown as Duplex, Buffer.alloc(0)), socket };
    };
    const socket = upgrade(SOCKET_PATH + "?ticket=unknown");
    expect(socket.handled).toBe(true);
    expect(socket.socket.end).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"));
    expect(upgrade("/_agent-router/v1/web/other").handled).toBe(false);
    expect(documented).toContain(`GET ${SOCKET_PATH}`);
  });

  it("describes every route in one sentence, as JSON, with the body schema of validated requests", () => {
    expect(JSON.parse(JSON.stringify(routerApiReference))).toEqual(routerApiReference);
    for (const route of routerApiReference) {
      expect(route.summary, route.path).toMatch(/^[A-Z].*\.$/);
      if (route.body !== undefined) expect(route.body, route.path).toMatchObject({ $schema: expect.stringContaining("json-schema.org") });
    }
    const find = (method: string, path: string) => routerApiReference.find((route) => route.method === method && route.path === path)!;
    expect(find("PUT", "/_agent-router/v1/agents/:agentId/connections/:connectionId/access").body).toMatchObject({
      type: "object", required: ["groupIds", "peerAddresses"], additionalProperties: false,
      properties: { groupIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 512 } } } });
    expect(find("POST", "/_agent-router/v1/agents").body).toMatchObject({ type: "object", required: ["name"] });
    expect(find("POST", "/_agent-router/v1/agents/:agentId/check").body).toMatchObject({ type: "object", additionalProperties: false });
    expect(find("DELETE", "/_agent-router/v1/agents/:agentId/connections/:connectionId")).not.toHaveProperty("body");
  });

  it("marks what a default service token may request: reads and the operator's four writes", () => {
    const writes = routerApiReference.filter((route) => route.operator && route.method !== "GET").map((route) => `${route.method} ${route.path}`);
    expect(writes.sort()).toEqual(["POST /_agent-router/v1/web/chats/:chatId/messages", "POST /_agent-router/v1/web/chats/:chatId/read",
      "POST /_agent-router/v1/web/chats/dm", "POST /_agent-router/v1/web/socket-tickets"]);
    for (const route of routerApiReference) if (route.method === "GET") expect(route.operator, route.path).toBe(true);
  });

  it("gives every route a scope: reads are read, and what an operator may write without a grant is read or chat", () => {
    for (const route of routerApiReference) {
      expect(["read", "chat", "approve", "manage", "owner"], route.path).toContain(route.scope);
      if (route.method === "GET") expect(route.scope, route.path).toBe("read");
    }
    const scopes = Object.fromEntries(routerApiReference.filter((route) => route.operator && route.method !== "GET").map((route) => [`${route.method} ${route.path}`, route.scope]));
    // The two writes of substance are `chat`; an operator makes them without a grant all the same.
    expect(scopes).toEqual({ "POST /_agent-router/v1/web/socket-tickets": "read", "POST /_agent-router/v1/web/chats/:chatId/read": "read",
      "POST /_agent-router/v1/web/chats/dm": "chat", "POST /_agent-router/v1/web/chats/:chatId/messages": "chat" });
    // Only the signed-in owner: purging history and everything that links an identity.
    expect(routerApiReference.filter((route) => route.scope === "owner").map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "DELETE /_agent-router/v1/web/identities/:identityId", "DELETE /_agent-router/v1/web/identities/pairing-codes/:codeId",
      "POST /_agent-router/v1/web/chats/:chatId/purge", "POST /_agent-router/v1/web/identities/pairing-codes"]);
    expect(routerApiReference.filter((route) => route.scope === "approve").map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "POST /_agent-router/v1/agents/:agentId/communication/calls/:callId/result", "POST /_agent-router/v1/agents/:agentId/communication/runs/:claimId/calls/:callId/result",
      "POST /_agent-router/v1/web/chats/:chatId/cards/:cardId/answer"]);
  });

  it("finds the scope of a concrete request path, exactly", () => {
    const root = "/_agent-router/v1";
    // Every entry resolves to its own scope when each `:param` is filled in.
    for (const route of routerApiReference) expect(routerRouteScope(route.method, route.path.replace(/:[A-Za-z]+/g, "x1")), `${route.method} ${route.path}`).toBe(route.scope);
    expect(routerRouteScope("GET", "/health/live")).toBe("read");
    expect(routerRouteScope("POST", `${root}/agents`)).toBe("manage");
    expect(routerRouteScope("DELETE", `${root}/agents/agt_1`)).toBe("manage");
    expect(routerRouteScope("POST", `${root}/web/chats/dm`)).toBe("chat");
    expect(routerRouteScope("POST", `${root}/web/chats/dm%3Aagent/messages`)).toBe("chat");
    expect(routerRouteScope("POST", `${root}/web/chats/c/cards/k/answer`)).toBe("approve");
    expect(routerRouteScope("POST", `${root}/web/chats/c/purge`)).toBe("owner");
    // A literal segment wins nothing over a parameter of another method or depth: these are distinct routes.
    expect(routerRouteScope("GET", `${root}/web/identities/pairing-codes`)).toBe("read");
    expect(routerRouteScope("POST", `${root}/web/identities/pairing-codes`)).toBe("owner");
    expect(routerRouteScope("DELETE", `${root}/web/identities/pairing-codes`)).toBe("owner");
    // An encoded slash stays inside its segment and never stands for a separator.
    expect(routerRouteScope("POST", `${root}/web/chats/a%2Fb/messages`)).toBe("chat");
    for (const [method, path] of [
      ["POST", `${root}/web/chats/c/messages/extra`], ["POST", `${root}/web/chats/c/messages/`], ["POST", `${root}/web/chats/dm/`], ["POST", `${root}/web/chats//messages`],
      ["POST", `${root}/web/chats/a/b/messages`], ["POST", `${root}/web/chats%2Fdm`], ["POST", `${root}/web/chats/c%2Fmessages`], ["POST", `${root}/web/chats/c/messages?x=1`],
      ["POST", `${root}/web/chats/c/messages#x`], ["POST", `${root}/web/chats/c/Messages`], ["POST", `${root}/WEB/chats/c/messages`], ["POST", `/prefix${root}/web/chats/dm`],
      ["POST", `${root}/web/chats/dm\n`], ["POST", `${root}/web/chats/c/purge\n`], ["POST", "/_other/v1/web/chats/dm"], ["POST", `${root}/web/chats`], ["POST", `${root}`], ["POST", ""], ["POST", "/"],
      ["PUT", `${root}/web/chats/c/messages`], ["DELETE", `${root}/web/chats/dm`], ["post", `${root}/web/chats/dm`], ["HEAD", `${root}/agents`], ["GET", `${root}/web/socket-tickets`],
      ["POST", `${root}/agents/a/connections/c/access`], ["POST", "/health/live"], ["GET", "/health/liveX"], ["GET", "/healthXlive"],
    ] as const) expect(routerRouteScope(method, path), `${method} ${path}`).toBeUndefined();
  });
});
