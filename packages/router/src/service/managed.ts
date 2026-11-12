import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { AgentRuntime } from "../agents/runtime.js";
import { DurableStore } from "../communication/store.js";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import { AgentLedger } from "../ledger/ledger.js";
import { OwnerHubs } from "../ledger/hub.js";
import { PersonRegistry, personId } from "../ledger/registry.js";
import { Identities } from "../ledger/identity.js";
import { createWebLedger } from "../ledger/web.js";
import { RoomFanout } from "../ledger/rooms-fanout.js";
import { CloudflareAccessAuthenticator, CompositeAuthenticator, IdentityError, assertEdgeOwners, type EdgeIdentityConfig,
  type OwnerPrincipal, type OwnerRequest } from "../auth/edge-identity.js";
import { createBlobStore, type BlobStore, type BlobStoreConfig } from "../ledger/blobs.js";
import { OwnerAttachments } from "../ledger/blobs-hub.js";
import type { AttachmentReference, MediaContent } from "../communication/types.js";

export const agentName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
/** An owner or agent account id, `@name:namespace`. The namespace is the service's `serverName`. */
export const accountId = z.string().max(255).regex(/^@[a-z0-9._=\-/+]+:[a-zA-Z0-9.-]+(?::[0-9]+)?$/);
export interface ManagedAgent {
  /**
   * `matrixId` is the agent's runtime identity: the identity of its store, `@_ar_<id>:<serverName>`. The field keeps
   * the name it has in stored records.
   */
  id: string; owner: string; name: string; address: string; matrixId: string;
  createdAt: string; status: "provisioning" | "active" | "deleting";
}
interface Instance { id: string; agentId: string; name: string; tokenHash: string; createdAt: string; lastSeen: string | null; revoked: boolean; }
export interface ServiceConfig {
  /** The account namespace: owner ids are `@name:<serverName>` (`MATRIX_SERVER_NAME`). */
  serverName: string; publicUrl: string; stateDir: string;
  trustedProxies?: string[];
  /** ADR 0005 `ledger_read`: serve the web history API and event socket from the owner ledger. Needs `ledgerSend`. */
  ledgerRead?: boolean;
  /** ADR 0005 `send` (phase 3, needs `ledgerRead`): owner web messages through the web channel; dispatch and flush read the ledger. */
  ledgerSend?: boolean;
  /** ADR 0005 `cards` (phase 4, `AGENT_LEDGER_CARDS`, needs `ledgerSend`): card answers over HTTP; first answer wins. */
  ledgerCards?: boolean;
  /** ADR 0005 `reset` (phase 4, `AGENT_LEDGER_CONTROL`, needs `ledgerSend`): cancel, steer, reset ("新对话") and purge. */
  ledgerControl?: boolean;
  /** ADR 0005 `groups` (phase 5, `AGENT_LEDGER_GROUPS`, needs `ledgerSend`): native hub rooms, fan-out to agents and room commands. */
  ledgerGroups?: boolean;
  /** ADR 0005 18.2: verify the Cloudflare Access JWT and map its email (or service token) to an owner. */
  edgeIdentity?: EdgeIdentityConfig;
  /** ADR 0005 `identity` (phase 6, `AGENT_LEDGER_IDENTITY`): owner resolution by person, `/link` pairing and the identity routes (with `ledgerRead`). */
  ledgerIdentity?: boolean;
  /** ADR 0005 `attachments` (phase 4, `AGENT_LEDGER_ATTACHMENTS`, needs `ledgerSend`): upload/download routes, attachments on send and `features.attachments`. */
  ledgerAttachments?: boolean;
  /** Blob store for attachments; default `LocalBlobStore` under `<stateDir>/blobs`. R2 credentials are read from files. */
  blobStore?: BlobStoreConfig;
  /** Per-owner quota over distinct blobs; default 5 GiB. */
  attachmentQuotaBytes?: number;
}
export interface ServiceExtension {
  observation?: import("../execution/observation.js").RunObservation;
  sessions?: import("../execution/sessions.js").WorkSessions;
  /** The channel core and its web channel (ADR 0005 phase 3). */
  communication?: import("../communication/core.js").CommunicationCore;
  web?: import("../ledger/surfaces.js").WebIngress;
  /** Phase 4 cards and control (ADR 0005 section 16). */
  control?: import("../ledger/control.js").LedgerControl;
  /** The hub room channel (ADR 0005 phase 5). */
  room?: import("../ledger/rooms.js").RoomDelivery;
  start(): Promise<void>; stop(): Promise<void>; status(): unknown;
  resolve(callId: string, result: unknown): Promise<void | "accepted" | "stale">;
  reconcile(claimId: string, runId: string): Promise<void>;
  closeUnknown(claimId: string): Promise<void>;
  /** Read one attachment of a stored inbound message (lazy promotion into the blob store). */
  readAttachment?(inputId: string, reference: AttachmentReference): Promise<MediaContent>;
}
export interface ServiceDependencies {
  /**
   * The embedding product's bearer tokens: resolves a token to an owner id or throws. Without it only the edge
   * identity signs owners in.
   */
  authenticate?: (token: string) => Promise<string>;
  /** Replaces `<teamDomain>/cdn-cgi/access/certs` (tests). */
  edgeIdentityCerts?: URL;
  configure?: (agent: ManagedAgent, runtime: AgentRuntime) => Promise<ServiceExtension | undefined>;
  /** Product teardown (environments, Host) while the Agent still exists; failure keeps the Agent. */
  beforeDelete?: (agent: ManagedAgent) => Promise<void>;
  /** Product state purge after Router state is gone. */
  afterDelete?: (agent: ManagedAgent) => Promise<void>;
  /** Replaces the configured blob store (tests, embedders with their own storage). */
  blobStore?: BlobStore;
}
/** Registry collections of the removed visitor channel ledger (`ChannelRouter`); deleted once by a migration. */
export const LEGACY_CHANNEL_COLLECTIONS = ["channel_entries", "channel_visitors", "channel_events", "channel_contexts", "channel_reply_attachments"];
const newToken = () => randomBytes(32).toString("base64url");
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function publicInstance({ tokenHash: _hash, ...instance }: Instance) { return instance; }
const ACTIVE_RUN = ["running", "submitting", "unknown"];

export class ManagedService {
  readonly store: DurableStore;
  readonly persons: PersonRegistry;
  readonly hubs: OwnerHubs;
  readonly identity: Identities | undefined;
  readonly web: ReturnType<typeof createWebLedger> | undefined;
  readonly edgeIdentity: CloudflareAccessAuthenticator | undefined;
  private readonly owners: CompositeAuthenticator;
  /** Attachments and blob store (ADR 0005 16.5); only with `ledgerSend` and `ledgerAttachments`. */
  readonly attachments: OwnerAttachments | undefined;
  private readonly ledgers = new Map<string, AgentLedger>();
  /** The hub room fan-out worker (phase 5); present with `ledgerGroups`. */
  readonly fanout: RoomFanout | undefined;
  private runtimes = new Map<string, Promise<AgentRuntime>>();
  private configurations = new Map<string, Promise<void>>();
  private deleteGuards: Array<(agentId: string) => void> = [];
  constructor(readonly config: ServiceConfig, readonly dependencies: ServiceDependencies = {}) {
    if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(config.serverName)) throw new Error("invalid_server_name");
    const url = new URL(config.publicUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_service_url");
    // The console can only send through the ledger (ADR 0005 15.3).
    if (config.ledgerRead && !config.ledgerSend) throw new Error("ledger_read_requires_ledger_send");
    this.store = new DurableStore(join(config.stateDir, "registry.sqlite"), config.serverName);
    // The legacy visitor channel ledger (`ChannelRouter`, AgentMail entries) was removed; its records go with it.
    this.store.migrate(1, `DELETE FROM documents WHERE collection IN (${LEGACY_CHANNEL_COLLECTIONS.map((name) => `'${name}'`).join(",")})`, "legacy_channels_removed");
    this.persons = new PersonRegistry(this.store);
    this.hubs = new OwnerHubs(config.stateDir, {
      owns: (owner, agentId) => this.store.get<ManagedAgent>("agents", agentId)?.owner === owner,
      agentName: (agentId) => this.store.get<ManagedAgent>("agents", agentId)?.name ?? agentId,
      ledger: (agentId) => this.ledgers.get(agentId),
      personName: (id) => this.persons.person(id)?.displayName,
      groups: Boolean(config.ledgerRead && config.ledgerSend && config.ledgerGroups),
    });
    this.identity = config.ledgerIdentity ? new Identities(this.persons, this.hubs) : undefined;
    this.fanout = config.ledgerRead && config.ledgerSend && config.ledgerGroups ? new RoomFanout(this.hubs, {
      owners: () => [...new Set(this.agents().filter((agent) => agent.status === "active").map((agent) => agent.owner))],
      channel: async (agentId) => this.agent(agentId).status === "active" ? (await this.runtime(agentId)).extension?.room : undefined,
    }) : undefined;
    if (config.edgeIdentity) assertEdgeOwners(config.edgeIdentity, config.serverName);
    this.edgeIdentity = config.edgeIdentity ? new CloudflareAccessAuthenticator(config.edgeIdentity, { persons: this.persons, origins: [new URL(config.publicUrl).origin],
      ...(dependencies.edgeIdentityCerts ? { certsUrl: dependencies.edgeIdentityCerts } : {}) }) : undefined;
    this.owners = new CompositeAuthenticator(async (token) => {
      const ownerId = await this.authenticate(token);
      return { personId: personId(ownerId), ownerId, via: "bearer" };
    }, this.edgeIdentity);
    this.attachments = config.ledgerRead && config.ledgerSend && config.ledgerAttachments ? new OwnerAttachments({ hubs: this.hubs,
      store: dependencies.blobStore ?? createBlobStore(config.blobStore, config.stateDir), quotaBytes: config.attachmentQuotaBytes,
      tempDir: join(config.stateDir, "tmp", "uploads"), owned: (owner) => this.agents(owner).filter((agent) => agent.status === "active"),
      open: async (agentId) => { await this.runtime(agentId); }, ledger: (agentId) => this.ledgers.get(agentId),
      readChannel: async (agentId, inputId, reference) => {
        const read = (await this.runtime(agentId)).extension?.readAttachment;
        if (!read) throw new Error("channel_attachment_read_unsupported");
        return read(inputId, reference);
      } }) : undefined;
    this.attachments?.startSweeper();
    this.web = config.ledgerRead ? createWebLedger({ hubs: this.hubs, persons: this.persons, identity: this.identity, authenticator: this.owners,
      send: config.ledgerSend, channel: async (agentId) => (await this.runtime(agentId)).extension?.web,
      cards: Boolean(config.ledgerSend && config.ledgerCards), reset: Boolean(config.ledgerSend && config.ledgerControl),
      control: async (agentId) => (await this.runtime(agentId)).extension?.control,
      groups: Boolean(config.ledgerSend && config.ledgerGroups), kick: () => this.fanout?.kick(),
      open: async (agentId) => { await this.runtime(agentId); }, owned: (owner) => this.agents(owner).filter((agent) => agent.status === "active"),
      attachments: this.attachments }) : undefined;
  }
  /** Channel runtime options for hub rooms (phase 5). Without `groups` the room connection is not registered. */
  roomOptions(agent: ManagedAgent) {
    return this.fanout ? { rooms: () => this.hubs.hub(agent.owner).rooms } : {};
  }
  /** The agent as the API returns it. A record written by an earlier release may carry a `matrix` state, which is not served. */
  publicAgent(agent: ManagedAgent): ManagedAgent {
    const { matrix: _removed, ...record } = agent as ManagedAgent & { matrix?: unknown };
    return record;
  }
  agents(owner?: string): ManagedAgent[] {
    return this.store.entries<ManagedAgent>("agents").map((r) => r.value).filter((a) => !owner || a.owner === owner);
  }
  agent(id: string): ManagedAgent {
    const agent = this.store.get<ManagedAgent>("agents", id);
    if (!agent) throw new WorkError("agent_not_found", 404);
    return agent;
  }
  owned(id: string, owner: string): ManagedAgent {
    const agent = this.agent(id);
    if (agent.owner !== owner) throw new WorkError("agent_not_found", 404);
    return agent;
  }
  /**
   * The one entry point for owner-authenticated requests (ADR 0005 18.2): the Cloudflare Access JWT when edge identity is
   * configured and the assertion is present, otherwise the bearer token. `authenticate(token)` stays for token-only callers.
   */
  authenticateRequest(request: OwnerRequest): Promise<OwnerPrincipal> { return this.owners.authenticate(request); }
  /** A bearer token of the embedding product (`ServiceDependencies.authenticate`). Instance tokens are never owner credentials. */
  async authenticate(token: string): Promise<string> {
    if (!token || token.startsWith("ari_") || !this.dependencies.authenticate) throw new WorkError("account_login_required", 401);
    const user = accountId.parse(await this.dependencies.authenticate(token));
    if (!user.endsWith(`:${this.config.serverName}`) || user.startsWith("@_ar_")) throw new WorkError("local_owner_account_required", 403);
    return user;
  }
  async create(owner: string, name: string): Promise<ManagedAgent> {
    agentName.parse(name);
    let agent = this.agents(owner).find((a) => a.name === name);
    if (!agent) {
      if (this.agents(owner).length >= 50) throw new WorkError("agent_limit_reached", 429);
      const id = randomUUID();
      const localpart = owner.slice(1, owner.indexOf(":"));
      agent = { id, owner, name, address: `${localpart}/${name}@${this.config.serverName}`,
        matrixId: `@_ar_${id.replaceAll("-", "")}:${this.config.serverName}`, createdAt: new Date().toISOString(), status: "provisioning" };
      this.store.set("agents", id, agent);
    }
    await this.runtime(agent.id);
    return this.agent(agent.id);
  }
  runtime(id: string): Promise<AgentRuntime> {
    let pending = this.runtimes.get(id);
    if (!pending) {
      if (this.agent(id).status === "deleting") return Promise.reject(new WorkError("agent_deleting", 409));
      pending = this.open(this.agent(id)).catch((error) => { this.runtimes.delete(id); throw error; });
      this.runtimes.set(id, pending);
    }
    return pending;
  }
  /** Replace only the product extension. The agent's store, lease and work queue stay intact. */
  async configureRuntime(id: string, configure: NonNullable<ServiceDependencies["configure"]>,
    rollback: NonNullable<ServiceDependencies["configure"]> = this.dependencies.configure ?? (async () => undefined),
    commit: () => void = () => {}): Promise<void> {
    const operation = (this.configurations.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const runtime = await this.runtime(id);
      if (this.activeRun(runtime)) throw new WorkError("agent_has_active_or_unknown_run", 409);
      await runtime.extension?.stop();
      runtime.extension = undefined;
      let replacement: ServiceExtension | undefined;
      try {
        // A worker tick could have submitted work while stop was awaiting its loop.
        if (this.activeRun(runtime)) throw new WorkError("agent_has_active_or_unknown_run", 409);
        replacement = await configure(this.agent(id), runtime);
        commit(); await replacement?.start(); runtime.extension = replacement;
      }
      catch (error) {
        await replacement?.stop();
        const restored = await rollback(this.agent(id), runtime);
        await restored?.start(); runtime.extension = restored;
        throw error;
      }
    });
    this.configurations.set(id, operation);
    try { await operation; } finally { if (this.configurations.get(id) === operation) this.configurations.delete(id); }
  }
  private async open(agent: ManagedAgent): Promise<AgentRuntime> {
    const store = new DurableStore(join(this.config.stateDir, "agents", `${agent.id}.sqlite`), agent.matrixId);
    // The agent ledger is created before the channel runtime so its core writes into it.
    // A ledger that cannot open (migration or registry error) leaves the agent on the legacy records only.
    try {
      const ledger = AgentLedger.open(store);
      ledger.authoritative = Boolean(this.config.ledgerRead && this.config.ledgerSend);
      ledger.features = { cards: ledger.authoritative && Boolean(this.config.ledgerCards), reset: ledger.authoritative && Boolean(this.config.ledgerControl) };
      this.ledgers.set(agent.id, ledger);
      ledger.listen((sessionKey) => { if (this.ledgers.get(agent.id) === ledger) this.hubs.hub(agent.owner).publish(agent.id, sessionKey); });
      ledger.listenStream((sessionKey, turnId, text) => { if (this.ledgers.get(agent.id) === ledger) this.hubs.hub(agent.owner).stream(agent.id, sessionKey, turnId, text); });
      this.persons.ensurePerson(agent.owner, agent.owner.slice(1, agent.owner.indexOf(":")));
      // The owner's account id is an identity of the owner; the provider keeps the name it has in stored records.
      this.persons.link(personId(agent.owner), "matrix", this.config.serverName, agent.owner, "config");
    } catch { /* The runtime starts regardless. */ }
    const runtime = new AgentRuntime(agent.matrixId, store);
    try {
      runtime.extension = await this.dependencies.configure?.(agent, runtime);
      runtime.start();
      await runtime.extension?.start();
    } catch (error) { this.ledgers.delete(agent.id); await runtime.extension?.stop(); runtime.stop(); store.close(); throw error; }
    this.store.set("agents", agent.id, { ...agent, status: "active" });
    try { this.hubs.hub(agent.owner).sync(agent.id); } catch { /* The hub catches up on the next publication. */ }
    return runtime;
  }
  /** Components holding per-Agent work Router does not see (e.g. connection setup) can veto deletion. */
  guardDelete(guard: (agentId: string) => void) { this.deleteGuards.push(guard); }
  /**
   * Delete an Agent: product teardown, stop its runtime and remove its state.
   * Once Router state is touched the Agent stays `deleting`; repeating the call finishes the removal.
   */
  async delete(owner: string, id: string): Promise<void> {
    const agent = this.owned(id, owner);
    if (agent.status !== "deleting") {
      for (const guard of this.deleteGuards) guard(id);
      if (this.runtimes.has(id) && this.activeRun(await this.runtime(id))) throw new WorkError("agent_has_active_or_unknown_run", 409);
      // Product teardown may itself quiesce the runtime, so it runs before this method takes the Agent's lock.
      await this.dependencies.beforeDelete?.(agent);
    }
    const previous = this.configurations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const operation = new Promise<void>((r) => { release = r; });
    this.configurations.set(id, operation);
    try {
      await previous.catch(() => {});
      if (this.agent(id).status !== "deleting") {
        const pending = this.runtimes.get(id);
        const runtime = pending && await pending;
        if (runtime && this.activeRun(runtime)) throw new WorkError("agent_has_active_or_unknown_run", 409);
        this.store.set("agents", id, { ...this.agent(id), status: "deleting" });
        this.forgetLedger(agent);
        if (runtime) {
          this.runtimes.delete(id);
          await runtime.extension?.stop(); runtime.stop(); runtime.store.close();
        }
      }
      this.purge(agent);
    } finally {
      release();
      if (this.configurations.get(id) === operation) this.configurations.delete(id);
    }
    await this.dependencies.afterDelete?.(agent);
  }
  private activeRun(runtime: AgentRuntime) {
    return runtime.store.entries<{ phase: string }>("communication_runs").some(({ value }) => ACTIVE_RUN.includes(value.phase));
  }
  /** Drop the agent's ledger and hub index; a hub error never blocks deletion. */
  private forgetLedger(agent: ManagedAgent) {
    this.ledgers.delete(agent.id);
    try { this.hubs.hub(agent.owner).forget(agent.id); } catch { /* The index is rebuilt from ledgers. */ }
  }
  private purge(agent: ManagedAgent) {
    this.forgetLedger(agent);
    this.store.transaction(() => {
      for (const { id, value } of this.store.entries<{ agentId: string }>("instances")) if (value.agentId === agent.id) this.store.delete("instances", id);
      for (const { id, value } of this.store.entries<{ agentId: string }>("connection_setup_jobs")) if (value.agentId === agent.id) this.store.delete("connection_setup_jobs", id);
      this.store.delete("agents", agent.id);
    });
    const journal = join(this.config.stateDir, "agents", `${agent.id}.sqlite`);
    for (const file of [journal, `${journal}-wal`, `${journal}-shm`]) rmSync(file, { force: true });
    rmSync(join(this.config.stateDir, "connections", "agents", agent.id), { recursive: true, force: true });
  }
  /**
   * The identity of a worker that takes this agent's work (the Host worker). Its id is stable per name and is part of
   * the Host scope and of Host session ids; the token only proves the instance still exists.
   */
  issue(agentId: string, name: string): { instance: ReturnType<typeof publicInstance>; token: string } {
    this.agent(agentId); agentName.parse(name);
    const instances = this.store.entries<Instance>("instances").map((r) => r.value).filter((i) => i.agentId === agentId);
    const same = instances.find((i) => i.name === name);
    if (!same && instances.length >= 50) throw new WorkError("instance_limit_reached", 429);
    const token = `ari_${newToken()}`;
    const instance: Instance = { id: same?.id ?? randomUUID(), agentId, name, tokenHash: digest(token),
      createdAt: same?.createdAt ?? new Date().toISOString(), lastSeen: same?.lastSeen ?? null, revoked: false };
    this.store.set("instances", instance.id, instance);
    return { instance: publicInstance(instance), token };
  }
  instance(token: string, agentId: string): Instance {
    if (!token.startsWith("ari_")) throw new WorkError("instance_token_required", 401);
    const hash = digest(token);
    const instance = this.store.entries<Instance>("instances").map((r) => r.value).find((i) => equal(i.tokenHash, hash));
    if (!instance || instance.revoked || instance.agentId !== agentId) throw new WorkError("instance_unauthorized", 401);
    this.store.set("instances", instance.id, { ...instance, lastSeen: new Date().toISOString() });
    return instance;
  }
  async start(): Promise<void> { for (const agent of this.agents()) if (agent.status !== "deleting") await this.runtime(agent.id); }
  async close(): Promise<void> {
    await this.fanout?.stop();
    await Promise.allSettled(this.configurations.values());
    for (const pending of this.runtimes.values()) {
      try { const runtime = await pending; await runtime.extension?.stop(); runtime.stop(); runtime.store.close(); } catch { /* Failed initialization already closed its store. */ }
    }
    this.runtimes.clear(); this.ledgers.clear(); this.attachments?.stop(); this.web?.close(); this.hubs.close(); this.store.close();
  }
}

export function createManagedApp(service: ManagedService, setup?: express.Router) {
  const app = express(); app.disable("x-powered-by");
  app.set("trust proxy", service.config.trustedProxies ?? false);
  const jsonBody = express.json({ limit: "2mb" });
  app.use((req, res, next) => {
    // Attachment uploads stream their raw body (any content type, including application/json) to the blob store.
    if (req.method === "POST" && req.path === "/_agent-router/v1/web/attachments") next();
    else jsonBody(req, res, next);
  });
  app.get("/health/live", (_req, res) => res.json({ status: "ok", component: "agent-service" }));
  const root = "/_agent-router/v1";
  // Limit before authentication or provisioning. Forwarded IPs are used only
  // when the operator explicitly trusts the connecting proxy address.
  app.use(root, rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
    message: { error: "rate_limit_exceeded" } }));
  if (service.web) app.use(`${root}/web`, service.web.router);
  app.use(root, async (req, res, next) => {
    const principal = await service.authenticateRequest(req);
    res.locals.principal = principal; res.locals.owner = principal.ownerId; next();
  });
  // The authenticated owner (ADR 0005 18.3).
  app.get(`${root}/account`, (_req, res) => {
    const { ownerId, personId: person, via, email } = res.locals.principal as OwnerPrincipal;
    res.set("Cache-Control", "no-store").json({ owner: ownerId, personId: person, via, ...(email ? { email } : {}) });
  });
  app.get(`${root}/agents`, (_req, res) => res.json({ data: service.agents(res.locals.owner).map((agent) => service.publicAgent(agent)) }));
  app.post(`${root}/agents`, async (req, res) => {
    const { name } = z.object({ name: agentName }).strict().parse(req.body);
    res.status(201).json(service.publicAgent(await service.create(res.locals.owner, name)));
  });
  app.use(`${root}/agents/:agentId`, (req, res, next) => { service.owned(String(req.params.agentId), res.locals.owner); next(); });
  app.get(`${root}/agents/:agentId`, (req, res) => res.json(service.publicAgent(service.agent(req.params.agentId))));
  app.delete(`${root}/agents/:agentId`, async (req, res) => { await service.delete(res.locals.owner, req.params.agentId); res.status(204).end(); });
  if (setup) app.use(setup);
  const extension = async (id: string) => {
    const runtime = await service.runtime(id);
    if (!runtime.extension) throw new WorkError("channels_not_configured", 404);
    return runtime.extension;
  };
  app.get(`${root}/agents/:agentId/communication`, async (req, res) => res.json((await extension(req.params.agentId)).status()));
  const observation = async (agentId: string) => {
    const value = (await extension(agentId)).observation;
    if (!value) throw new WorkError("host_observation_unavailable", 409);
    return value;
  };
  const communication = `${root}/agents/:agentId/communication`;
  const sessions = async (agentId: string) => {
    const value = (await extension(agentId)).sessions;
    if (!value) throw new WorkError("host_sessions_unavailable", 409);
    return value;
  };
  app.get(`${communication}/sessions`, async (req, res) => res.json({ data: (await sessions(req.params.agentId)).list() }));
  app.get(`${communication}/sessions/:sessionId`, async (req, res) => res.json((await sessions(req.params.agentId)).getSession(req.params.sessionId)));
  app.post(`${communication}/sessions/:sessionId/native`, async (req, res) => {
    const body = z.object({ action: z.enum(["read", "history", "items", "rename", "archive", "unarchive", "delete"]),
      name: z.string().min(1).max(1000).optional(), limit: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().max(10000).optional(), turnId: z.string().max(160).optional(),
      itemsView: z.enum(["notLoaded", "summary", "full"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(),
    }).strict().parse(req.body);
    res.json(await (await sessions(req.params.agentId)).native(req.params.sessionId, body));
  });
  app.post(`${communication}/sessions/:sessionId/fork`, async (req, res) => {
    const body = z.object({ targetSessionId: z.string().min(1).max(160), entryId: z.string().max(160).optional(), beforeEntryId: z.string().max(160).optional() }).strict().parse(req.body);
    const { targetSessionId, ...options } = body;
    res.json(await (await sessions(req.params.agentId)).fork(req.params.sessionId, targetSessionId, options));
  });
  app.post(`${communication}/sessions/:sessionId/steer`, async (req, res) => {
    const body = z.object({ input: z.string().min(1).max(24_000) }).strict().parse(req.body);
    await (await sessions(req.params.agentId)).steer(req.params.sessionId, body.input); res.json({ status: "accepted" });
  });
  app.post(`${communication}/work-events`, async (req, res) => {
    const body = z.object({ eventId: z.string().min(1).max(160), sessionId: z.string().min(1).max(160).optional(), input: z.string().max(24_000),
      context: z.json().optional(), inputItems: z.array(z.record(z.string(), z.json())).max(100).optional(),
      settings: z.record(z.string(), z.json()).optional(), mode: z.enum(["turn", "compact"]).optional(),
    }).strict().parse(req.body);
    res.status(202).json(await (await sessions(req.params.agentId)).submit({ ...body,
      admission: { kind: "owner", owner: res.locals.owner, agentId: req.params.agentId, reference: body.eventId } }));
  });
  app.get(`${communication}/work-events/:eventId`, async (req, res) => res.json((await sessions(req.params.agentId)).get(req.params.eventId)));
  app.post(`${communication}/work-events/:eventId/cancel`, async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await (await sessions(req.params.agentId)).cancel(req.params.eventId));
  });
  app.get(`${communication}/tasks`, async (req, res) => {
    const filter = z.object({ connectionId: z.string().min(1).max(64).optional(), target: z.string().min(1).max(1024).optional(),
      conversationId: z.string().min(1).max(160).optional(), before: z.string().min(1).max(160).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
    res.json((await observation(req.params.agentId)).tasks(filter));
  });
  app.get(`${communication}/runs/:claimId`, async (req, res) => res.json(await (await observation(req.params.agentId)).run(req.params.claimId)));
  app.get(`${communication}/runs/:claimId/events`, async (req, res) => {
    const { after, limit } = z.object({ after: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict().parse(req.query);
    res.json(await (await observation(req.params.agentId)).events(req.params.claimId, after, limit));
  });
  app.post(`${communication}/runs/:claimId/calls/:callId/result`, async (req, res) => {
    const body = z.object({ result: z.json() }).strict().parse(req.body);
    const runtime = await extension(req.params.agentId), value = await observation(req.params.agentId);
    const resolve = () => value.resolve(req.params.claimId, req.params.callId, body.result);
    // One card record for every answer surface (ADR 0005 16.1): the first answer wins, a later one is stale.
    const runId = runtime.control ? value.store.get<{ runId?: string }>("communication_runs", req.params.claimId)?.runId : undefined;
    const status = runtime.control && runId ? await runtime.control.record(runId, req.params.callId, { by: personId(res.locals.owner), surface: "run-api", result: body.result }, resolve)
      : (await resolve(), "accepted");
    res.json({ status });
  });
  app.post(`${communication}/tasks/:taskId/cancel`, async (req, res) => {
    z.object({}).strict().parse(req.body);
    await (await observation(req.params.agentId)).cancel(req.params.taskId);
    res.json({ status: "accepted" });
  });
  app.post(`${root}/agents/:agentId/communication/calls/:callId/result`, async (req, res) => {
    const body = z.object({ result: z.json() }).strict().parse(req.body);
    const status = await (await extension(req.params.agentId)).resolve(req.params.callId, body.result); res.json({ status: status ?? "accepted" });
  });
  app.post(`${root}/agents/:agentId/communication/runs/:claimId/reconcile`, async (req, res) => {
    const body = z.object({ runId: z.string().min(1).max(160) }).strict().parse(req.body);
    await (await extension(req.params.agentId)).reconcile(req.params.claimId, body.runId); res.json({ status: "accepted" });
  });
  app.post(`${root}/agents/:agentId/communication/runs/:claimId/close`, async (req, res) => {
    z.object({}).strict().parse(req.body);
    await (await extension(req.params.agentId)).closeUnknown(req.params.claimId); res.json({ status: "closed" });
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof WorkError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .json({ error: error instanceof WorkError ? error.message : error instanceof z.ZodError ? "invalid_request" : "operation_failed",
        ...(error instanceof WorkError && error.nativeError !== undefined ? { nativeError: error.nativeError } : {}),
        ...(error instanceof WorkError && error.fields ? error.fields : {}),
        ...(error instanceof IdentityError ? error.details : {}) });
  });
  return app;
}
