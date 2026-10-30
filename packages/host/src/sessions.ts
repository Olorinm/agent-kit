import type { BindingStore, SessionBinding } from "./agent.js";
import type { JsonValue } from "./types.js";

export interface SessionQuery {
  cwd?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
  sortDirection?: "asc" | "desc";
  itemsView?: "notLoaded" | "summary" | "full";
  turnId?: string;
  archived?: boolean;
  searchTerm?: string;
  sourceKinds?: string[];
}
export interface SessionPage {
  source: "native";
  items: JsonValue[];
  cursor?: string;
  native?: JsonValue;
}
export interface ForkOptions {
  cwd?: string;
  entryId?: string;
  signal?: AbortSignal;
  beforeEntryId?: string;
}
export interface NativeSessionPort {
  list?(options: SessionQuery): Promise<SessionPage>;
  history?(nativeId: string, options: SessionQuery): Promise<SessionPage>;
  fork?(nativeId: string, options: ForkOptions): Promise<string>;
  delete?(nativeId: string, options: ForkOptions): Promise<void>;
  read?(nativeId: string, options: SessionQuery): Promise<JsonValue>;
  items?(nativeId: string, options: SessionQuery): Promise<SessionPage>;
  rename?(nativeId: string, name: string): Promise<void>;
  archive?(nativeId: string, archived: boolean): Promise<void>;
  /** Only adapters with native snapshot reads can opt out of the idle requirement. */
  concurrentReads?: boolean;
  /** Native snapshot forks may read an active source; the target must remain idle. */
  concurrentForks?: boolean;
}
/** Bound operations take Host IDs; native IDs and transcripts are never synthesized. */
export class SessionManager {
  private readonly busy = new Set<string>();
  constructor(
    private readonly store: BindingStore,
    private readonly active: (id: string) => boolean,
    private readonly native: NativeSessionPort,
  ) {}
  assertIdle(id: string) {
    if (this.busy.has(id) || this.active(id)) throw new Error("session_busy");
  }
  async bindings() {
    if (!this.store.list) throw new Error("binding_store_list_unsupported");
    return (await this.store.list()).map(({ sessionId, binding }) => ({
      sessionId,
      nativeSessionId: binding.threadId,
    }));
  }
  list(options: SessionQuery = {}) {
    if (!this.native.list) throw new Error("native_session_list_unsupported");
    return this.native.list(options);
  }
  history(sessionId: string, options: SessionQuery = {}) {
    return this.readLock(sessionId, async () => {
      if (!this.native.history)
        throw new Error("native_session_history_unsupported");
      return this.native.history(
        (await this.binding(sessionId)).threadId,
        options,
      );
    });
  }
  read(sessionId: string, options: SessionQuery = {}) {
    return this.readLock(sessionId, async () => {
      if (!this.native.read) throw new Error("native_session_read_unsupported");
      return this.native.read((await this.binding(sessionId)).threadId, options);
    });
  }
  items(sessionId: string, options: SessionQuery = {}) {
    return this.readLock(sessionId, async () => {
      if (!this.native.items) throw new Error("native_session_items_unsupported");
      return this.native.items((await this.binding(sessionId)).threadId, options);
    });
  }
  rename(sessionId: string, name: string) {
    return this.lock([sessionId], async () => {
      if (!this.native.rename) throw new Error("native_session_rename_unsupported");
      await this.native.rename((await this.binding(sessionId)).threadId, name);
    });
  }
  archive(sessionId: string, archived = true) {
    return this.lock([sessionId], async () => {
      if (!this.native.archive) throw new Error("native_session_archive_unsupported");
      await this.native.archive((await this.binding(sessionId)).threadId, archived);
    });
  }
  /** Explicit trusted-owner adoption, after native identity validation; no transcript import. */
  adopt(sessionId: string, binding: SessionBinding) {
    return this.lock([sessionId], async () => {
      if (await this.store.get(sessionId)) throw new Error("target_session_exists");
      if (!this.native.read) throw new Error("native_session_adopt_unsupported");
      await this.native.read(binding.threadId, {});
      await this.store.set(sessionId, binding);
      return { sessionId, nativeSessionId: binding.threadId };
    });
  }
  get supportsConcurrentReads() { return this.native.concurrentReads === true; }
  get supportsConcurrentForks() { return this.native.concurrentForks === true; }
  private readLock<T>(id: string, fn: () => Promise<T>) {
    if (this.native.concurrentReads) return fn();
    return this.lock([id], fn);
  }
  fork(source: string, target: string, options: ForkOptions = {}) {
    if (source === target) throw new Error("target_session_exists");
    if (options.entryId && options.beforeEntryId) throw new Error("fork_boundary_conflict");
    return this.lock([source, target], async () => {
      if (!this.native.fork) throw new Error("native_session_fork_unsupported");
      if (await this.store.get(target))
        throw new Error("target_session_exists");
      const binding = await this.binding(source);
      const nativeSessionId = await this.native.fork(binding.threadId, options);
      if (!nativeSessionId || nativeSessionId === binding.threadId)
        throw new Error("native_fork_not_confirmed");
      try {
        await this.store.set(target, {
          ...binding,
          threadId: nativeSessionId,
          configurationSessionId: binding.configurationSessionId ?? source,
        });
      } catch (error) {
        throw new Error(`native_fork_binding_failed:${nativeSessionId}`, {
          cause: error,
        });
      }
      return { sessionId: target, nativeSessionId };
    }, this.native.concurrentForks ? new Set([source]) : undefined);
  }
  delete(sessionId: string, options: ForkOptions = {}) {
    return this.lock([sessionId], async () => {
      if (!this.native.delete)
        throw new Error("native_session_delete_unsupported");
      if (!this.store.delete)
        throw new Error("binding_store_delete_unsupported");
      const binding = await this.binding(sessionId);
      await this.native.delete(binding.threadId, options);
      await this.store.delete(sessionId);
      return { deleted: true as const, nativeSessionId: binding.threadId };
    });
  }
  private async binding(id: string) {
    const binding = await this.store.get(id);
    if (!binding) throw new Error("session_not_found");
    return binding;
  }
  private async lock<T>(ids: string[], fn: () => Promise<T>, activeSources?: ReadonlySet<string>) {
    for (const id of ids) {
      if (this.busy.has(id) || (this.active(id) && !activeSources?.has(id)))
        throw new Error("session_busy");
    }
    for (const id of ids) this.busy.add(id);
    try {
      return await fn();
    } finally {
      for (const id of ids) this.busy.delete(id);
    }
  }
}
export function sessionPage(
  items: unknown,
  native?: unknown,
  cursor?: unknown,
): SessionPage {
  if (!Array.isArray(items)) throw new Error("invalid_native_session_page");
  return {
    source: "native",
    items: JSON.parse(
      JSON.stringify(items, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ),
    ...(native === undefined
      ? {}
      : {
          native: JSON.parse(
            JSON.stringify(native, (_key, value) =>
              typeof value === "bigint" ? String(value) : value,
            ),
          ),
        }),
    ...(typeof cursor === "string" && cursor ? { cursor } : {}),
  };
}
