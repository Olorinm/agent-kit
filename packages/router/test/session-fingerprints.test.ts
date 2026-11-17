import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableStore } from "../src/communication/store.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import type { ManagedAgent } from "../src/service/managed.js";
import { agentChannelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import type { HostPort, HostRun, HostStartInput } from "../src/execution/host.js";
import { digest } from "../src/execution/protocol.js";
import { CHAT, withChat } from "./fixtures/chat-channel.js";

/**
 * Everything a stored session is checked against must stay the same for a product that uses none of the options added
 * with owner routes, owner requests, senders and text delivery (ADR 0005 section 20):
 *
 * - `communication_host/scope`, which Router compares on every start (`host_binding_configuration_changed`);
 * - the Host session definition, which a Host derives from the `runtimeId`, `instructions` and `tools` of each start
 *   request and compares with the stored session (`session_configuration_conflict`); a Codex Host derives its native
 *   binding fingerprint from the same `instructions` and `tools` (`session_scope_changed`);
 * - Router's own session bindings (`execution_sessions`), which select the Host session and whether it has the tools;
 * - the input a Codex thread receives for owner, scheduled and delegated turns.
 *
 * `fixtures/session-fingerprints.json` was written by this test on the commit before those options existed
 * (`UPDATE_SESSION_FINGERPRINTS=1`), for the fixed agent and the four kinds of turn below. Regenerate it only for a
 * change that is meant to move existing sessions, and say so in the changelog.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/session-fingerprints.json", import.meta.url));
const agent: ManagedAgent = { id: "11111111-1111-4111-8111-111111111111", owner: "@alice:example.test", name: "helper",
  address: "alice/helper@example.test", matrixId: "@_ar_11111111111141118111111111111111:example.test",
  createdAt: "2026-01-01T00:00:00.000Z", status: "active" };
class Host implements HostPort {
  identity = "fixture-host";
  starts: HostStartInput[] = [];
  runs = new Map<string, HostRun>();
  async connect() {}
  /** A Codex runtime as its Host describes it. */
  async inspectRuntime(runtimeId: string) { return { id: runtimeId, cwd: "/workspace", capabilities: { features: { "input.nativeItems": { status: "supported" } } } }; }
  async start(input: HostStartInput) {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: "done" };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async cancel() {}
  async calls() { return []; }
  async resolve() {}
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

describe("session fingerprints of an existing configuration", () => {
  it("are what they were before owner routes, owner requests, senders and text delivery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "router-fingerprints-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = new DurableStore(":memory:", agent.matrixId); cleanup.push(() => store.close());
    const runtime = new AgentRuntime(agent.matrixId, store), host = new Host();
    runtime.start(); cleanup.push(() => runtime.stop());
    const config = agentChannelConfigSchema.parse({ agentId: agent.id, connections: [],
      host: { binding: "default", runtimeId: "codex", instanceName: "channel-host", instructions: "You are the fixture agent." } });
    const extension = withChat(await createChannelRuntime(agent, runtime, config, directory,
      () => ({ id: "22222222-2222-4222-8222-222222222222", validate: () => {} }), host), [agent.owner]);
    await extension.start(); cleanup.push(() => extension.stop());
    const core = extension.communication!, sessions = extension.sessions!, admission = { owner: agent.owner, agentId: agent.id };
    const tasks: string[] = [];
    // 1. The owner writes in a private chat.
    const message = core.receive(CHAT, { externalId: "m1", sender: agent.owner, scope: "direct", threadId: "private", text: "hello",
      reply: { target: "private", messageId: "m1", data: {} } });
    await until(() => host.starts.length === 1 && core.inputById(message.id)?.state === "done");
    tasks.push(core.inputById(message.id)!.taskId!);
    // 2. A scheduled turn in that conversation, 3. a delegated turn in its own session, 4. the owner's own work.
    const submissions = [
      { eventId: "rule-1-run-1", sessionId: message.conversationId, input: "Check the inbox.", admission: { ...admission, kind: "schedule" as const, reference: "rule-1", toolGrants: {} } },
      { eventId: "delegated-1", input: "Summarize the report.", admission: { ...admission, kind: "delegation" as const, reference: "call-1", toolGrants: {} },
        context: { source: "delegated_work", parentReference: "reference-1", callId: "call-1" } },
      { eventId: "own-1", sessionId: "notes", input: "Write the notes.", admission: { ...admission, kind: "owner" as const, reference: "own-1" } },
    ];
    for (const [index, submission] of submissions.entries()) {
      tasks.push((await sessions.submit(submission)).taskId);
      await until(() => host.starts.length === index + 2 && sessions.get(submission.eventId).status === "completed");
    }
    // Task ids are random; everything else of a start request except its request key is a function of the configuration.
    const stable = (value: unknown) => tasks.reduce((text, id, index) => text.replaceAll(id, `<task-${index + 1}>`), JSON.stringify(value));
    const turns = host.starts.map(({ requestKey: _requestKey, ...request }) => request);
    const actual = {
      hostScope: store.get<string>("communication_host", "scope"),
      // What a Host builds its session definition and its native binding fingerprint from.
      sessionDefinitions: turns.map((turn) => digest({ sessionId: turn.sessionId, runtimeId: turn.runtimeId, instructions: turn.instructions, tools: turn.tools ?? [] })),
      // The whole request of each turn: the input a Codex thread receives, its context and its admission.
      turns: turns.map((turn) => digest(stable(turn))),
      delivered: turns.map((turn) => turn.toolOutput ? JSON.stringify(turn.toolOutput) : turn.input),
      bindings: digest(stable(store.entries("execution_sessions"))),
    };
    if (process.env.UPDATE_SESSION_FINGERPRINTS === "1") writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
    expect(existsSync(FIXTURE)).toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  }, 30_000);
});
