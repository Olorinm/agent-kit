import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ManagedService,
  createManagedApp,
  type ManagedAgent,
} from "../src/service/managed.js";
import { WorkError } from "../src/execution/work.js";
import { ConnectionSetup } from "../src/connections/connections.js";
import { ConnectionConfiguration } from "../src/connections/configuration.js";
import { createConnections } from "../src/connections/routes.js";
import { privateFile } from "../src/services/feishu/cli.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const alice = "@alice:example.test",
  bob = "@bob:example.test",
  root = "/_agent-router/v1",
  inbox = "agent@example.test";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "router-onboarding-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = {
    serverName: "example.test",
    publicUrl: "http://127.0.0.1/_agent-router/v1",
    stateDir: directory,
  };
  const tokens = new Map<string, string>([["fixture-alice", alice], ["fixture-bob", bob]]),
    requests: Array<{ url: string; body: any }> = [],
    hostRuns = new Map<string, any>(),
    actualFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (new URL(url).origin === "https://host.fixture") {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-host-token",
        );
        requests.push({ url, body });
        if (url.endsWith("/health"))
          return Response.json({ protocolVersion: 1, capabilities: { runIdempotency: true } });
        if (url.endsWith("/runtimes/inspect"))
          return Response.json({ id: body.runtimeId, available: true });
        if (url.endsWith("/runtimes"))
          return Response.json({
            runtimes: [{ id: "personal" }, { id: "other" }],
          });
        if (url.endsWith("/runs") && init?.method === "POST") {
          const previous = body.requestKey && [...hostRuns.values()].find(run => run.runtimeId === body.runtimeId && run.requestKey === body.requestKey);
          if (previous) {
            const { id: _id, status: _status, answer: _answer, ...original } = previous;
            return JSON.stringify(original) === JSON.stringify(body) ? Response.json(previous)
              : Response.json({ error: "request_key_conflict" }, { status: 409 });
          }
          const run = {
            ...body,
            id: randomUUID(),
            status: "completed",
            answer: "Fixture reply: " + body.input,
          };
          hostRuns.set(run.id, run);
          return Response.json(run, { status: 202 });
        }
        if (new URL(url).pathname.endsWith("/runs/by-request")) {
          const query = new URL(url).searchParams;
          return Response.json({ run: [...hostRuns.values()].find(run => run.runtimeId === query.get("runtimeId") && run.requestKey === query.get("requestKey")) ?? null });
        }
        if (url.includes("/events?"))
          return Response.json({
            events: [],
            cursor: 0,
            hasMore: false,
            historyTruncated: false,
          });
        if (url.includes("/runs/"))
          return Response.json(hostRuns.get(url.split("/").at(-1)!));
        throw new Error("unexpected_host_fixture_request");
      }
      if (new URL(url).origin === "https://mail.fixture") {
        // The mail service of `connect`: the inbox exists and has no events.
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-mail-key",
        );
        const { pathname, searchParams } = new URL(url);
        if (pathname === "/v0/inboxes/" + encodeURIComponent(inbox))
          return Response.json({ inbox_id: inbox });
        if (pathname.endsWith("/events/lifecycle"))
          return Response.json({ events: [], next_cursor: Number(searchParams.get("after")) });
        throw new Error("unexpected_mail_fixture_request");
      }
      if (new URL(url).hostname !== "127.0.0.1")
        throw new Error("unexpected_external_request");
      return actualFetch(input, init);
    },
  );
  const optionsFile = join(directory, "options.json");
  privateFile(join(directory, "host-token"), "fixture-host-token");
  privateFile(optionsFile, { mailServices: [{ id: "mail", label: "Mail", url: "https://mail.fixture" }] });
  const settings = new ConnectionConfiguration(directory, optionsFile);
  const service = new ManagedService(config, {
    authenticate: async (token) => {
      const owner = tokens.get(token);
      if (!owner) throw new WorkError("account_session_invalid", 401);
      return owner;
    },
    configure: settings.factory,
  });
  settings.attach(service);
  cleanup.push(() => service.close());
  const app = express(),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  config.publicUrl = base + "/_agent-router/v1";
  const setup = createConnections(service, settings);
  app.use(createManagedApp(service, setup.router));
  cleanup.push(() => setup.close());
  function client(name: string) {
    return {
      async call(method: string, path: string, body?: unknown, token = "fixture-" + name) {
        const response = await fetch(base + root + path, {
          method,
          headers: {Authorization: "Bearer " + token, "Content-Type": "application/json"},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        return {status: response.status, data: response.status === 204 ? null : await response.json() as any};
      },
      api(path: string, body?: unknown, token?: string) {
        return this.call(body === undefined ? "GET" : "POST", path, body, token);
      },
    };
  }
  return {
    directory,
    config,
    base,
    service,
    settings,
    requests,
    hostRuns,
    tokens,
    client,
    /** Connect the agent's mailbox: a real connection kind whose provider is the fixture above. */
    connect: (agent: ManagedAgent, name = "alice") => client(name).api("/agents/" + agent.id + "/connections",
      { kind: "grove-mail", serviceId: "mail", inboxId: inbox, apiKey: "fixture-mail-key", ownerEmail: "alice@example.test" }),
    host: (agent: ManagedAgent, runtimeId = "personal") => settings.edit(agent.owner, agent.id, config => {
      config.host = { url: "https://host.fixture", tokenFile: join(directory, "host-token"), runtimeId, instanceName: "channel-host", instructions: "" };
    }),
  };
}

describe("managed CLI setup", () => {
  it("requires the existing owner account, limits assigned services and does not serve a UI", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    expect((await fetch(f.base + "/_agent-router/setup")).status).toBe(404);
    expect((await fetch(f.base + root + "/connection-options")).status).toBe(401);
    const options = (await a.api("/connection-options")).data;
    expect(options).not.toHaveProperty("environments");
    expect(options).not.toHaveProperty("hosts");
    expect(JSON.stringify(options)).not.toContain("fixture-host-token");
    expect(JSON.stringify(options)).not.toContain(f.directory);
    expect(f.service.agents()).toHaveLength(0);
    const agent = (await a.api("/agents", {name: "helper"})).data;
    expect((await a.api("/agents", {name: "helper"})).data.id).toBe(agent.id);
    const path = "/agents/" + agent.id;
    expect((await b.api(path)).status).toBe(404);
    const instance = f.service.issue(agent.id, "worker");
    expect((await a.api(path, undefined, instance.token)).status).toBe(401);
    f.tokens.delete("fixture-alice");
    expect((await a.api(path)).status).toBe(401);
  });
  it("accepts existing app recovery only for the owning account and validates its App ID", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", { name: "helper" })).data, path = "/agents/" + agent.id;
    const begin = vi.spyOn(ConnectionSetup.prototype, "begin").mockReturnValue({ id: "job", kind: "feishu", state: "starting", expiresAt: new Date().toISOString() });
    expect((await b.api(path + "/connections", { kind: "feishu", appId: "cli_fixture" })).status).toBe(404);
    expect((await a.api(path + "/connections", { kind: "feishu", appId: "bad id" })).status).toBe(400);
    expect((await a.api(path + "/connections", { kind: "feishu", personalTools: true })).status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
    expect((await a.api(path + "/connections", { kind: "feishu", appId: "cli_fixture", domain: "lark" })).status).toBe(202);
    expect(begin).toHaveBeenCalledWith(alice, agent.id, "feishu", { kind: "feishu", appId: "cli_fixture", domain: "lark" });
    expect((await b.api(path + "/connection-jobs")).status).toBe(404);
  });
  it("protects another Agent's saved app even when its binding did not complete", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", { name: "helper" })).data;
    const other = (await b.api("/agents", { name: "other" })).data;
    const directory = join(f.settings.agentDirectory(other.id), "feishu");
    privateFile(join(directory, "app-secret"), "fixture-secret");
    privateFile(join(directory, "credentials.json"), { version: 1, appId: "cli_existing", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_other" });
    expect(() => f.settings.assertFeishuAvailable("cli_existing", agent.id)).toThrow("feishu_app_already_assigned");
    expect(() => f.settings.assertFeishuAvailable("cli_new", agent.id)).not.toThrow();
    expect(() => f.settings.assertFeishuAvailable("cli_existing", other.id)).not.toThrow();
  });
  it("configures an optional Host and a mail channel, persists private files and protects active work", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", {name: "helper"})).data;
    const path = "/agents/" + agent.id;
    expect((await a.api(path + "/configuration")).data.connections).toEqual([]);
    const other = (await b.api("/agents", {name: "helper"})).data;
    expect((await a.api(path + "/host", {hostId: "personal"})).status).toBe(404);
    await f.host(agent);
    expect(f.settings.configuration(agent)?.connections).toEqual([]);
    expect(await a.api(path + "/connections", {kind: "matrix"})).toEqual({status: 400, data: {error: "invalid_request"}});
    expect((await f.connect(other)).status).toBe(404);
    expect((await f.connect(agent)).status).toBe(200);
    expect(await f.connect(agent)).toEqual({status: 409, data: {error: "platform_already_connected"}});
    const file = join(f.settings.agentDirectory(agent.id), "channels.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.settings.agentDirectory(agent.id), "mail-key")).mode & 0o777).toBe(0o600);
    const restored = new ConnectionConfiguration(f.directory, join(f.directory, "options.json"));
    expect(restored.configuration(agent)?.host?.runtimeId).toBe("personal");
    expect(restored.configuration(agent)?.connections[0]).toMatchObject({id: "mail", kind: "grove-mail", ownerAddresses: ["alice@example.test"]});
    expect((await a.api(path + "/configuration")).data.communication.connections[0].started).toBe(true);
    const checks = (await a.api(path + "/check", {})).data.checks;
    expect(checks.find((c: any) => c.kind === "host").status).toBe("verified");
    expect(checks.find((c: any) => c.kind === "grove-mail")).toMatchObject({connectionId: "mail", status: "verified", detail: expect.stringContaining("inbox access verified")});
    expect(f.hostRuns.size).toBe(0);
    const runtime = await f.service.runtime(agent.id), before = readFileSync(file, "utf8");
    runtime.store.set("communication_runs", "uncertain", {phase: "unknown"});
    await expect(f.host(agent, "other")).rejects.toThrow("agent_has_active_or_unknown_run");
    expect(readFileSync(file, "utf8")).toBe(before);
    runtime.store.delete("communication_runs", "uncertain");
    const original = f.settings.factory;
    await expect(f.service.configureRuntime(agent.id, async () => ({
      start: async () => {throw new Error("fixture_start_failure");}, stop: async () => {},
      status: () => ({}), resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {},
    }), original)).rejects.toThrow("fixture_start_failure");
    expect((await a.api(path + "/configuration")).data.communication.connections[0].started).toBe(true);
  });
  it("executes owner work on the selected Host, continues its session and refuses another runtime afterwards", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", {name: "helper"})).data;
    await f.host(agent);
    const work = "/agents/" + agent.id + "/communication/work-events", input = {eventId: "first", input: "remember 42"};
    expect((await b.api(work, input)).status).toBe(404);
    const first = await a.api(work, input);
    expect(first.status).toBe(202);
    expect((await a.api(work, input)).data.taskId).toBe(first.data.taskId);
    await vi.waitFor(async () => expect((await a.api(work + "/first")).data).toMatchObject({status: "completed", answer: "Fixture reply: remember 42"}), {timeout: 7000});
    expect((await a.api(work, {eventId: "second", input: "continue", sessionId: first.data.sessionId})).status).toBe(202);
    await vi.waitFor(async () => expect((await a.api(work + "/second")).data).toMatchObject({status: "completed", answer: "Fixture reply: continue"}), {timeout: 7000});
    expect([...f.hostRuns.values()][1].sessionId).toBe([...f.hostRuns.values()][0].sessionId);
    await expect(f.host(agent, "other")).rejects.toThrow("host_binding_configuration_changed");
    expect(f.hostRuns.size).toBe(2);
  }, 20000);
});

it("explicit Host replacement resets native execution only and refuses another owner or an unresolved run", async () => {
  const f = await fixture(), agent = await f.service.create(alice, "replace-test");
  await f.host(agent);
  expect((await f.connect(agent)).status).toBe(200);
  const old = structuredClone(f.settings.configuration(agent)!);
  expect(old.connections.map((connection) => connection.kind)).toEqual(["grove-mail"]);
  const store = (await f.service.runtime(agent.id)).store;
  const next = { ...old.host!, runtimeId: "other", instructions: "fresh environment" };
  store.set("execution_sessions", "context", { sessionId: "old-native-session", runtimeId: "personal" });
  store.set("communication_runs", "old", { phase: "unknown" });
  store.set("communication_messages", "message", { text: "keep channels" });
  await expect(f.settings.replaceHost(bob, agent.id, next)).rejects.toThrow();
  await expect(f.settings.replaceHost(alice, agent.id, next)).rejects.toThrow("agent_has_active_or_unknown_run");
  expect(store.get("execution_sessions", "context")).toBeDefined();
  store.set("communication_runs", "old", { phase: "finished" });
  await f.settings.replaceHost(alice, agent.id, next);
  expect(store.entries("execution_sessions")).toEqual([]);
  expect(store.entries("communication_runs")).toEqual([]);
  expect(store.get("communication_messages", "message")).toEqual({ text: "keep channels" });
  expect(f.settings.configuration(agent)!.connections).toEqual(old.connections);
  expect(f.settings.configuration(agent)!.host).toEqual(next);
  await expect(f.settings.replaceHost(alice, agent.id, next)).rejects.toThrow("host_replacement_requires_new_binding");
});

it("failed replacement restores execution sessions and the original channel configuration", async () => {
  const f = await fixture(), agent = await f.service.create(alice, "replace-failure");
  await f.host(agent);
  const prior = structuredClone(f.settings.configuration(agent)!);
  const store = (await f.service.runtime(agent.id)).store;
  store.set("execution_sessions", "context", { sessionId: "keep-native", runtimeId: "personal" });
  store.set("communication_runs", "finished", { phase: "finished" });
  const original = (f.settings as any).runtime.bind(f.settings);
  vi.spyOn(f.settings as any, "runtime").mockImplementation((...args: any[]) => {
    if (args[2]?.host?.runtimeId === "other") throw new Error("fixture_replacement_failed");
    return original(...args);
  });
  await expect(f.settings.replaceHost(alice, agent.id, { ...prior.host!, runtimeId: "other" })).rejects.toThrow("fixture_replacement_failed");
  expect(f.settings.configuration(agent)).toEqual(prior);
  expect(store.get("execution_sessions", "context")).toEqual({ sessionId: "keep-native", runtimeId: "personal" });
  expect(store.get("communication_runs", "finished")).toEqual({ phase: "finished" });
});

describe("connection management over HTTP", () => {
  /** A Bark connection written by the operator: its key file is not one of Router's own. */
  const bark = (f: Awaited<ReturnType<typeof fixture>>, agent: ManagedAgent) => {
    const file = join(f.settings.agentDirectory(agent.id), "operator-bark-key");
    privateFile(file, "fixture-device-key");
    return f.settings.edit(agent.owner, agent.id, (config) => {
      config.connections.push({ id: "bark", kind: "bark", server: "http://127.0.0.1:9", deviceKeyFile: file, ownerAddresses: [], peerAddresses: [], groupIds: [],
        title: "Agent", preview: true, maxLength: 300, notify: { replies: true, replyAfterSeconds: 30, questions: true, schedules: true } });
    }).then(() => file);
  };
  const peer = (id: string) => ({ externalId: id, sender: "peer@example.test", scope: "direct" as const, threadId: "thread-" + id, text: "hello",
    reply: { target: "peer@example.test", messageId: id, data: {} } });

  it("removes a configured connection with the credentials Router saved, keeps history and lets the platform connect again", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", {name: "helper"})).data, path = "/agents/" + agent.id;
    expect((await f.connect(agent)).status).toBe(200);
    const operatorFile = await bark(f, agent), directory = f.settings.agentDirectory(agent.id);
    const runtime = await f.service.runtime(agent.id);
    runtime.extension!.communication!.receive("mail", { ...peer("kept"), sender: "alice@example.test" });
    expect(await a.call("DELETE", path + "/connections/unknown")).toEqual({status: 404, data: {error: "connection_not_found"}});
    // The built-in owner surfaces are registered by Router, not configured: they cannot be removed.
    for (const builtin of ["web", "room"])
      expect(await a.call("DELETE", path + "/connections/" + builtin)).toEqual({status: 404, data: {error: "connection_not_found"}});
    expect(await b.call("DELETE", path + "/connections/mail")).toEqual({status: 404, data: {error: "agent_not_found"}});
    runtime.store.set("communication_runs", "uncertain", {phase: "unknown"});
    expect(await a.call("DELETE", path + "/connections/mail")).toEqual({status: 409, data: {error: "agent_has_active_or_unknown_run"}});
    expect(existsSync(join(directory, "mail-key"))).toBe(true);
    expect((await a.api(path + "/configuration")).data.communication.connections.find((item: any) => item.id === "mail").started).toBe(true);
    runtime.store.delete("communication_runs", "uncertain");
    const removed = await a.call("DELETE", path + "/connections/mail");
    expect(removed).toMatchObject({status: 200, data: {agent: {id: agent.id}, host: null, connections: [{id: "bark", kind: "bark"}]}});
    expect(existsSync(join(directory, "mail-key"))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, "channels.json"), "utf8")).agents[0].connections.map((item: any) => item.id)).toEqual(["bark"]);
    const live = (await a.api(path + "/configuration")).data.communication.connections.map((item: any) => item.id);
    expect(live).toContain("web");
    expect(live).not.toContain("mail");
    // The message received over the removed connection is still in the agent's ledger.
    expect((await f.service.runtime(agent.id)).extension!.communication!.ledger.claimFor("mail", "kept")).toMatchObject({connectionId: "mail", eventId: expect.any(String)});
    expect(await a.call("DELETE", path + "/connections/mail")).toEqual({status: 404, data: {error: "connection_not_found"}});
    expect((await a.call("DELETE", path + "/connections/bark")).data.connections).toEqual([]);
    expect(readFileSync(operatorFile, "utf8")).toBe("fixture-device-key");
    expect((await f.connect(agent)).status).toBe(200);
    expect((await a.api(path + "/configuration")).data.communication.connections.find((item: any) => item.id === "mail").started).toBe(true);
  });

  it("removes the saved Feishu app directory only for the connection that uses it", async () => {
    const f = await fixture(), agent = await f.service.create(alice, "helper"), directory = f.settings.agentDirectory(agent.id);
    privateFile(join(directory, "feishu", "app-secret"), "fixture-secret");
    privateFile(join(directory, "feishu", "credentials.json"), { version: 1, appId: "cli_fixture", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" });
    privateFile(join(directory, "weixin.json"), "{}");
    const written = (connection: object) => (f.settings as any).written(agent.id, connection);
    expect(written({ kind: "feishu", credentialsFile: join(directory, "feishu", "credentials.json") })).toEqual([join(directory, "feishu")]);
    expect(written({ kind: "feishu", credentialsFile: "feishu/credentials.json" })).toEqual([join(directory, "feishu")]);
    expect(written({ kind: "feishu", appId: "cli_other", appSecretFile: "elsewhere/app-secret" })).toEqual([]);
    expect(written({ kind: "feishu", credentialsFile: join(directory, "..", "shared", "credentials.json") })).toEqual([]);
    expect(written({ kind: "weixin", credentialsFile: join(directory, "weixin.json") })).toEqual([join(directory, "weixin.json")]);
    expect(written({ kind: "telegram", botTokenFile: join(directory, "telegram-token") })).toEqual([join(directory, "telegram-token")]);
    expect(written({ kind: "telegram", botTokenFile: join(directory, "weixin.json") })).toEqual([]);
    expect(written({ kind: "bark", deviceKeyFile: join(directory, "mail-key") })).toEqual([]);
  });

  it("reads and replaces the allowlists of a connection without a restart and through the channel's own validation", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", {name: "helper"})).data, path = "/agents/" + agent.id, access = path + "/connections/mail/access";
    expect(await a.api(access)).toEqual({status: 404, data: {error: "connection_not_found"}});
    expect((await f.connect(agent)).status).toBe(200);
    await bark(f, agent);
    expect(await a.api(access)).toEqual({status: 200, data: {groupIds: [], peerAddresses: [], ownerAddresses: ["alice@example.test"]}});
    expect((await b.api(access)).status).toBe(404);
    const core = async () => (await f.service.runtime(agent.id)).extension!.communication!;
    expect((await core()).receive("mail", peer("before"))).toMatchObject({state: "ignored"});
    for (const invalid of [{}, {groupIds: []}, {peerAddresses: []}, {groupIds: [], peerAddresses: [], ownerAddresses: []}, {groupIds: [""], peerAddresses: []},
      {groupIds: [], peerAddresses: Array.from({length: 101}, (_, index) => "peer-" + index)}, {groupIds: "thread", peerAddresses: []}])
      expect(await a.call("PUT", access, invalid), JSON.stringify(invalid).slice(0, 80)).toEqual({status: 400, data: {error: "invalid_request"}});
    expect((await b.call("PUT", access, {groupIds: [], peerAddresses: []})).status).toBe(404);
    expect(await a.call("PUT", path + "/connections/web/access", {groupIds: [], peerAddresses: []})).toEqual({status: 404, data: {error: "connection_not_found"}});
    const allowed = {groupIds: ["thread-1"], peerAddresses: ["peer@example.test"]};
    expect(await a.call("PUT", access, allowed)).toEqual({status: 200, data: {...allowed, ownerAddresses: ["alice@example.test"]}});
    expect(await a.api(access)).toEqual({status: 200, data: {...allowed, ownerAddresses: ["alice@example.test"]}});
    expect(new ConnectionConfiguration(f.directory, join(f.directory, "options.json")).configuration(agent)?.connections[0]).toMatchObject(allowed);
    // The running channel uses the new lists: the same sender is now admitted.
    expect((await core()).receive("mail", peer("after"))).toMatchObject({state: "received"});
    // Both lists are replaced, never merged.
    expect((await a.call("PUT", access, {groupIds: [], peerAddresses: []})).data).toMatchObject({groupIds: [], peerAddresses: []});
    expect((await core()).receive("mail", peer("removed"))).toMatchObject({state: "ignored"});
    // A push channel has no senders: its module refuses any list, and nothing is saved.
    const refused = path + "/connections/bark/access";
    expect(await a.call("PUT", refused, {groupIds: [], peerAddresses: ["someone"]})).toEqual({status: 400, data: {error: "bark_is_send_only"}});
    expect(await a.call("PUT", refused, {groupIds: ["group"], peerAddresses: []})).toEqual({status: 400, data: {error: "bark_is_send_only"}});
    expect(await a.api(refused)).toEqual({status: 200, data: {groupIds: [], peerAddresses: [], ownerAddresses: []}});
    const runtime = await f.service.runtime(agent.id);
    runtime.store.set("communication_runs", "uncertain", {phase: "unknown"});
    expect(await a.call("PUT", access, allowed)).toEqual({status: 409, data: {error: "agent_has_active_or_unknown_run"}});
    expect((await a.api(access)).data).toMatchObject({groupIds: [], peerAddresses: []});
  });

  it("keeps the Host scope and the session binding of an existing session across an access change", async () => {
    const f = await fixture(), a = f.client("alice");
    const agent = (await a.api("/agents", {name: "helper"})).data, path = "/agents/" + agent.id;
    await f.host(agent);
    expect((await f.connect(agent)).status).toBe(200);
    const work = path + "/communication/work-events";
    const first = await a.api(work, {eventId: "first", input: "remember 42"});
    await vi.waitFor(async () => expect((await a.api(work + "/first")).data).toMatchObject({status: "completed"}), {timeout: 7000});
    const store = (await f.service.runtime(agent.id)).store;
    const scope = store.get("communication_host", "scope"), sessions = store.entries("execution_sessions");
    expect(scope).toEqual(expect.any(String));
    expect(sessions.length).toBeGreaterThan(0);
    expect((await a.call("PUT", path + "/connections/mail/access", {groupIds: ["thread-1"], peerAddresses: ["peer@example.test"]})).status).toBe(200);
    expect(store.get("communication_host", "scope")).toBe(scope);
    expect(store.entries("execution_sessions")).toEqual(sessions);
    expect((await a.api(work, {eventId: "second", input: "continue", sessionId: first.data.sessionId})).status).toBe(202);
    await vi.waitFor(async () => expect((await a.api(work + "/second")).data).toMatchObject({status: "completed", answer: "Fixture reply: continue"}), {timeout: 7000});
    expect([...f.hostRuns.values()][1].sessionId).toBe([...f.hostRuns.values()][0].sessionId);
  }, 20000);
});
