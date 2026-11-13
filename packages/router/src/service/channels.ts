import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ManagedAgent, ServiceExtension } from "./managed.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { CommunicationCore } from "../communication/core.js";
import { ServiceHttp } from "../http.js";
import { HttpAgentHost, type HostPort } from "../execution/host.js";
import { RunObservation } from "../execution/observation.js";
import { HostWorker } from "../execution/host-worker.js";
import { WorkSessions } from "../execution/sessions.js";
import { key } from "../execution/protocol.js";
import { ChannelTools } from "../communication/tools.js";
import { personId, type IdentityProvider, type PersonRegistry } from "../ledger/registry.js";
import { mailPairingCommand, pairingCommand, REPLIES, senderIdentities, type Identities } from "../ledger/identity.js";
import { LedgerControl } from "../ledger/control.js";
import { ROOM_CONNECTION, WEB_CONNECTION } from "../ledger/surfaces.js";
import type { HubRooms } from "../ledger/rooms.js";
import type { OwnerAttachments } from "../ledger/blobs-hub.js";
import type { ChannelFiles } from "../channels/api.js";
import { channelModule, connectionSchema, findChannelModule, RoomChannel, WebChannel } from "../channels/registry.js";

const file = z.string().min(1);
export const agentChannelConfigSchema = z.object({ agentId: z.uuid(), connections: z.array(connectionSchema).max(20),
  host: z.object({ binding: z.string().min(1).optional(), url: z.url().optional(), tokenFile: file.optional(), runtimeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
    instanceName: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).default("channel-host"), instructions: z.string().max(200_000).default("") }).strict().superRefine((host, context) => {
    if (host.binding ? host.url !== undefined || host.tokenFile !== undefined : !host.url || !host.tokenFile)
      context.addIssue({ code: "custom", message: "host_requires_binding_or_http_credentials" });
  }).optional() }).strict();
export const channelConfigSchema = z.object({ agents: z.array(agentChannelConfigSchema).min(1).max(100) }).strict().superRefine((config, context) => {
  if (new Set(config.agents.map((agent) => agent.agentId)).size !== config.agents.length) context.addIssue({ code: "custom", message: "duplicate_agent_id" });
  for (const agent of config.agents) {
    if (new Set(agent.connections.map((item) => item.id)).size !== agent.connections.length) context.addIssue({ code: "custom", message: "duplicate_connection_id" });
    for (const kind of new Set(agent.connections.map((item) => item.kind)))
      if (findChannelModule(kind)?.singleton && agent.connections.filter((item) => item.kind === kind).length > 1) context.addIssue({ code: "custom", message: `one_${kind}_connection_per_agent` });
    if (agent.connections.some((item) => item.id === WEB_CONNECTION)) context.addIssue({ code: "custom", message: "connection_id_reserved_for_web" });
    if (agent.connections.some((item) => item.id === ROOM_CONNECTION)) context.addIssue({ code: "custom", message: "connection_id_reserved_for_room" });
    for (const item of agent.connections)
      for (const message of findChannelModule(item.kind)?.validate?.(item) ?? []) context.addIssue({ code: "custom", message });
  }
});
export type AgentChannelConfig = z.infer<typeof agentChannelConfigSchema>;
export interface ChannelConfiguration { agents: AgentChannelConfig[]; directory: string; }
/** Credential files of a configuration, resolved against its directory. */
export function channelFiles(directory: string): ChannelFiles {
  return { directory, path: (path) => resolve(directory, path), read: (path) => readFileSync(resolve(directory, path), "utf8").trim(),
    secret: (path) => secret(directory, path) };
}
/**
 * Connection kinds Router no longer has. A stored configuration may still list such a connection (an agent that was
 * connected to Matrix has `{ id: "matrix", kind: "matrix" }`): it is dropped when the file is read, so it is neither
 * started nor listed, and the next saved configuration no longer contains it. Its stored messages stay readable.
 */
export const REMOVED_CONNECTION_KINDS: ReadonlySet<string> = new Set(["matrix"]);
function withoutRemovedKinds(value: unknown): unknown {
  const agents = (value as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return value;
  return { ...value as object, agents: agents.map((agent: { connections?: unknown }) => !Array.isArray(agent?.connections) ? agent
    : { ...agent, connections: agent.connections.filter((item: { kind?: unknown }) => !REMOVED_CONNECTION_KINDS.has(String(item?.kind))) }) };
}
export function loadChannelConfiguration(path: string): ChannelConfiguration {
  const config = { ...channelConfigSchema.parse(withoutRemovedKinds(JSON.parse(readFileSync(path, "utf8")))), directory: dirname(resolve(path)) };
  const accounts = new Set<string>(), files = channelFiles(config.directory);
  for (const agent of config.agents) for (const item of agent.connections) {
    const identity = key(item.kind, channelModule(item.kind).account(item, { agentId: agent.agentId, files }));
    if (accounts.has(identity)) throw new Error("channel_account_configured_more_than_once");
    accounts.add(identity);
  }
  return config;
}
function secret(directory: string, path: string): string {
  const value = readFileSync(resolve(directory, path), "utf8").trim();
  if (!value) throw new Error("empty_channel_credential");
  return value;
}

/**
 * Owner resolution by person and the `/link` control path for one agent's channels (ADR 0005 18.1, 18.4).
 * Pairing only matches the agent owner's codes, so it links the owner's own identities; strangers keep the
 * visitor flow. Registry or hub errors never fail a receipt: resolution falls back to configured addresses.
 */
export function identityHooks(identity: Identities, ownerId: string, namespaces: Map<string, { provider: IdentityProvider; namespace: string }>,
  mailPairing: Set<string>): NonNullable<CommunicationCore["identity"]> {
  const scoped = (connectionId: string, source: Parameters<typeof senderIdentities>[2]) => {
    const scope = namespaces.get(connectionId); return scope ? senderIdentities(scope.provider, scope.namespace, source) : undefined;
  };
  return {
    person: (connectionId, source) => { try { const ids = scoped(connectionId, source); return ids ? identity.resolve(ids) : undefined; } catch { return undefined; } },
    seen: (connectionId, source) => { const ids = scoped(connectionId, source); if (ids) identity.seen(ids[0]!); },
    pair: (connectionId, source) => {
      const scope = namespaces.get(connectionId); if (!scope) return undefined;
      const mail = scope.provider === "grove-mail" || scope.provider === "agentmail";
      const code = mail ? mailPairingCommand(source) : pairingCommand(source.text);
      if (!code) return undefined;
      // In groups the command is dropped without a reply, so a code is never confirmed in front of others.
      if (source.scope !== "direct") return {};
      if (mail && !(mailPairing.has(connectionId) && source.native?.senderVerified === true)) return { reply: REPLIES.unverified };
      try { return { reply: identity.attempt(ownerId, scoped(connectionId, source)!, code).reply }; }
      catch { return { reply: "暂时无法关联，请稍后再试。" }; }
    },
  };
}

export async function createChannelRuntime(agent: ManagedAgent, runtime: AgentRuntime, config: AgentChannelConfig,
  directory: string, issue: (name: string) => { id: string; validate: () => void; wake?: () => void }, suppliedHost?: HostPort,
  options: { persons?: PersonRegistry | undefined; identity?: Identities | undefined;
    attachments?: OwnerAttachments | undefined;
    /** The owner's hub rooms (ADR 0005 phase 5); registers the `room` connection. */
    rooms?: (() => HubRooms | undefined) | undefined;
    /** A browser has the session's chat open (owner notifications are skipped). */
    watching?: ((sessionKey: string) => boolean) | undefined } = {}): Promise<ServiceExtension> {
  const core = new CommunicationCore(agent.id, runtime.store, runtime.work, () => runtime.assertLease());
  // Ledger identity (ADR 0005 section 9): who is speaking, scoped by provider and namespace. Routing is unchanged.
  const owner = personId(agent.owner), namespaces = new Map<string, { provider: IdentityProvider; namespace: string }>();
  core.ownerPersonId = owner;
  core.watching = options.watching;
  if (options.persons) core.persons = (connectionId, sender) => {
    const scope = namespaces.get(connectionId); return scope ? options.persons!.resolve(scope.provider, scope.namespace, sender) : undefined;
  };
  const mailPairing = new Set<string>();
  if (options.identity) core.identity = identityHooks(options.identity, agent.owner, namespaces, mailPairing);
  const context = { agentId: agent.id, owner: agent.owner, files: channelFiles(directory) };
  for (const definition of config.connections) {
    const channel = await channelModule(definition.kind).create(definition, context);
    const { adapter } = channel, ownerAddresses = channel.ownerAddresses ?? definition.ownerAddresses, namespace = channel.namespace ?? "";
    namespaces.set(definition.id, { provider: definition.kind, namespace });
    if (channel.mailPairing) mailPairing.add(definition.id);
    // A registry error while seeding identities never blocks the channel.
    try { for (const address of ownerAddresses) options.persons?.link(owner, definition.kind, namespace, address, "config"); } catch { /* Seeded again on the next start. */ }
    core.register({ id: definition.id, ownerAddresses, peerAddresses: definition.peerAddresses, groupIds: definition.groupIds,
      ...(channel.notify ? { notify: channel.notify } : {}) }, adapter, channel.reload ?? (() => adapter));
  }
  // Owner web messages: replies to it are recorded, not sent.
  const web = new WebChannel(core, agent.owner, options.attachments);
  core.register({ id: WEB_CONNECTION, ownerAddresses: [owner] }, web);
  // Hub rooms (ADR 0005 phase 5). Only the owner's addressed room messages arrive here, through the fan-out worker.
  const room = options.rooms ? new RoomChannel(core, agent.id, agent.owner, options.rooms) : undefined;
  if (room) core.register({ id: ROOM_CONNECTION, ownerAddresses: [agent.owner] }, room);
  let worker: HostWorker | undefined;
  if (config.host) {
    const instance = issue(config.host.instanceName);
    if (config.host.binding && !suppliedHost) throw new Error("host_binding_provider_required");
    const host = suppliedHost ?? new HttpAgentHost(new ServiceHttp(config.host.url!, secret(directory, config.host.tokenFile!)));
    const channelTools = new ChannelTools(core, host);
    worker = new HostWorker(agent.id, instance.id, runtime.store, runtime.work,
      host, config.host.runtimeId,
      config.host.instructions, () => { runtime.assertLease(); instance.validate(); }, (taskId, answer) => core.saveResult(taskId, answer),
      { definitions: [channelTools.definition],
        instructions: "\nUse the channel tool to inspect native communication capabilities and send files or supported native content. Never automatically repeat an operation with an uncertain outcome.\n",
        allowed: (_conversationId, taskId) => Boolean(core.input(taskId)),
        execute: (call) => channelTools.execute(call) }, core, instance.wake, {
          // Private groups (owner plus the owner's agents) get the owner's grants; mixed groups do not.
          admission: (contextId, taskId) => core.isOwnerTask(contextId, taskId) || core.isPrivateGroupOwnerTask(contextId, taskId)
            ? { kind: "owner", owner: agent.owner, agentId: agent.id, reference: taskId } : undefined,
        });
  }
  const observation = worker ? new RunObservation(runtime.store, runtime.work, worker.host) : undefined;
  // Phase 4 (ADR 0005 section 16): one card record for every answer surface, and owner control over the session.
  const control = new LedgerControl({ agentId: agent.id, ownerPersonId: owner, store: runtime.store, ledger: core.ledger, core,
    work: runtime.work, observation, host: worker?.host, ...(worker ? { closeUnknown: (claimId: string) => worker!.closeUnknown(claimId) } : {}),
    ...(options.attachments ? { releaseAttachments: (ids: string[]) => options.attachments!.releaseAgent(agent.owner, agent.id, ids) } : {}) });
  if (worker) worker.control = control;
  core.control = async (input) => Boolean(await control.command(input)) || Boolean(await worker?.handleInput(input));
  const sessions = worker ? new WorkSessions(agent.id, agent.owner, config.host!.runtimeId, worker.instanceId,
    runtime.store, runtime.work, worker.host, core, () => runtime.assertLease(), input => worker!.dependencyWait(input)) : undefined;
  if (worker && sessions) worker.prepareSession = (contextId, taskId) => sessions.prepareChannelSession(contextId, taskId);
  const controller = new AbortController();
  let loops: Promise<void>[] = [];
  const loop = async (operation: () => Promise<void>, interval: number) => {
    while (!controller.signal.aborted) {
      try { await operation(); } catch { /* Durable records remain pending; status exposes channel/Host failures. */ }
      try { await sleep(interval, undefined, { signal: controller.signal }); } catch { break; }
    }
  };
  return {
    start: async () => { await core.start(); loops = [loop(async () => { await core.reconnect(); await core.dispatch(); await core.flush(); }, 250),
      ...(worker ? [loop(() => worker!.tick(), 1000)] : [])]; },
    stop: async () => { controller.abort(); await core.stop(); await Promise.allSettled(loops); },
    status: () => {
      return { ...core.status(), host: worker?.status() ?? null };
    },
    communication: core, web, control, ...(room ? { room } : {}),
    ...(observation ? { observation } : {}),
    ...(sessions ? { sessions } : {}),
    resolve: async (callId, result) => {
      if (!worker) throw new Error("host_not_configured");
      const call = worker.status().calls.find((item) => item.id === callId);
      if (!call) { await worker.resolve(callId, result); return "accepted"; }
      return control.record(call.runId, callId, { by: owner, surface: "run-api", result }, () => worker!.resolve(callId, result));
    },
    reconcile: async (claimId, runId) => { if (!worker) throw new Error("host_not_configured"); await worker.reconcile(claimId, runId); },
    closeUnknown: async (claimId) => { if (!worker) throw new Error("host_not_configured"); await worker.closeUnknown(claimId); },
    readAttachment: (inputId, reference) => core.readStoredAttachment(inputId, reference),
  };
}
