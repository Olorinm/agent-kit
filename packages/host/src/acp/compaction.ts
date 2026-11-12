import type { StdioJsonRpcClient } from "../transport/stdio-json-rpc-client.js";
export interface CompactionResult {
  ok: boolean;
  compacted: boolean;
  error?: string;
  outcomeUnknown?: boolean;
  usage?: { used?: number; size?: number };
}
function readAcpContextUsage(update: Record<string, unknown>) {
  if (update.sessionUpdate !== "usage_update") return undefined;
  return {
    used: typeof update.used === "number" ? update.used : undefined,
    size: typeof update.size === "number" ? update.size : undefined,
  };
}
/** OpenCode 2 owns /compact and reports completion over the same ACP session. */
export async function compactOpenCodeAcp(options: {
  client: StdioJsonRpcClient;
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CompactionResult> {
  const { client, sessionId, signal } = options;
  let receipt: CompactionResult | undefined;
  let compactionId: string | undefined;
  const remove = client.addNotificationHandler((notification) => {
    if (notification.method !== "session/update") return;
    const params = asObject(notification.params);
    if (params.sessionId !== sessionId) return;
    const update = asObject(params.update);
    const meta = asObject(update._meta);
    if (meta["opencode/child-session"]) return;
    const marker = asObject(meta["opencode/compaction"]);
    const current =
      update.sessionUpdate === "compaction_update" ? update : marker;
    const id =
      readString(current, "compactionId") ?? readString(current, "messageId");
    if (!id) return;
    if (["in_progress", "started"].includes(String(current.status))) {
      compactionId ??= id;
      return;
    }
    if (compactionId !== id) return;
    if (current.status === "completed") receipt = { ok: true, compacted: true };
    if (["failed", "cancelled"].includes(String(current.status)))
      receipt = {
        ok: false,
        compacted: false,
        error:
          current.status === "cancelled"
            ? "opencode_compaction_cancelled"
            : "opencode_compaction_failed",
        outcomeUnknown: false,
      };
  });
  const cancel = () => client.notify("session/cancel", { sessionId });
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    // Upstream awaits compaction before its prompt response; an ack without a
    // correlated started/completed lifecycle never establishes success.
    const response = asObject(
      await client.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: "/compact" }],
        },
        { signal, timeoutMs: options.timeoutMs ?? 120_000 },
      ),
    );
    if (response.stopReason === "cancelled")
      return {
        ok: false,
        compacted: false,
        error: "opencode_compaction_cancelled",
        outcomeUnknown: false,
      };
    return (
      receipt ?? {
        ok: false,
        compacted: false,
        error: "opencode_compaction_not_confirmed",
        outcomeUnknown: true,
      }
    );
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      error: error instanceof Error ? error.message : String(error),
      outcomeUnknown: true,
    };
  } finally {
    remove();
    signal?.removeEventListener("abort", cancel);
  }
}
export async function compactKimi(options: {
  client: StdioJsonRpcClient;
  sessionId: string;
  beforeUsed?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CompactionResult> {
  const { client, sessionId: nativeSessionId, beforeUsed, signal } = options;
  let observedUsage: { used?: number; size?: number } | undefined;
  let commandText = "";
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  const cleanupNotifications = client.addNotificationHandler((notification) => {
    if (
      notification.method !== "session/update" &&
      notification.method !== "session/notification"
    )
      return;
    const params = asObject(notification.params);
    if (readString(params, "sessionId") !== nativeSessionId) return;
    const update = asObject(params.update);
    const usage = readAcpContextUsage(update);
    if (usage) observedUsage = usage;
    if (readString(update, "sessionUpdate") === "agent_message_chunk") {
      commandText += readString(asObject(update.content), "text") ?? "";
    }
    if (
      readKimiCompactionResult(commandText) ||
      /Compaction cancelled|Compaction is blocked|\/compact failed:/i.test(
        commandText,
      ) ||
      (beforeUsed !== undefined &&
        observedUsage?.used !== undefined &&
        observedUsage.used < beforeUsed)
    ) {
      resolveCompletion();
    }
  });
  const cancelCompact = () => {
    client.notify("session/cancel", { sessionId: nativeSessionId });
    resolveCompletion();
  };
  if (signal?.aborted) cancelCompact();
  signal?.addEventListener("abort", cancelCompact, { once: true });
  try {
    await client.request(
      "session/prompt",
      {
        sessionId: nativeSessionId,
        prompt: [{ type: "text", text: "/compact" }],
      },
      { timeoutMs: options.timeoutMs ?? 120_000, signal },
    );
    // Kimi Code 0.41 ACP acknowledges /compact before its background task finishes:
    // https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/builtin-commands.ts
    // Keep listening for the native completion receipt; an acknowledgement is not success.
    if (
      /Context compaction started|A context compaction is already running/i.test(
        commandText,
      )
    ) {
      const remainingMs = Math.max(
        0,
        (options.timeoutMs ?? 120_000) - (Date.now() - startedAt),
      );
      completionTimer = setTimeout(resolveCompletion, remainingMs);
      await completion;
      if (signal?.aborted) throw new Error("kimi_compaction_aborted");
    }
    const commandResult = readKimiCompactionResult(commandText);
    if (commandResult) {
      return {
        ok: true,
        compacted: true,
        usage: { used: commandResult.tokensAfter },
      };
    }
    if (
      beforeUsed !== undefined &&
      observedUsage?.used !== undefined &&
      observedUsage.used < beforeUsed
    ) {
      return { ok: true, compacted: true, usage: observedUsage };
    }
    const receipt = commandText.trim().replaceAll(/\s+/g, " ").slice(0, 240);
    return {
      ok: false,
      compacted: false,
      error: receipt
        ? `kimi_compaction_not_confirmed:${receipt}`
        : "kimi_compaction_not_confirmed:no_compaction_receipt",
    };
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      error: error instanceof Error ? error.message : String(error),
      ...(signal?.aborted ? { outcomeUnknown: true } : {}),
    };
  } finally {
    if (completionTimer) clearTimeout(completionTimer);
    signal?.removeEventListener("abort", cancelCompact);
    cleanupNotifications();
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readKimiCompactionResult(
  text: string,
): { tokensBefore: number; tokensAfter: number } | undefined {
  if (!/Compaction completed\./i.test(text)) return undefined;
  const before = /Tokens before:\s*([\d,]+)/i.exec(text)?.[1];
  const after = /Tokens after:\s*([\d,]+)/i.exec(text)?.[1];
  if (!before || !after) return undefined;
  const tokensBefore = Number(before.replaceAll(",", ""));
  const tokensAfter = Number(after.replaceAll(",", ""));
  if (!Number.isFinite(tokensBefore) || !Number.isFinite(tokensAfter))
    return undefined;
  return { tokensBefore, tokensAfter };
}
