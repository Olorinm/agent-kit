import { randomUUID } from "node:crypto";
import type { DurableStore } from "../communication/store.js";
import { CliWork } from "../execution/work.js";

/**
 * One agent's runtime: its durable store, the lease that keeps a second process off that store, and its work queue.
 * `identity` is the value the store was created with (`ManagedAgent.matrixId`); a store refuses any other identity.
 */
export class AgentRuntime {
  /** Every task is admitted by the channel core or the work session API, which approve it themselves. */
  readonly work: CliWork;
  /** The product extension (channels, Host worker, sessions); replaced by `ManagedService.configureRuntime`. */
  extension: import("../service/managed.js").ServiceExtension | undefined;
  lastError = "";
  private readonly leaseOwner = randomUUID();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  constructor(readonly identity: string, readonly store: DurableStore) {
    this.work = new CliWork(store, () => "ask");
  }
  assertLease(): void {
    const lease = this.store.get<{ owner: string; expires: number }>("meta", "lease");
    if (!lease || lease.owner !== this.leaseOwner || lease.expires <= Date.now()) throw new Error("connector_lease_lost");
  }
  start(): void {
    this.store.acquireLease(this.leaseOwner);
    this.heartbeat = setInterval(() => {
      try { this.store.acquireLease(this.leaseOwner); this.lastError = ""; }
      catch { this.lastError = "connector_lease_lost"; }
    }, 5_000);
  }
  stop(): void {
    clearInterval(this.heartbeat);
    this.store.releaseLease(this.leaseOwner);
  }
}
