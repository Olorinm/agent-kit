import { CommunicationCore } from "../../src/communication/core.js";
import { DurableStore } from "../../src/communication/store.js";
import { CliWork } from "../../src/execution/work.js";
import { HostWorker } from "../../src/execution/host-worker.js";
import { RunObservation } from "../../src/execution/observation.js";
import { WorkSessions } from "../../src/execution/sessions.js";
import type { HostCall, HostPort, HostRun, HostStartInput } from "../../src/execution/host.js";
import type { HostTools } from "../../src/execution/tools.js";
import { ChannelHttpError } from "../../src/http.js";
import { LedgerControl } from "../../src/ledger/control.js";
import type { ChannelAdapter, ChannelContent, ChannelContext, NotifyPolicy, ReplyRoute } from "../../src/channels/api.js";

/** Synthetic identities of the harness agent. */
export const AGENT = "agent-a", OWNER = "@alice:example.test", OWNER_PERSON = "p_alice", OWNER_ON_CHAT = "alice-on-chat";

/** A scripted Host: runs stay `running` until the test finishes them. */
export class WorkHost implements HostPort {
  identity = "fixture-host";
  starts: HostStartInput[] = [];
  runs = new Map<string, HostRun>();
  pending: HostCall[] = [];
  resolved: Array<{ runId: string; callId: string; result: unknown }> = [];
  inspections = 0;
  /** What the Host reports for `input.nativeItems`; undefined: a description without capabilities. */
  nativeItems: "supported" | "unsupported" | undefined;
  failStart: Error | undefined;
  async connect() {}
  async inspectRuntime(runtimeId: string) {
    this.inspections++;
    return { id: runtimeId, cwd: "/workspace", ...(this.nativeItems ? { capabilities: { features: { "input.nativeItems": { status: this.nativeItems } } } } : {}) };
  }
  async start(input: HostStartInput) {
    this.starts.push(input);
    if (this.failStart) throw this.failStart;
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "" };
    this.runs.set(run.id, run);
    return run;
  }
  async get(id: string) { return { ...this.runs.get(id)! }; }
  async cancel(id: string) { const run = this.runs.get(id)!; if (run.status === "running") run.status = "cancelled"; }
  async calls(id: string) { return this.pending.filter((call) => call.runId === id).map((call) => ({ ...call })); }
  async resolve(id: string, callId: string, result: unknown) {
    const call = this.pending.find((item) => item.runId === id && item.id === callId);
    if (!call || call.status !== "pending") throw new ChannelHttpError(404, "interaction_not_found");
    call.status = "completed"; this.resolved.push({ runId: id, callId, result });
  }
  /** Finish a run (its id, or its 1-based number in start order) with an answer. */
  finish(run: number | string, answer: string, status: HostRun["status"] = "completed") { Object.assign(this.runs.get(typeof run === "number" ? `run-${run}` : run)!, { status, answer }); }
  ask(n: number, call: Pick<HostCall, "id" | "name" | "input"> & { deadlineAt?: string }) {
    this.pending.push({ kind: "interaction", status: "pending", deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), ...call, runId: `run-${n}` });
  }
}

/** A channel adapter that records what it is asked to send. `transcript`: the event is the delivery (the web surface). */
export class Surface implements ChannelAdapter {
  readonly retrySafe = true;
  readonly capabilities: { receive: string[]; send: string[]; stream: boolean; buttons: boolean; native: string[] };
  sent: Array<{ route: ReplyRoute; text: string; buttons?: Array<{ label: string; token: string }> | undefined }> = [];
  context!: ChannelContext;
  fail: Error | undefined;
  constructor(readonly kind: string, readonly ledgerDelivery = false, buttons = false) {
    this.capabilities = { receive: ["text"], send: ["text"], stream: false, buttons, native: [] };
  }
  async start(context: ChannelContext) { this.context = context; }
  async stop() {}
  async send(route: ReplyRoute, text: string) {
    if (this.fail) throw this.fail;
    this.sent.push({ route, text }); return { externalId: `${this.kind}-m${this.sent.length}` };
  }
  async sendContent(route: ReplyRoute, content: ChannelContent) {
    if (this.fail) throw this.fail;
    this.sent.push({ route, text: content.text, buttons: content.buttons }); return { externalId: `${this.kind}-m${this.sent.length}` };
  }
  /** The owner writes in a private chat on this connection. */
  say(id: string, text: string, sender: string, extra: Partial<Parameters<ChannelContext["receive"]>[0]> = {}) {
    this.context.receive({ externalId: id, sender, threadId: sender, scope: "direct", text, reply: { target: sender, messageId: id, data: {} }, ...extra });
  }
}
/** A one-way push channel. */
export class Push implements ChannelAdapter {
  readonly kind = "push";
  readonly retrySafe = false;
  readonly capabilities = { receive: [] as string[], send: ["text"], stream: false, buttons: false, native: [] as string[] };
  pushed: Array<{ text: string; purpose: string | undefined }> = [];
  async start() {}
  async stop() {}
  async send(route: ReplyRoute, text: string) { this.pushed.push({ text, purpose: route.data.purpose }); return { externalId: `p${this.pushed.length}` }; }
}

export interface HarnessOptions {
  /** A file path keeps the store across `harness` calls (restart tests); default is in memory. */
  path?: string; host?: WorkHost; tools?: HostTools; buttons?: boolean;
  /** Registers a push connection with this notify policy. */
  notify?: Partial<NotifyPolicy>;
  /** Leaves the external chat connection out (a connection that was removed). */
  withoutChat?: boolean;
}
/**
 * One agent wired as `createChannelRuntime` wires it (channel core, Host worker, card control, work sessions), with a
 * transcript surface as `web`, an external chat connection as `chat`, and loops the test drives itself with `round`.
 */
export async function harness(options: HarnessOptions = {}) {
  const store = new DurableStore(options.path ?? ":memory:", AGENT);
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore(AGENT, store, work);
  core.ownerPersonId = OWNER_PERSON;
  const web = new Surface("web", true), chat = new Surface("chat", false, options.buttons), push = new Push();
  core.register({ id: "web", ownerAddresses: [OWNER_PERSON] }, web);
  if (!options.withoutChat) core.register({ id: "chat", ownerAddresses: [OWNER_ON_CHAT] }, chat);
  if (options.notify) core.register({ id: "push", ownerAddresses: [], notify: { replies: true, replyAfterSeconds: 0, questions: true, schedules: true, ...options.notify } }, push);
  await core.start();
  const host = options.host ?? new WorkHost();
  // The channel tool as the service declares it: a received message admits it, an owner route alone does not.
  const tools: HostTools = options.tools ?? { definitions: [{ name: "channel", description: "Use the conversation's channel.", inputSchema: { type: "object" }, timeoutMs: 1000 }],
    instructions: "\nUse the channel tool for native channel content.\n",
    allowed: (_conversationId, taskId) => { const input = core.input(taskId); return Boolean(input) && !input!.routed; },
    execute: async () => ({ success: true, contentItems: [{ type: "inputText", text: "{}" }] }) };
  const worker = new HostWorker(AGENT, "instance", store, work, host, "runtime", "You are the fixture agent.", () => {},
    (taskId, answer) => core.saveResult(taskId, answer), tools, core);
  const control = new LedgerControl({ agentId: AGENT, ownerPersonId: OWNER_PERSON, store, ledger: core.ledger, core, work,
    observation: new RunObservation(store, work, host), host, closeUnknown: (claimId) => worker.closeUnknown(claimId) });
  control.replanGraceMs = 0;
  worker.control = control;
  core.control = async (input) => Boolean(await control.command(input)) || Boolean(await worker.handleInput(input));
  const sessions = new WorkSessions(AGENT, OWNER, "runtime", "instance", store, work, host, core, () => {}, (input) => worker.dependencyWait(input));
  /** What the service loops do, a few times over: dispatch, Host observation, result publication, delivery. */
  const round = async (times = 3) => { for (let i = 0; i < times; i++) { await core.dispatch(); await worker.tick(); await core.dispatch(); await core.flush(); } };
  const close = async () => { await core.stop(); store.close(); };
  return { store, work, core, ledger: core.ledger, web, chat, push, host, worker, control, sessions, round, close };
}
export type Harness = Awaited<ReturnType<typeof harness>>;
export const admission = (kind: "owner" | "delegation" | "schedule", reference = "reference-1") =>
  ({ kind, owner: OWNER, agentId: AGENT, reference, ...(kind === "owner" ? {} : { toolGrants: {} }) });
