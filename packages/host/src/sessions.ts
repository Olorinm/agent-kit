import type { BindingStore } from "./agent.js";
import type { JsonValue } from "./types.js";

export interface SessionQuery {
  cwd?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
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
}
export interface NativeSessionPort {
  list?(options: SessionQuery): Promise<SessionPage>;
  history?(nativeId: string, options: SessionQuery): Promise<SessionPage>;
  fork?(nativeId: string, options: ForkOptions): Promise<string>;
  delete?(nativeId: string, options: ForkOptions): Promise<void>;
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
    return this.lock([sessionId], async () => {
      if (!this.native.history)
        throw new Error("native_session_history_unsupported");
      return this.native.history(
        (await this.binding(sessionId)).threadId,
        options,
      );
    });
  }
  fork(source: string, target: string, options: ForkOptions = {}) {
    return this.lock([source, target], async () => {
      if (!this.native.fork) throw new Error("native_session_fork_unsupported");
      if (await this.store.get(target))
        throw new Error("target_session_exists");
      const binding = await this.binding(source);
      const nativeSessionId = await this.native.fork(binding.threadId, options);
      if (!nativeSessionId || nativeSessionId === binding.threadId)
        throw new Error("native_fork_not_confirmed");
      try {
        await this.store.set(target, { ...binding, threadId: nativeSessionId });
      } catch (error) {
        throw new Error(`native_fork_binding_failed:${nativeSessionId}`, {
          cause: error,
        });
      }
      return { sessionId: target, nativeSessionId };
    });
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
  private async lock<T>(ids: string[], fn: () => Promise<T>) {
    for (const id of ids) this.assertIdle(id);
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
