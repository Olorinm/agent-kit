import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ServiceDependencies, type ServiceExtension } from "../src/service/managed.js";
import type { AgentRuntime } from "../src/agents/runtime.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1";
async function setup(extra: Partial<ServiceDependencies> = {}, closeService = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "router-delete-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const service = new ManagedService({ serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1", stateDir }, {
    authenticate: async (token) => token === "alice" ? owner : token === "bob" ? other : Promise.reject(new Error("bad")), ...extra });
  if (closeService) cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (path: string, token = "alice", method = "GET") => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  };
  return { service, api, stateDir };
}
/**
 * A product extension whose `stop` fails while `fail()` is true: the one step of a deletion that can fail after the
 * Agent is marked `deleting`. A runtime whose extension did not stop is not released by the service, so the fixture
 * releases its lease and store.
 */
function failingStop(fail: () => boolean, order: string[] = []) {
  return async (_agent: unknown, runtime: AgentRuntime): Promise<ServiceExtension> => {
    cleanup.push(() => { runtime.stop(); runtime.store.close(); });
    return { start: async () => {}, stop: async () => { order.push("stop"); if (fail()) throw new Error("channel_stop_failed"); }, status: () => ({}),
      resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {} };
  };
}

describe("deleting an Agent", () => {
  it("removes its credentials, journal and connection files", async () => {
    const { service, api, stateDir } = await setup();
    const agent = await service.create(owner, "scratch"), kept = await service.create(owner, "kept");
    const issued = service.issue(agent.id, "laptop"), keptIssued = service.issue(kept.id, "laptop");
    const connections = join(stateDir, "connections", "agents", agent.id, "feishu");
    mkdirSync(connections, { recursive: true }); writeFileSync(join(connections, "app-secret"), "secret");

    expect((await api(`${root}/agents/${agent.id}`, "bob", "DELETE")).status).toBe(404);
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(204);

    expect(service.agents(owner).map((a) => a.name)).toEqual(["kept"]);
    expect(service.store.entries<{ agentId: string }>("instances").map(({ value }) => value.agentId)).toEqual([kept.id]);
    expect(existsSync(join(stateDir, "agents", `${agent.id}.sqlite`))).toBe(false);
    expect(existsSync(join(stateDir, "connections", "agents", agent.id))).toBe(false);
    expect(() => service.instance(issued.token, agent.id)).toThrow("instance_unauthorized");
    expect((await api(`${root}/agents/${agent.id}`)).status).toBe(404);
    // The kept Agent still works and a new Agent with the old name gets a new identity.
    expect((await api(`${root}/agents/${kept.id}`)).status).toBe(200);
    expect(service.instance(keptIssued.token, kept.id).agentId).toBe(kept.id);
    expect(existsSync(join(stateDir, "agents", `${kept.id}.sqlite`))).toBe(true);
    expect((await service.create(owner, "scratch")).id).not.toBe(agent.id);
  });

  it("refuses while work is running, and keeps the Agent intact", async () => {
    const { service, api } = await setup();
    const agent = await service.create(owner, "busy");
    const runtime = await service.runtime(agent.id);
    runtime.store.set("communication_runs", "claim", { phase: "unknown" });
    expect(await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).toEqual({ status: 409, data: { error: "agent_has_active_or_unknown_run" } });
    runtime.store.set("communication_runs", "claim", { phase: "finished" });
    expect(service.agent(agent.id).status).toBe("active");
    expect(await service.runtime(agent.id)).toBe(runtime);
    expect((await api(`${root}/agents/${agent.id}`)).data.status).toBe("active");
  });

  it("keeps the Agent when product teardown fails, and finishes a deletion interrupted after Router state changed", async () => {
    let failTeardown = true, failStop = true;
    const order: string[] = [];
    const { service, api } = await setup({
      beforeDelete: async () => { order.push("before"); if (failTeardown) throw new Error("environment_destroy_failed"); },
      configure: failingStop(() => failStop, order),
      afterDelete: async () => { order.push("after"); },
    });
    const agent = await service.create(owner, "flaky");
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(500);
    expect(service.agent(agent.id).status).toBe("active");
    failTeardown = false;
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(500);
    expect(service.agent(agent.id).status).toBe("deleting");
    expect(await api(`${root}/agents/${agent.id}/communication`)).toEqual({ status: 409, data: { error: "agent_deleting" } });
    failStop = false;
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(204);
    expect(order).toEqual(["before", "before", "stop", "after"]);
    expect(service.agents(owner)).toHaveLength(0);
  });

  it("skips a half-deleted Agent on restart instead of reopening it", async () => {
    const { service } = await setup({ configure: failingStop(() => true) }, false);
    const agent = await service.create(owner, "halfway");
    await expect(service.delete(owner, agent.id)).rejects.toThrow("channel_stop_failed");
    // Close the first service's database before reopening the same state directory.
    service.store.close();
    const restarted = new ManagedService(service.config, { configure: async () => { throw new Error("must_not_reopen"); } });
    cleanup.push(() => restarted.close());
    await restarted.start();
    expect(restarted.agent(agent.id).status).toBe("deleting");
  });
});
