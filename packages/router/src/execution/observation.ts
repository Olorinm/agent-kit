import { ChannelHttpError } from "../http.js";
import type { ChannelMessage } from "../communication/types.js";
import type { DurableStore } from "../communication/store.js";
import type { HostPort, HostRun } from "./host.js";
import type { ExecutionSession, RunBinding } from "./host-worker.js";
import { CliWork, WorkError } from "./work.js";
import { archiveRun, archivedEvents, runArchive } from "./run-archive.js";
import { AgentLedger } from "../ledger/ledger.js";

export interface TaskFilter {
  connectionId?: string | undefined;
  target?: string | undefined;
  conversationId?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}
export interface RunReference {
  claimId: string;
  taskId: string;
  conversationId: string;
  sessionId: string;
  runId: string | null;
  phase: RunBinding["phase"];
  error: string | null;
}
export interface CommunicationTask {
  id: string;
  conversationId: string;
  receivedAt: string;
  source: { connectionId: string; messageId: string; target: string; sender: string; scope: "direct" | "group" };
  status: string;
  cancelRequested: boolean;
  runs: RunReference[];
  replyMessageIds: string[];
  interactionMessageIds: string[];
}

/** Owner-scoped observation of Router bindings through the Host's public protocol.
 * Host owns live event history, sequence numbers and interaction decisions. Finished runs
 * are served from Router's compact archive so history stays readable while the Host sleeps.
 */
export class RunObservation {
  constructor(readonly store: DurableStore, readonly work: CliWork, readonly host: HostPort) {}
  /** Channel turns, newest first. Each is reported by its first received message, also when later messages resumed it. */
  tasks(filter: TaskFilter = {}): { data: CommunicationTask[]; next: string | null } {
    const ledger = AgentLedger.open(this.store), limit = filter.limit ?? 50;
    const origins = ledger.turnOrigins({ connectionId: filter.connectionId, sessionKey: filter.conversationId, target: filter.target, before: filter.before, limit: limit + 1 });
    if (!origins) throw new WorkError("task_cursor_not_found", 404);
    const bindings = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value);
    const questions = this.store.entries<{ taskId: string; noticeId: string }>("communication_questions").map(({ value }) => value);
    const ids = (value: string | null | undefined) => value ? value.split(",") : [];
    const data = origins.slice(0, limit).flatMap(({ turnId, claim }): CommunicationTask[] => {
      const source = claim.source as ChannelMessage | null; if (!source) return [];
      const task = this.work.inspect(turnId), sent = ledger.turnDeliveries(turnId);
      // On a connection where the event is the delivery (web), a reply or notice without a delivery is named by its event.
      const delivered = new Set(sent.map((item) => item.eventId));
      const recorded = ledger.turnEvents(turnId).filter((event) => !delivered.has(event.eventId)).filter((event) => event.role !== "user" &&
        (event.kind === "message" && event.body.final === true || event.kind === "notice" && Boolean(event.idempotencyKey?.startsWith("notice:")))).map((event) => event.eventId);
      return [{ id: turnId, conversationId: claim.sessionKey ?? "", receivedAt: new Date(claim.receivedAt).toISOString(),
        source: { connectionId: claim.connectionId, messageId: source.externalId, target: source.reply.target, sender: source.sender, scope: source.scope },
        status: task.status, cancelRequested: task.cancelRequested,
        runs: bindings.filter((binding) => binding.taskId === turnId).map((binding) => this.reference(binding)),
        replyMessageIds: [...new Set([...(this.store.get<string[]>("communication_progress_messages", turnId) ?? []),
          ...sent.flatMap((item) => ids(item.platformMessageId)), ...recorded])],
        interactionMessageIds: questions.filter((question) => question.taskId === turnId).flatMap((question) => ids(ledger.delivery(question.noticeId)?.platformMessageId)) }];
    });
    return { data, next: origins.length > limit ? origins[limit - 1]!.turnId : null };
  }
  private binding(claimId: string): RunBinding {
    const binding = this.store.get<RunBinding>("communication_runs", claimId);
    if (!binding) throw new WorkError("run_not_found", 404);
    return binding;
  }
  private reference(binding: RunBinding): RunReference {
    return { claimId: binding.claimId, taskId: binding.taskId, conversationId: binding.contextId,
      sessionId: binding.sessionId, runId: binding.runId ?? null, phase: binding.phase, error: binding.error ?? null };
  }
  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ChannelHttpError && [400, 404, 409, 422].includes(error.status))
        throw new WorkError(error.code, error.status);
      throw error;
    }
  }
  private async scopedRun(binding: RunBinding): Promise<HostRun> {
    if (!binding.runId) throw new WorkError("host_run_unavailable", 409);
    const run = await this.request(() => this.host.get(binding.runId!));
    const session = this.store.get<ExecutionSession>("execution_sessions", binding.contextId);
    if (run.id !== binding.runId || run.sessionId !== binding.sessionId || run.runtimeId !== session?.runtimeId)
      throw new WorkError("host_run_scope_mismatch", 409);
    return run;
  }
  /** A finished run's archive; created from the Host once, after the usual scope checks. */
  private async archived(binding: RunBinding) {
    if (binding.phase !== "finished" || !binding.runId) return undefined;
    const saved = runArchive(this.store, binding.claimId);
    if (saved?.runId === binding.runId) return saved;
    try {
      await this.scopedRun(binding);
      return await archiveRun(this.store, this.host, binding.claimId, binding.runId);
    } catch { return undefined; }
  }
  async run(claimId: string) {
    const binding = this.binding(claimId), archive = await this.archived(binding);
    if (archive) return { ...this.reference(binding), run: archive.run, calls: archive.calls };
    const run = await this.scopedRun(binding);
    const calls = await this.request(() => this.host.calls(run.id));
    if (calls.some((call) => call.runId !== run.id)) throw new WorkError("host_call_scope_mismatch", 409);
    return { ...this.reference(binding), run, calls };
  }
  async events(claimId: string, after = 0, limit = 200) {
    const binding = this.binding(claimId), archive = await this.archived(binding);
    if (archive) return archivedEvents(archive, after, limit);
    await this.scopedRun(binding);
    if (!this.host.events) throw new WorkError("host_events_unsupported", 409);
    const page = await this.request(() => this.host.events!(binding.runId!, after, limit));
    if (page.events.some(({ event }) => event.runId !== binding.runId)) throw new WorkError("host_event_scope_mismatch", 409);
    return page;
  }
  async resolve(claimId: string, callId: string, result: unknown) {
    const { run, calls } = await this.run(claimId);
    const call = calls.find((item) => item.id === callId && item.kind === "interaction");
    if (!call) throw new WorkError("interaction_not_found", 404);
    // The Host arbitrates expiry, repeated identical answers and conflicting answers.
    await this.request(() => this.host.resolve(run.id, callId, result));
  }
  async cancel(taskId: string) {
    // Turns of every admission (channel, work, schedule) are in the ledger (ADR 16.2).
    if (!AgentLedger.open(this.store).turn(taskId)) throw new WorkError("task_not_found", 404);
    await this.work.cancel(taskId);
  }
}
