import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySession } from "../src/ledger/ledger.js";
import { admission, AGENT, harness, OWNER_ON_CHAT, OWNER_PERSON, WorkHost, type Harness, type HarnessOptions } from "./fixtures/work-harness.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async (options: HarnessOptions = {}) => { const h = await harness(options); cleanup.push(() => h.close()); return h; };
const OWNER_CHAT = legacySession(AGENT, "owner-main");
const finals = (h: Harness) => h.ledger.events(OWNER_CHAT).filter((event) => event.kind === "message" && event.body.final === true);
const inputs = (h: Harness) => h.ledger.events(OWNER_CHAT).filter((event) => event.kind === "message" && event.role === "user");
/** The owner writes on the external chat and the agent answers, so the owner conversation has a live route there. */
async function ownerTurnOnChat(h: Harness, id = "m1") {
  h.chat.say(id, "hello", OWNER_ON_CHAT);
  await h.round();
  h.host.finish(h.host.starts.length, "hi");
  await h.round();
  h.chat.sent = [];
}

describe("the owner conversation as a work target", () => {
  it("exists before the owner has written, and an owner message later continues the same session and Host session", async () => {
    const h = await setup();
    const { sessionId } = h.sessions.openOwnerConversation();
    expect(sessionId).toBe(OWNER_CHAT);
    expect(h.sessions.openOwnerConversation()).toEqual({ sessionId });
    expect(h.ledger.session(sessionId)).toMatchObject({ kind: "owner_main", label: "owner-main", lastSeq: 0 });
    // The session flag keeps its meaning: it says whether the owner has written, which `deliver` needs.
    expect(h.sessions.getSession(sessionId)).toMatchObject({ sessionId, ownerConversation: false, runs: [] });
    await h.sessions.submit({ eventId: "first", sessionId, input: "A message for you.", admission: admission("delegation") });
    await h.round();
    h.host.finish(1, "Noted.");
    await h.round();
    expect(h.sessions.get("first")).toMatchObject({ status: "completed", sessionId });
    // The owner's first message arrives afterwards, on an external connection.
    h.chat.say("m1", "what did you get?", OWNER_ON_CHAT);
    await h.round();
    expect(h.core.inputById(h.core.status().inbox[0]!.id)!.conversationId).toBe(sessionId);
    expect(h.host.starts).toHaveLength(2);
    // One Host session with one definition: the same instructions and tools for the work turn and the owner's turn.
    expect(h.host.starts[1]!.sessionId).toBe(h.host.starts[0]!.sessionId);
    expect(h.host.starts[1]!.instructions).toBe(h.host.starts[0]!.instructions);
    expect(h.host.starts[1]!.tools).toEqual(h.host.starts[0]!.tools);
    expect(h.host.starts[0]!.tools).toHaveLength(1);
    expect(h.ledger.sessions().map((session) => [session.sessionKey, session.kind])).toEqual([[sessionId, "owner_main"]]);
  });
  it("is opened as the owner conversation by a submission that names it, without a call to openOwnerConversation first", async () => {
    const h = await setup();
    await h.sessions.submit({ eventId: "first", sessionId: OWNER_CHAT, input: "A message for you.", admission: admission("schedule") });
    expect(h.ledger.session(OWNER_CHAT)).toMatchObject({ kind: "owner_main", label: "owner-main" });
    await h.round();
    expect(h.host.starts[0]!.tools).toHaveLength(1);
  });
  it("leaves a binding that already exists exactly as it is", async () => {
    const h = await setup();
    // A session an earlier release opened for work in the owner conversation, before the owner had written: no tools.
    const stored = { sessionId: "h-0123456789abcdef0123456789abcdef01234567", runtimeId: "runtime", channelTools: false };
    h.store.set("execution_sessions", OWNER_CHAT, stored);
    h.sessions.openOwnerConversation();
    await h.sessions.submit({ eventId: "later", sessionId: OWNER_CHAT, input: "A message for you.", admission: admission("delegation"), reply: {} });
    await h.round();
    expect(h.store.get("execution_sessions", OWNER_CHAT)).toEqual(stored);
    expect(h.host.starts[0]).toMatchObject({ sessionId: stored.sessionId, instructions: "You are the fixture agent." });
    expect(h.host.starts[0]).not.toHaveProperty("tools");
  });
  it("continues in the current window after the owner conversation was reset", async () => {
    const h = await setup();
    const { sessionId } = h.sessions.openOwnerConversation();
    await h.control.reset(sessionId);
    expect(h.sessions.openOwnerConversation()).toEqual({ sessionId });
    await h.sessions.submit({ eventId: "after-reset", sessionId, input: "Continue.", admission: admission("delegation"), reply: {} });
    await h.round();
    expect(h.host.starts).toHaveLength(1);
    expect(h.host.starts[0]!.tools).toHaveLength(1);
    expect(h.ledger.turn(h.sessions.get("after-reset").taskId)).toMatchObject({ sessionKey: sessionId, window: 2 });
  });
});

describe("a submitted turn that answers the owner", () => {
  it("follows the owner to the connection they were last on and sends the answer there like a channel reply", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    const submitted = await h.sessions.submit({ eventId: "result", sessionId: OWNER_CHAT, input: "The partner finished the report.", admission: admission("delegation"), reply: {} });
    expect(submitted.reply).toEqual({ connectionId: "chat", state: "pending", externalId: null, error: null });
    await h.round();
    expect(h.host.starts).toHaveLength(2);
    h.host.finish(2, "Your report is ready.");
    await h.round();
    // Sent once, on the owner's own private chat, as an answer to their newest message there.
    expect(h.chat.sent).toEqual([{ route: { connectionId: "chat", target: OWNER_ON_CHAT, messageId: "m1", data: {} }, text: "Your report is ready." }]);
    expect(h.sessions.get("result")).toMatchObject({ status: "completed", answer: "Your report is ready.",
      reply: { connectionId: "chat", state: "accepted", externalId: "chat-m1", error: null } });
    // One input and one answer on the transcript: the web shows each once, with the channel send as its delivery.
    expect(inputs(h).map((event) => event.body.text)).toEqual(["hello", "The partner finished the report."]);
    expect(finals(h).map((event) => event.body.text)).toEqual(["hi", "Your report is ready."]);
    const turn = h.ledger.turn(submitted.taskId)!;
    expect(turn).toMatchObject({ admission: "delegation", state: "completed", finalEventId: finals(h)[1]!.eventId,
      replyRoute: { connectionId: "chat", target: OWNER_ON_CHAT, messageId: "m1", data: {} } });
    expect(h.ledger.deliveriesFor(finals(h)[1]!.eventId).map((row) => [row.purpose, row.status])).toEqual([["reply", "sent"]]);
    // Publishing again (a redelivered work event, a second loop) adds nothing.
    await h.round();
    expect(h.chat.sent).toHaveLength(1);
    expect(finals(h)).toHaveLength(2);
  });
  it("records the answer on the transcript only for `web`, and for an owner who has not written anywhere", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    await h.sessions.submit({ eventId: "web-only", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: { connectionId: "web" } });
    await h.round(); h.host.finish(2, "Noted."); await h.round();
    expect(h.chat.sent).toEqual([]);
    expect(finals(h).at(-1)!.body).toMatchObject({ text: "Noted.", channel: "web" });
    expect(h.sessions.get("web-only").reply).toEqual({ connectionId: "web", state: "web", externalId: null, error: null });

    const fresh = await setup();
    const submitted = await fresh.sessions.submit({ eventId: "first", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: {} });
    expect(submitted.reply).toMatchObject({ connectionId: "web", state: "pending" });
    await fresh.round(); fresh.host.finish(1, "Noted."); await fresh.round();
    expect(finals(fresh).map((event) => event.body.text)).toEqual(["Noted."]);
    expect(fresh.sessions.get("first").reply).toMatchObject({ connectionId: "web", state: "web" });
    expect(fresh.ledger.turn(submitted.taskId)!.replyRoute).toEqual({ connectionId: "web", target: `person:${OWNER_PERSON}`, messageId: "", data: {} });
  });
  it("says so when the owner has no conversation on the named connection, and refuses a connection that is not registered", async () => {
    const h = await setup();
    h.web.say("w1", "hello", OWNER_PERSON);
    await h.round(); h.host.finish(1, "hi"); await h.round();
    await h.sessions.submit({ eventId: "elsewhere", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: { connectionId: "chat" } });
    await h.round(); h.host.finish(2, "Noted."); await h.round();
    expect(h.chat.sent).toEqual([]);
    expect(finals(h).at(-1)!.body.text).toBe("Noted.");
    expect(h.sessions.get("elsewhere").reply).toEqual({ connectionId: "chat", state: "suppressed", externalId: null, error: "no_conversation_on_connection" });
    await expect(h.sessions.submit({ eventId: "nowhere", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: { connectionId: "gone" } }))
      .rejects.toMatchObject({ message: "delivery_connection_not_found", status: 404 });
    expect(h.sessions.lookup("nowhere")).toBeNull();
    expect(h.host.starts).toHaveLength(2);
  });
  it("is only offered for turns in the owner conversation", async () => {
    const h = await setup();
    await expect(h.sessions.submit({ eventId: "other", sessionId: "rule-1", input: "Check.", admission: admission("schedule"), reply: {} }))
      .rejects.toMatchObject({ message: "reply_requires_owner_conversation", status: 403 });
    await expect(h.sessions.submit({ eventId: "fresh", input: "Check.", admission: admission("delegation"), reply: {} }))
      .rejects.toMatchObject({ message: "reply_requires_owner_conversation", status: 403 });
    await expect(h.sessions.submit({ eventId: "compact", sessionId: OWNER_CHAT, input: "", admission: admission("owner"), mode: "compact", reply: {} }))
      .rejects.toMatchObject({ message: "compaction_reply_unsupported", status: 400 });
    expect(h.work.list(true)).toEqual([]);
    expect(h.ledger.sessions()).toEqual([]);
  });
  it("waits its turn behind a running turn of the same conversation", async () => {
    const h = await setup();
    h.chat.say("m1", "a long task", OWNER_ON_CHAT);
    await h.round();
    await h.sessions.submit({ eventId: "queued", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: {} });
    await h.round();
    expect(h.host.starts).toHaveLength(1);
    expect(h.sessions.get("queued")).toMatchObject({ status: "submitted", reply: { state: "pending" } });
    h.host.finish(1, "The long task is done.");
    await h.round();
    expect(h.host.starts).toHaveLength(2);
    expect(h.host.starts[1]!.sessionId).toBe(h.host.starts[0]!.sessionId);
    h.host.finish(2, "And the partner finished too.");
    await h.round();
    expect(h.chat.sent.map((item) => item.text)).toEqual(["The long task is done.", "And the partner finished too."]);
  });
  it("reports a send that failed and a connection that was removed while the turn ran", async () => {
    const directory = mkdtempSync(join(tmpdir(), "owner-reply-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "agent.sqlite"), host = new WorkHost();
    const first = await harness({ path, host });
    await ownerTurnOnChat(first);
    await first.sessions.submit({ eventId: "removed", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: { connectionId: "chat" } });
    await first.round();
    await first.close();
    // The agent starts again without that connection.
    const second = await setup({ path, host, withoutChat: true });
    host.finish(2, "Your report is ready.");
    await second.round();
    expect(second.sessions.get("removed")).toMatchObject({ status: "completed", reply: { connectionId: "chat", state: "failed", error: "connection_removed" } });
    // The answer is still on the transcript.
    expect(finals(second).at(-1)!.body.text).toBe("Your report is ready.");

    const h = await setup();
    await ownerTurnOnChat(h);
    h.chat.fail = new Error("provider_down");
    await h.sessions.submit({ eventId: "failing", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: {} });
    await h.round(); h.host.finish(2, "Your report is ready."); await h.round();
    // A retry-safe channel keeps the delivery queued with the usual backoff; nothing is dropped.
    expect(h.sessions.get("failing").reply).toMatchObject({ connectionId: "chat", state: "queued", error: "provider_down" });
    h.chat.fail = undefined;
    await h.core.flush(Date.now() + 120_000);
    expect(h.sessions.get("failing").reply).toMatchObject({ state: "accepted" });
    expect(h.chat.sent.map((item) => item.text)).toEqual(["Your report is ready."]);
  });
  it("still runs a queued turn whose connection was removed before it started", async () => {
    const directory = mkdtempSync(join(tmpdir(), "owner-reply-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "agent.sqlite"), host = new WorkHost();
    const first = await harness({ path, host });
    await ownerTurnOnChat(first);
    first.chat.say("m2", "a long task", OWNER_ON_CHAT);
    await first.round();
    await first.sessions.submit({ eventId: "waiting", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: { connectionId: "chat" } });
    await first.round();
    expect(host.starts).toHaveLength(2);
    await first.close();
    const second = await setup({ path, host, withoutChat: true });
    host.finish(2, "The long task is done.");
    await second.round();
    expect(host.starts).toHaveLength(3);
    host.finish(3, "Your report is ready.");
    await second.round();
    expect(second.sessions.get("waiting")).toMatchObject({ status: "completed", answer: "Your report is ready.", reply: { connectionId: "chat", state: "failed", error: "connection_removed" } });
    expect(finals(second).at(-1)!.body.text).toBe("Your report is ready.");
  });
  it("tells the route that an outcome is unknown and keeps the retry card on the transcript", async () => {
    const h = await setup({ buttons: true });
    await ownerTurnOnChat(h);
    h.host.failStart = new Error("socket_hang_up");
    await h.sessions.submit({ eventId: "lost", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: {} });
    await h.round();
    expect(h.sessions.get("lost")).toMatchObject({ status: "unknown", outcomeUnknown: true, reply: { state: "pending" } });
    expect(h.chat.sent.map((item) => [item.text, item.buttons])).toEqual([["本轮是否已经执行暂时无法确认，系统不会自动重复执行。", undefined]]);
    // The card is the one work turns always had: on the transcript, where "重新执行" closes the turn without running it again.
    const [card] = h.ledger.openCards({ sessionKey: OWNER_CHAT });
    expect(card).toMatchObject({ source: "router", turnId: h.sessions.get("lost").taskId });
    expect((await h.control.answer(card!.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "0" })).status).toBe("accepted");
    await h.round();
    expect(h.sessions.get("lost")).toMatchObject({ status: "failed", outcomeUnknown: false });
    expect(h.host.starts).toHaveLength(2);
  });
  it("survives a restart while the turn runs, and between the end of the run and its publication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "owner-reply-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "agent.sqlite"), host = new WorkHost();
    let h = await harness({ path, host });
    await ownerTurnOnChat(h);
    await h.sessions.submit({ eventId: "running", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: {} });
    await h.round();
    expect(host.starts).toHaveLength(2);
    await h.close();
    h = await harness({ path, host });
    expect(h.sessions.lookup("running")).toMatchObject({ status: "working", reply: { connectionId: "chat", state: "pending" } });
    host.finish(2, "Your report is ready.");
    await h.round();
    expect(host.starts).toHaveLength(2);
    expect(h.chat.sent.map((item) => item.text)).toEqual(["Your report is ready."]);
    // The next turn ends in the Host worker, and the process stops before the channel core publishes it.
    await h.sessions.submit({ eventId: "unpublished", sessionId: OWNER_CHAT, input: "Another result.", admission: admission("delegation"), reply: {} });
    await h.round();
    host.finish(3, "Here is the other one.");
    await h.worker.tick(); await h.worker.tick();
    expect(h.sessions.get("unpublished")).toMatchObject({ status: "completed", reply: { state: "pending" } });
    await h.close();
    h = await setup({ path, host });
    expect(h.sessions.lookup("unpublished")).toMatchObject({ status: "completed", answer: "Here is the other one.", reply: { state: "pending" } });
    await h.round();
    expect(h.chat.sent.map((item) => item.text)).toEqual(["Here is the other one."]);
    expect(h.sessions.get("unpublished").reply).toMatchObject({ connectionId: "chat", state: "accepted" });
    expect(finals(h).map((event) => event.body.text)).toEqual(["hi", "Your report is ready.", "Here is the other one."]);
  });
  it("sends failures and cancellations along the same route", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    await h.sessions.submit({ eventId: "failed", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: {} });
    await h.round(); h.host.finish(2, "", "failed"); await h.round();
    expect(h.chat.sent.map((item) => item.text)).toEqual(["本轮执行未完成，请查看运行状态。"]);
    expect(h.sessions.get("failed")).toMatchObject({ status: "failed", reply: { state: "accepted" } });
    expect(h.ledger.turn(h.sessions.get("failed").taskId)).toMatchObject({ state: "failed" });
    await h.sessions.submit({ eventId: "canceled", sessionId: OWNER_CHAT, input: "Another.", admission: admission("delegation"), reply: {} });
    await h.round();
    await h.sessions.cancel("canceled");
    await h.round();
    expect(h.sessions.get("canceled")).toMatchObject({ status: "cancelled" });
    // As for a channel turn: the notice that the stop was requested, then the final entry.
    expect(h.chat.sent.map((item) => item.text)).toEqual(["本轮执行未完成，请查看运行状态。", "Cancellation requested; waiting for the worker to stop and acknowledge.", "已取消。"]);
    expect(h.ledger.turn(h.sessions.get("canceled").taskId)).toMatchObject({ state: "canceled" });
  });
  it("leaves work without a reply route as it was: recorded by the Host worker, delivered nowhere", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    await h.sessions.submit({ eventId: "silent", sessionId: OWNER_CHAT, input: "A schedule.", admission: admission("schedule") });
    await h.round(); h.host.finish(2, "Done quietly."); await h.round();
    expect(h.chat.sent).toEqual([]);
    expect(h.sessions.get("silent")).toEqual({ eventId: "silent", taskId: expect.any(String), sessionId: OWNER_CHAT, status: "completed", answer: "Done quietly.", runId: "run-2", outcomeUnknown: false });
    expect(finals(h).at(-1)!.body).toEqual({ text: "Done quietly.", final: true });
    expect(h.ledger.turn(h.sessions.get("silent").taskId)).toMatchObject({ replyRoute: null, originConversationId: null });
    expect(h.core.input(h.sessions.get("silent").taskId)).toBeUndefined();
  });
});

describe("notifications of a turn that answers the owner", () => {
  it("follow the notify policy as an owner's web turn does", async () => {
    const h = await setup({ notify: {} });
    await h.sessions.submit({ eventId: "one", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: {} });
    await h.round(); h.host.finish(1, "Noted."); await h.round();
    expect(h.push.pushed).toEqual([{ text: "Noted.", purpose: "reply" }]);
    // A chat open in a browser needs no push, and neither does an answer that reached the owner's own app.
    h.core.watching = () => true;
    await h.sessions.submit({ eventId: "two", sessionId: OWNER_CHAT, input: "Note this too.", admission: admission("delegation"), reply: {} });
    await h.round(); h.host.finish(2, "Noted again."); await h.round();
    h.core.watching = () => false;
    await ownerTurnOnChat(h, "m9");
    await h.sessions.submit({ eventId: "three", sessionId: OWNER_CHAT, input: "And this.", admission: admission("delegation"), reply: {} });
    await h.round(); h.host.finish(4, "On your chat."); await h.round();
    expect(h.chat.sent.map((item) => item.text)).toEqual(["On your chat."]);
    expect(h.push.pushed).toHaveLength(1);

    const slow = await setup({ notify: { replyAfterSeconds: 3600 } });
    await slow.sessions.submit({ eventId: "quick", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: {} });
    await slow.round(); slow.host.finish(1, "Noted."); await slow.round();
    expect(slow.push.pushed).toEqual([]);
  });
  it("go to a named notify connection whatever the policy and the owner's presence say", async () => {
    const h = await setup({ notify: { replies: false, questions: false } });
    h.core.watching = () => true;
    const submitted = await h.sessions.submit({ eventId: "pushed", sessionId: OWNER_CHAT, input: "Note this.", admission: admission("delegation"), reply: { connectionId: "push" } });
    expect(submitted.reply).toEqual({ connectionId: "push", state: "pending", externalId: null, error: null });
    await h.round();
    h.host.ask(1, { id: "q1", name: "item/commandExecution/requestApproval", input: { command: "make deploy" } });
    await h.round();
    expect(h.push.pushed).toEqual([{ text: expect.stringContaining("make deploy"), purpose: "question" }]);
    h.host.pending[0]!.status = "completed"; h.host.finish(1, "Noted.");
    await h.round();
    expect(h.push.pushed.at(-1)).toEqual({ text: "Noted.", purpose: "reply" });
    expect(finals(h).map((event) => event.body.text)).toEqual(["Noted."]);
    expect(h.sessions.get("pushed").reply).toEqual({ connectionId: "push", state: "accepted", externalId: "p2", error: null });
  });
});

describe("interactions of a turn that answers the owner", () => {
  const approval = { id: "a1", name: "item/commandExecution/requestApproval", input: { command: "make deploy" } };
  it("reach the owner as a card on the turn's route, answered there by text", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    const submitted = await h.sessions.submit({ eventId: "asks", sessionId: OWNER_CHAT, input: "Deploy what the partner built.", admission: admission("delegation"), reply: {} });
    await h.round();
    h.host.ask(2, approval);
    await h.round();
    expect(h.chat.sent).toHaveLength(1);
    expect(h.chat.sent[0]).toMatchObject({ route: { connectionId: "chat", target: OWNER_ON_CHAT }, text: expect.stringContaining("make deploy") });
    const [card] = h.ledger.openCards({ sessionKey: OWNER_CHAT });
    expect(card).toMatchObject({ kind: "approval", status: "pending", callId: "a1", turnId: submitted.taskId, source: "host" });
    h.chat.say("m2", "同意", OWNER_ON_CHAT);
    await h.round();
    expect(h.host.resolved).toEqual([{ runId: "run-2", callId: "a1", result: { decision: "accept" } }]);
    expect(h.ledger.cardRecord(card!.cardId)).toMatchObject({ status: "approved", surface: "channel", answeredBy: OWNER_PERSON });
    h.host.finish(2, "Deployed.");
    await h.round();
    expect(h.chat.sent.map((item) => item.text).at(-1)).toBe("Deployed.");
    // The answer was a control message, not a new turn.
    expect(h.host.starts).toHaveLength(2);
  });
  it("are answered from the web as well, first answer wins, and the external conversation is told", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    await h.sessions.submit({ eventId: "asks", sessionId: OWNER_CHAT, input: "Deploy what the partner built.", admission: admission("delegation"), reply: {} });
    await h.round();
    h.host.ask(2, approval);
    await h.round();
    const [card] = h.ledger.openCards({ sessionKey: OWNER_CHAT });
    expect((await h.control.answer(card!.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "1" })).status).toBe("accepted");
    expect(h.host.resolved).toEqual([{ runId: "run-2", callId: "a1", result: { decision: "decline" } }]);
    h.chat.say("m2", "同意", OWNER_ON_CHAT);
    await h.round();
    expect(h.host.resolved).toHaveLength(1);
    expect(h.ledger.cardRecord(card!.cardId)).toMatchObject({ status: "rejected", surface: "web" });
    expect(h.chat.sent.map((item) => item.text)).toContain("已在网页回答。");
  });
  it("are still not presented for work without a reply route", async () => {
    const h = await setup();
    await ownerTurnOnChat(h);
    await h.sessions.submit({ eventId: "silent", sessionId: OWNER_CHAT, input: "A schedule.", admission: admission("schedule") });
    await h.round();
    h.host.ask(2, approval);
    await h.round();
    expect(h.chat.sent).toEqual([]);
    expect(h.ledger.openCards({ sessionKey: OWNER_CHAT })).toEqual([]);
  });
});
