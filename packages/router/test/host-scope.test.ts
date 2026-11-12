import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore as ConnectorStore } from "../src/communication/store.js";
import { MatrixConnector } from "../src/agents/connector.js";
import { DormantTransport } from "../src/matrix/transport.js";
import type { ManagedAgent } from "../src/service/managed.js";
import { agentChannelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import type { HostPort } from "../src/execution/host.js";

/**
 * The Host scope fingerprint (`communication_host/scope`) of a fixed agent. A running deployment stores this value in
 * every agent's store and refuses to start when it differs (`host_binding_configuration_changed`), so the inputs
 * (agent id, instance id, runtime id, Host instructions, Host identity, the channel tool definition and its
 * instructions) must not change by accident. The expected value was computed before the Router core left `src/matrix`.
 */
const PINNED_SCOPE = "a867de3a3fec0967ee7d50ec9b0271d24ed162fb4eb718ddf36368fa67463371";
const agent: ManagedAgent = { id: "11111111-1111-4111-8111-111111111111", owner: "@alice:example.test", name: "helper",
  address: "alice/helper@example.test", matrixId: "@_ar_11111111111141118111111111111111:example.test",
  createdAt: "2026-01-01T00:00:00.000Z", status: "active", matrix: "none" };
const host: HostPort = { identity: "fixture-host", connect: async () => {}, start: async () => { throw new Error("unused"); },
  get: async () => { throw new Error("unused"); }, cancel: async () => {}, calls: async () => [], resolve: async () => {} };
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

describe("Host scope fingerprint", () => {
  it("is unchanged for a fixture agent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "router-scope-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = new ConnectorStore(":memory:", agent.matrixId); cleanup.push(() => store.close());
    const connector = new MatrixConnector(agent.matrixId, store, new DormantTransport(agent.matrixId), undefined, 250);
    const config = agentChannelConfigSchema.parse({ agentId: agent.id, connections: [],
      host: { binding: "default", runtimeId: "codex", instanceName: "channel-host", instructions: "You are the fixture agent." } });
    await createChannelRuntime(agent, connector, config, directory,
      () => ({ id: "22222222-2222-4222-8222-222222222222", validate: () => {} }), host, { matrix: false });
    expect(store.get("communication_host", "scope")).toBe(PINNED_SCOPE);
  });
});
