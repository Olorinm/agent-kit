// Compatibility for the Pi events exposed by Host before pi-durable 1.5 removed watchEvents().
// Event shapes and translation are adapted from v1.2.0 (MIT, see NOTICE). Pi 1.6
// exposes live conversation views and stored commits through separate public observers.
import { AsyncEventQueue } from "../async-event-queue.js";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Op, Path } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
    AgentDoc, NestedCallDoc, UsageDoc,
    type AgentState, type CommitChange, type CommitPublication, type CompactionFailure,
    type CompactionReason, type CompactionStatus, type ConversationId, type ConversationView,
    type DocumentId, type EntryRecord, type Harness, type InboxItem, type InboxState, type JsonObject,
    type LiveState, type NestedCallState, type NestedToolExecutionResult, type NestedToolSlot,
    type SubmissionId, type SubmissionRecord, type TaskId, type ToolDiagnostic,
    type ToolSlot, type UsageState,
} from "@earendil-works/pi-durable";

type Block = AssistantMessage["content"][number];
type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };

/** One change to the in-flight assistant message, relative to that message. */
export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };

export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly EntryRecord[];
	run?: { inputs: readonly SubmissionId[] };
	/** Current generation attempt: its in-flight partial, retry backoff, or deferred poll. */
	generation?: {
		attempt: number;
		message?: AssistantMessage;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlot[];
	/** `pi.live.nestedTools`: nested calls of running tool calls. */
	nestedTools: readonly NestedToolSlot[];
	/** `pi.live.compactions`: live compactions with their attempt and retry backoff. */
	compactions: readonly (Omit<CompactionStatus, "trigger"> & { reason: CompactionReason })[];
	/** `pi.live.compactionFailure`: the newest compaction failure since a compaction last produced a summary. */
	compactionFailure?: Omit<CompactionFailure, "trigger"> & { reason: CompactionReason };
	inbox: readonly QueuedItem[];
	/** `pi.agent`; `{}` when absent. */
	agent: AgentState;
	usage: UsageState;
};

/** Host callback and native notification payloads retained from the v1.2.0 event API. */
export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly SubmissionId[] }
	| { type: "run_end"; inputs: readonly SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	/** `usage` is the partial's current usage, as in the coding agent's JSON mode. */
	| { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| ({ type: "tool_execution_start"; args: JsonObject } & ToolEventCall)
	| ({
			type: "tool_execution_update";
			/** A front trim and then an append of the retained window, or its replacement. */
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: JsonValue;
			diagnostics?: readonly ToolDiagnostic[];
	  } & ToolEventCall)
	/**
	 * A model-issued call ends with its result `entry`, a nested call with its `result`. Both are absent when the tool
	 * task faulted or was orphaned, or when the call's slot left `pi.live` unfinished: its run ended, or its parent
	 * settled first.
	 */
	| ({ type: "tool_execution_end"; entry?: EntryRecord; result?: NestedToolExecutionResult } & ToolEventCall)
	| { type: "inbox_update"; items: readonly QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "agent_changed"; agent: AgentState }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string }
	| { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
	/**
	 * The task's receipt tells whether it produced a summary; the summary entry has its own events. `error` is set when
	 * the compaction failed, faulted, or was orphaned, as in `pi.live.compactionFailure`.
	 */
	| { type: "compaction_end"; taskId: TaskId; reason: CompactionReason; error?: string };

/**
 * Which call a tool event is about. `toolCallId` is the call's ID in the transcript and in tool events: the provider's
 * ID for a model-issued call, `<parent call ID>/<key>` for a nested one. Match events by it; do not parse it. `taskId`
 * is the call's tool task, absent for a call that never got one (not offered, or not started in a sequential round).
 * A nested call also names the call that made it, by call ID and by tool task.
 */
export type ToolEventCall = {
	toolCallId: string;
	toolName: string;
	taskId?: TaskId;
	parentToolCallId?: string;
	parentTaskId?: TaskId;
};

/** The typed parts of a view the events read. */
type Parts = {
	live: LiveState;
	inbox: InboxState | undefined;
	agent: AgentState | undefined;
	usage: UsageState | undefined;
};

function parts(view: ConversationView): Parts {
	return {
		live: (view.docs["pi.live"] ?? {}) as LiveState,
		inbox: view.docs["pi.inbox"] as InboxState | undefined,
		agent: view.docs["pi.agent"] as AgentState | undefined,
		usage: view.docs["pi.usage"] as UsageState | undefined,
	};
}

function queued(inbox: InboxState | undefined): QueuedItem[] {
	return (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode }));
}


type Change =
  | { kind: "view"; value: ConversationView; ops: readonly Op[] }
  | { kind: "commit"; publication: CommitPublication };

export async function observeEvents(
  harness: Harness, id: ConversationId, context: Context,
  deliver: (events: readonly AgentEvent[]) => void,
): Promise<() => Promise<void>> {
  // Pi observers may only record changes. Project events and invoke user code outside
  // the Session's adoption path, in observation order, including progress before storage.
  const pending = new AsyncEventQueue<Change>();
  const view = await harness.observeConversation(id, {
    advance(call) {
      if (call.kind === "value") pending.push({ kind: "view", value: call.value, ops: call.ops });
    },
    end() {},
  }, context);
  const commits = harness.observeCommits({
    advance(publication) { pending.push({ kind: "commit", publication }); },
    end() {},
  });
  const drain = (async () => {
    let current = view.value;
    let stored = view.value;
    let assistantStartSeen = false;
    const held = new Set<TaskId>();
    const incarnations = new Map<string, DocumentId>();
    for await (const change of pending) {
      if (change.kind === "view") {
        const events = progress(parts(current), parts(change.value), change.ops);
        if (events.some((event) => event.type === "message_start")) assistantStartSeen = true;
        deliver(events);
        current = change.value;
        continue;
      }
      const docs = { ...stored.docs };
      for (const item of change.publication.changes) {
        if (item.type !== "document" || item.conversationId !== id || item.record.key !== undefined ||
            item.record.scope.kind !== "conversation") continue;
        const { kind } = item.record;
        if (item.kind === "change") {
          docs[kind] = item.value;
          incarnations.set(kind, item.record.id);
        } else if (!incarnations.has(kind) || incarnations.get(kind) === item.record.id) {
          delete docs[kind];
          incarnations.delete(kind);
        }
      }
      const previous = stored;
      stored = { ...previous, docs };
      const events = translate(id, previous, stored, change.publication, held);
      // The terminal commit may coalesce all pending writes to pi.live. Only the
      // observed view tells us whether this assistant entry already had a start.
      deliver(events.filter((event) => {
        if (event.type === "message_start" && event.message.role === "assistant" && assistantStartSeen) return false;
        if (event.type === "message_end" && event.entry.model?.[0]?.role === "assistant") assistantStartSeen = false;
        return true;
      }));
    }
  })();
  // The turn awaits drain on detach. Stop buffering if projection fails before then.
  void drain.catch(() => pending.close());
  return async () => {
    view.detach();
    commits.detach();
    pending.close();
    await drain;
  };
}

type TaskChange = Extract<CommitChange, { type: "task" }>;

/** The tool result for `callId` among `entries`. */
function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
	return entries.find((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" && message.toolCallId === callId;
	});
}

/** Project settled state and receipts from one stored commit in the legacy event order. */
function translate(
	conversationId: ConversationId,
	before: ConversationView,
	after: ConversationView,
	publication: CommitPublication,
	held: Set<TaskId>,
): AgentEvent[] {
	const entries: EntryRecord[] = [];
	const tasks = new Map<TaskId, TaskChange["value"]>();
	const submissions: SubmissionRecord[] = [];
	// Nested results this commit stored, by nested task ID; read now, since the caller's documents may retire next.
	const nestedResults = new Map<TaskId, NestedToolExecutionResult>();
	for (const change of publication.changes) {
		if (
			change.type === "document" &&
			change.record.kind === NestedCallDoc.definition.kind &&
			change.kind === "change" &&
			change.conversationId === conversationId
		) {
			const state = change.value as NestedCallState;
			if (state.taskId !== undefined && state.result !== undefined) {
				nestedResults.set(state.taskId, state.result as unknown as NestedToolExecutionResult);
			}
		}
		if (change.type === "entry" && change.value.conversationId === conversationId) entries.push(change.value);
		if (change.type === "task" && change.value.conversationId === conversationId)
			tasks.set(change.value.id, change.value);
		if (change.type === "submission" && change.value.conversationId === conversationId) {
			submissions.push(change.value);
		}
	}

	// CommitPublication does not promise ordering. Replay transcript entries and submissions by ID.
	entries.sort((a, b) => a.id - b.id);
	submissions.sort((a, b) => a.id - b.id);
	const was = parts(before);
	const now = parts(after);
	const events: AgentEvent[] = [];

	// Tool intents, retry state and deferred requests come from stored commits.
	const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const slots = now.live.tools ?? [];
	const nestedBefore = new Map((was.live.nestedTools ?? []).map((slot) => [slot.taskId, slot]));
	const nested = now.live.nestedTools ?? [];
	for (const slot of [...slots, ...nested]) {
		const previous = "parentCallId" in slot ? nestedBefore.get(slot.taskId) : slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status === "running") continue;
		// A nested slot carries the arguments the call runs with; a model-issued call's are in its intent checkpoint.
		const checkpoint = slot.taskId === undefined ? undefined : tasks.get(slot.taskId)?.state.checkpoint;
		const args =
			"parentCallId" in slot
				? slot.arguments
				: ((checkpoint as { arguments?: JsonObject } | undefined)?.arguments ?? {});
		events.push({ type: "tool_execution_start", ...callOf(slot), args });
	}
	const generation = now.live.generation;
	const generationBefore = was.live.generation;
	if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
		const { at, error } = generation.retry;
		events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
	}
	if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
		events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
	}
	if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) {
		events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
	}

	// Tools that end in this commit: a slot that becomes done, one created done (a call not offered), or an unfinished
	// one that vanishes because its run ended. A done slot that vanishes ended earlier.
	const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
	const endTool = (slot: ToolSlot, entryId: number | undefined): void => {
		const entry = entries.find((candidate) => candidate.id === entryId);
		toolEnds.push({ type: "tool_execution_end", ...callOf(slot), ...(entry === undefined ? {} : { entry }) });
	};
	for (const previous of slotsBefore.values()) {
		if (previous.status === "done") continue;
		const slot = slots.find((candidate) => candidate.callId === previous.callId);
		if (slot?.status === "done") endTool(slot, slot.entry);
		// A slot whose run ended in this commit may have had its result appended with it, as for unstarted calls.
		else if (slot === undefined) endTool(previous, resultOf(entries, previous.callId)?.id);
	}
	for (const slot of slots) {
		if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot, slot.entry);
	}
	// Nested calls that end in this commit, the same way, children before the calls that made them: the lists hold
	// parents first, so walk them backwards.
	const endNested = (slot: NestedToolSlot): void => {
		const result = nestedResults.get(slot.taskId);
		events.push({ type: "tool_execution_end", ...callOf(slot), ...(result === undefined ? {} : { result }) });
	};
	const nestedNow = new Map(nested.map((slot) => [slot.taskId, slot]));
	for (const previous of [...nestedBefore.values()].reverse()) {
		if (previous.status === "done") continue;
		const slot = nestedNow.get(previous.taskId);
		if (slot?.status === "done" || slot === undefined) endNested(slot ?? previous);
	}
	for (const slot of [...nested].reverse()) {
		if (slot.status === "done" && !nestedBefore.has(slot.taskId)) endNested(slot);
	}

	// Entries in append order; a tool's end directly precedes its result's message, as in the coding agent.
	for (const entry of entries) {
		events.push(...toolEnds.filter((end) => end.entry === entry));
		const message = entry.model?.[0];
		if (message === undefined) {
			events.push({ type: "entry_appended", entry });
			continue;
		}
		events.push({ type: "message_start", message });
		events.push({ type: "message_end", entry });
	}
	// Ends without a result entry: a faulted or orphaned tool, or one whose run ended.
	events.push(...toolEnds.filter((end) => end.entry === undefined));

	// Compaction ends, task failures, then turn and run ends.
	const compactionsBefore = was.live.compactions ?? [];
	const compactions = now.live.compactions ?? [];
	const failure = now.live.compactionFailure;
	for (const { taskId, trigger: reason } of compactionsBefore) {
		if (!compactions.some((status) => status.taskId === taskId)) {
			const error = failure?.taskId === taskId ? failure.error : undefined;
			events.push({ type: "compaction_end", taskId, reason, ...(error === undefined ? {} : { error }) });
		}
	}
	// A generation's turn ends when its outcome is committed: at a `completing` hold or at terminal, whichever comes
	// first, so a successor created at the hold starts after it.
	let turnEnded = false;
	for (const task of tasks.values()) {
		const status = task.state.status;
		if (task.kind === "pi.generation" && status === "completing" && !held.has(task.id)) {
			held.add(task.id);
			turnEnded = true;
		}
		if (status !== "terminal") continue;
		if (task.kind === "pi.generation" && !held.delete(task.id)) turnEnded = true;
		const outcome = task.state.outcome;
		if (outcome.status === "faulted" || outcome.status === "orphaned") {
			const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
			events.push({ type: "task_failed", taskId: task.id, kind: task.kind, message });
		}
	}
	if (turnEnded) events.push({ type: "turn_end" });
	const run = now.live.run;
	const runBefore = was.live.run;
	const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
	if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });

	// Submissions, document state, then what began.
	for (const record of submissions) events.push({ type: "submission", record });
	if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
	// A retired document reads as its initial value, as in a snapshot.
	if (now.agent !== was.agent) {
		events.push({ type: "agent_changed", agent: now.agent ?? AgentDoc.definition.initial() });
	}
	if (now.usage !== was.usage)
		events.push({ type: "usage_changed", usage: now.usage ?? UsageDoc.definition.initial() });
	for (const { taskId, trigger: reason, blocking } of compactions) {
		if (!compactionsBefore.some((status) => status.taskId === taskId)) {
			events.push({ type: "compaction_start", taskId, reason, blocking });
		}
	}
	if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
	if (run !== undefined && run.taskId !== runBefore?.taskId && tasks.get(run.taskId)?.kind === "pi.generation") {
		events.push({ type: "turn_start" });
	}
	return events;
}

function progress(was: Parts, now: Parts, viewOps: readonly Op[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const slots = now.live.tools ?? [];
	const nestedBefore = new Map((was.live.nestedTools ?? []).map((slot) => [slot.taskId, slot]));
	const nested = now.live.nestedTools ?? [];
	const partialBefore = was.live.generation?.message as AssistantMessage | undefined;
	const partial = now.live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined && partialBefore === undefined) events.push({ type: "message_start", message: partial });
	else if (partial !== undefined && partial !== partialBefore) {
		events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(viewOps, partial) });
	}
	for (const [index, slot] of slots.entries()) {
		const previous = slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, ["tools", index], slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
	}
	for (const [index, slot] of nested.entries()) {
		const previous = nestedBefore.get(slot.taskId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, ["nestedTools", index], slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
	}
	return events;
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

/** Translate the view operations on the in-flight message into message changes (v1.2.0 event format). */
function messageChanges(viewOps: readonly Op[], message: AssistantMessage): MessageChange[] {
	const changes: MessageChange[] = [];
	// A block sent whole already holds every later change to it in this batch.
	const whole = new Set<number>();
	for (const op of viewOps) {
		// View operations never replace the root.
		const path = op[1] as Path;
		if (!startsWith(path, PARTIAL_PATH)) {
			// The whole message or generation was replaced.
			if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
			continue;
		}
		const rest = path.slice(PARTIAL_PATH.length);
		if (rest[0] === "usage") continue;
		if (rest[0] !== "content") return [{ type: "message", message }];
		if (rest.length === 1) {
			if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
			for (const [offset, block] of (op[4] as unknown as Block[]).entries()) {
				const type =
					block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
				changes.push({ type, contentIndex: op[2] + offset, block });
			}
			continue;
		}
		const contentIndex = rest[1] as number;
		const field = rest[2];
		if (whole.has(contentIndex)) continue;
		if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
			changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] });
		} else if (op[0] === "a" && field === "arguments") {
			changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
		} else {
			whole.add(contentIndex);
			changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
		}
	}
	return changes;
}

/** The identifying fields of a slot's tool events. */
function callOf(slot: ToolSlot | NestedToolSlot): ToolEventCall {
	return {
		toolCallId: slot.callId,
		toolName: slot.name,
		...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
		...("parentCallId" in slot ? { parentToolCallId: slot.parentCallId, parentTaskId: slot.parentTaskId } : {}),
	};
}

/** Output, details, and diagnostics changes of a running slot at `at` in `pi.live`, from the view operations on it. */
function toolUpdate(
	viewOps: readonly Op[],
	at: readonly ["tools" | "nestedTools", number],
	slot: ToolSlot | NestedToolSlot,
	previous: ToolSlot | NestedToolSlot,
): Omit<Extract<AgentEvent, { type: "tool_execution_update" }>, "type" | keyof ToolEventCall> | undefined {
	const outputPath = ["docs", "pi.live", ...at, "output"];
	let trimStart = 0;
	let append = "";
	let set = false;
	for (const op of viewOps) {
		if (!startsWith(op[1] as Path, outputPath)) continue;
		if (op[0] === "t") trimStart += op[2];
		else if (op[0] === "a") append += op[2];
		else set = true;
	}
	let output: { trimStart?: number; append?: string } | { set: string } | undefined;
	if (set || (slot.output !== previous.output && trimStart === 0 && append === ""))
		output = { set: slot.output ?? "" };
	else if (trimStart > 0 || append !== "") {
		output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
	}
	// A safe replay clears a running slot's progress: removed details send `null`, removed diagnostics `[]`.
	const update = {
		...(output === undefined ? {} : { output }),
		...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
		...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
	};
	return Object.keys(update).length === 0 ? undefined : update;
}

function startsWith(path: Path, prefix: readonly (string | number)[]): boolean {
	return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
