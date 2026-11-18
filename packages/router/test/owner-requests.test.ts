import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySession } from "../src/ledger/ledger.js";
import { expireRequests } from "../src/ledger/requests.js";
import { personId } from "../src/ledger/registry.js";
import { AGENT, harness, OWNER_ON_CHAT, OWNER_PERSON, WorkHost, type Harness, type HarnessOptions } from "./fixtures/work-harness.js";
import { ik, owner, setup as service, until } from "./ledger-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async (options: HarnessOptions = {}) => { const h = await harness(options); cleanup.push(() => h.close()); return h; };
const OWNER_CHAT = legacySession(AGENT, "owner-main");
const soon = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const approval = (eventId = "approve-1", extra: Record<string, unknown> = {}) => ({ eventId, kind: "approval" as const, title: "Partner needs your approval",
  text: "Send the report to the customer?", choices: [{ id: "allow", label: "允许一次" }, { id: "deny", label: "拒绝", style: "danger" as const }], expiresAt: soon(), ...extra });
/** The same card as a `question`: its choices can also be answered by a typed label or number. */
const question = (eventId = "approve-1", extra: Record<string, unknown> = {}) => approval(eventId, { kind: "question", ...extra });
async function ownerOnChat(h: Harness) {
  h.chat.say("m1", "hello", OWNER_ON_CHAT);
  await h.round(); h.host.finish(h.host.starts.length, "hi"); await h.round();
  h.chat.sent = [];
}
const cards = (h: Harness) => h.ledger.events(OWNER_CHAT).filter((event) => event.kind === "card");
const updates = (h: Harness) => h.ledger.events(OWNER_CHAT).filter((event) => event.kind === "card.update").map((event) => event.body);

describe("owner requests", () => {
  it("put one card in the owner conversation, by event id, and keep it across a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "owner-request-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "agent.sqlite"), host = new WorkHost();
    let h = await harness({ path, host });
    const input = approval();
    const first = h.sessions.request(input);
    expect(first).toEqual({ eventId: "approve-1", cardId: expect.stringMatching(/^cd_[0-9a-f]{40}$/), sessionId: OWNER_CHAT, expiresAt: input.expiresAt, status: "pending",
      delivery: { connectionId: "web", state: "web", externalId: null, error: null } });
    expect(h.sessions.request(input)).toEqual(first);
    expect(() => h.sessions.request({ ...input, text: "Something else?" })).toThrow("owner_request_event_id_reused");
    expect(cards(h)).toHaveLength(1);
    // The same card every surface already renders: text, numbered choices, no free text, a deadline, and no run.
    expect(cards(h)[0]).toMatchObject({ role: "assistant", senderType: "agent", senderId: AGENT, turnId: null, body: { card: { cardId: first.cardId, kind: "approval", source: "product",
      text: "Partner needs your approval\n\nSend the report to the customer?", choices: [{ choiceId: "0", label: "允许一次" }, { choiceId: "1", label: "拒绝", style: "danger" }],
      freeText: false, deadlineAt: input.expiresAt, callId: "product-request:approve-1", turnId: "", claimId: "" } } });
    expect(h.ledger.cardRecord(first.cardId)).toMatchObject({ status: "pending", source: "product", kind: "approval", deadlineAt: Date.parse(input.expiresAt) });
    // No run and no turn belongs to it: the conversation stays free for the agent's own work.
    expect(h.host.starts).toEqual([]);
    expect(h.ledger.busy(OWNER_CHAT)).toEqual({ activeTurns: [], queuedInputs: [] });
    await h.close();
    h = await setup({ path, host });
    expect(h.sessions.lookupRequest("approve-1")).toEqual(first);
    expect(h.sessions.request(input)).toEqual(first);
    expect((await h.control.answer(first.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "0" })).status).toBe("accepted");
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "allow", answeredBy: OWNER_PERSON, surface: "web", settledAt: expect.any(String) });
    expect(h.sessions.lookupRequest("unknown")).toBeNull();
  });
  it("validate their input", async () => {
    const h = await setup();
    expect(() => h.sessions.request(approval("late", { expiresAt: new Date(Date.now() - 1000).toISOString() }))).toThrow("owner_request_expired");
    expect(() => h.sessions.request(approval("three", { choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] }))).toThrow("owner_request_approval_needs_two_choices");
    expect(() => h.sessions.request(approval("same", { kind: "question", choices: [{ id: "a", label: "A" }, { id: "b", label: "A" }] }))).toThrow("owner_request_choices_not_distinct");
    expect(() => h.sessions.request(approval("none", { choices: [] }))).toThrow();
    expect(() => h.sessions.request(approval("gone", { connectionId: "gone" }))).toThrow("delivery_connection_not_found");
    expect(() => h.sessions.withdrawRequest("gone")).toThrow("owner_request_not_found");
    expect(h.ledger.sessions()).toEqual([]);
  });
  it("follow the owner to an external conversation, where a reply with the label answers", async () => {
    const h = await setup();
    await ownerOnChat(h);
    const request = h.sessions.request(question());
    await h.round();
    expect(h.chat.sent).toEqual([{ route: { connectionId: "chat", target: OWNER_ON_CHAT, messageId: "m1", data: {} },
      text: "Partner needs your approval\n\nSend the report to the customer?\n1. 允许一次\n2. 拒绝\n请回复选项名称或编号。", buttons: undefined }]);
    expect(h.sessions.lookupRequest("approve-1")!.delivery).toEqual({ connectionId: "chat", state: "accepted", externalId: "chat-m1", error: null });
    // The card event and its channel message are one thing: the web shows the card once, with its delivery.
    expect(cards(h)).toHaveLength(1);
    expect(h.ledger.deliveriesFor(cards(h)[0]!.eventId).map((row) => [row.purpose, row.status])).toEqual([["card", "sent"]]);
    h.chat.say("m2", "拒绝", OWNER_ON_CHAT);
    await h.round();
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "deny", answeredBy: OWNER_PERSON, surface: "channel" });
    expect(h.ledger.cardRecord(request.cardId)).toMatchObject({ status: "answered" });
    expect(updates(h)).toEqual([{ cardId: request.cardId, status: "answered", answeredBy: OWNER_PERSON, summary: "拒绝" }]);
    expect(h.chat.sent.at(-1)!.text).toBe("已收到回答：拒绝。");
    // The answer was consumed as an answer: it started no turn.
    expect(h.host.starts).toHaveLength(1);
  });
  it("send buttons where the channel has them, and a button pressed after the answer is refused", async () => {
    const h = await setup({ buttons: true });
    await ownerOnChat(h);
    const request = h.sessions.request(approval());
    await h.round();
    expect(h.chat.sent[0]).toMatchObject({ text: "Partner needs your approval\n\nSend the report to the customer?\n请点击按钮选择；文字回复不会被当作批准。",
      buttons: [{ label: "允许一次", token: expect.stringMatching(/^[0-9a-f]{32}$/) }, { label: "拒绝", token: expect.any(String) }] });
    const [allow, deny] = h.chat.sent[0]!.buttons!;
    h.chat.say("press-1", "", OWNER_ON_CHAT, { action: { token: allow!.token } });
    await h.round();
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "allow", surface: "channel" });
    expect(h.ledger.cardRecord(request.cardId)!.status).toBe("approved");
    h.chat.say("press-2", "", OWNER_ON_CHAT, { action: { token: deny!.token } });
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("这个请求已经回答过了。");
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "allow" });
    expect(h.host.starts).toHaveLength(1);
  });
  it("take the first answer from any surface and tell the other one", async () => {
    const h = await setup();
    await ownerOnChat(h);
    const request = h.sessions.request(approval());
    await h.round();
    expect((await h.control.answer(request.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "0" })).status).toBe("accepted");
    // The same web request again is the same answer; another one is stale.
    expect((await h.control.answer(request.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "0" })).status).toBe("accepted");
    expect(await h.control.answer(request.cardId, { key: "web:2", by: OWNER_PERSON, surface: "web", choiceId: "1" })).toMatchObject({ status: "stale", card: { status: "approved" } });
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("已在网页回答。");
    h.chat.say("m2", "拒绝", OWNER_ON_CHAT);
    await h.round();
    // A late label is an ordinary message once no request waits for it.
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "allow", surface: "web" });
    expect(h.host.starts).toHaveLength(2);
    expect(updates(h)).toHaveLength(1);
  });
  it("answer by text on the web and refuse anything that is not a choice", async () => {
    const h = await setup();
    const request = h.sessions.request(approval("q1", { kind: "question", choices: [{ id: "today", label: "今天" }, { id: "tomorrow", label: "明天" }, { id: "never", label: "不用了" }] }));
    await expect(h.control.answer(request.cardId, { key: "k1", by: OWNER_PERSON, surface: "web", text: "后天" })).rejects.toMatchObject({ message: "invalid_answer", status: 422 });
    await expect(h.control.answer(request.cardId, { key: "k2", by: OWNER_PERSON, surface: "web", choiceId: "7" })).rejects.toMatchObject({ message: "choice_not_found", status: 422 });
    await expect(h.control.answer(request.cardId, { key: "k3", by: OWNER_PERSON, surface: "web", result: { choice: "today" }, hasResult: true })).rejects.toMatchObject({ message: "choice_or_text_required" });
    expect(h.sessions.lookupRequest("q1")!.status).toBe("pending");
    expect((await h.control.answer(request.cardId, { key: "k4", by: OWNER_PERSON, surface: "web", text: "明天" })).card.status).toBe("answered");
    expect(h.sessions.lookupRequest("q1")).toMatchObject({ status: "answered", choice: "tomorrow" });
  });
  it("accept a number only while the request is the only card waiting, and ask when two requests share a label", async () => {
    const h = await setup();
    await ownerOnChat(h);
    h.sessions.request(question("one"));
    await h.round();
    h.chat.say("n1", "2", OWNER_ON_CHAT);
    await h.round();
    expect(h.sessions.lookupRequest("one")).toMatchObject({ status: "answered", choice: "deny" });
    h.sessions.request(question("two")); h.sessions.request(question("three"));
    await h.round();
    h.chat.say("n2", "1", OWNER_ON_CHAT);
    await h.round(); h.host.finish(h.host.starts.length, "ok"); await h.round();
    // Two cards wait: "1" is an ordinary message, and a shared label has to be chosen by button.
    expect(h.host.starts).toHaveLength(2);
    h.chat.say("n3", "允许一次", OWNER_ON_CHAT);
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("有多个问题等待回答，请点击对应问题的选项，或引用对应的消息回复。");
    expect([h.sessions.lookupRequest("two")!.status, h.sessions.lookupRequest("three")!.status]).toEqual(["pending", "pending"]);
    expect(h.host.starts).toHaveLength(2);
    // Quoting the card's message says which request is meant, by label or by number.
    const message = (eventId: string) => h.sessions.lookupRequest(eventId)!.delivery.externalId!;
    h.chat.say("n4", "允许一次", OWNER_ON_CHAT, { quoted: { messageId: message("three") } });
    h.chat.say("n5", "2", OWNER_ON_CHAT, { quoted: { messageId: message("two") } });
    await h.round();
    expect(h.sessions.lookupRequest("three")).toMatchObject({ status: "answered", choice: "allow" });
    expect(h.sessions.lookupRequest("two")).toMatchObject({ status: "answered", choice: "deny" });
    expect(h.host.starts).toHaveLength(2);
  });
  it("leave a reply to a question of a run to that run, and ask when a label could mean either", async () => {
    const h = await setup();
    h.chat.say("m1", "deploy", OWNER_ON_CHAT);
    await h.round();
    h.host.ask(1, { id: "a1", name: "item/tool/requestUserInput", input: { questions: [{ id: "go", question: "Deploy?", options: [{ label: "允许一次" }, { label: "拒绝" }] }] } });
    await h.round();
    const asked = h.chat.sent.at(-1)!;
    h.sessions.request(question("beside", { choices: [{ id: "allow", label: "允许一次" }, { id: "deny", label: "拒绝" }] }));
    await h.round();
    // "拒绝" is a choice of the request and an answer to the run's question.
    h.chat.say("m2", "拒绝", OWNER_ON_CHAT);
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("有多个问题等待回答，请点击对应问题的选项，或引用对应的消息回复。");
    expect(h.host.resolved).toEqual([]);
    expect(h.sessions.lookupRequest("beside")!.status).toBe("pending");
    // Quoting the run's question answers the run; the request still waits.
    const questionId = h.ledger.recentDeliveries().find((row) => row.purpose === "card" && row.text === asked.text)!.platformMessageId!;
    h.chat.say("m3", "拒绝", OWNER_ON_CHAT, { quoted: { messageId: questionId } });
    await h.round();
    expect(h.host.resolved).toEqual([{ runId: "run-1", callId: "a1", result: { answers: { go: { answers: ["拒绝"] } } } }]);
    expect(h.sessions.lookupRequest("beside")!.status).toBe("pending");
    // Now the request is the only card waiting.
    h.chat.say("m4", "允许一次", OWNER_ON_CHAT);
    await h.round();
    expect(h.sessions.lookupRequest("beside")).toMatchObject({ status: "answered", choice: "allow" });
    expect(h.host.starts).toHaveLength(1);
  });
  it("take a number only where the card was sent as a numbered list", async () => {
    // With buttons no numbers were shown.
    const buttons = await setup({ buttons: true });
    await ownerOnChat(buttons);
    buttons.sessions.request(question("with-buttons"));
    await buttons.round();
    buttons.chat.say("n1", "1", OWNER_ON_CHAT);
    await buttons.round();
    expect(buttons.sessions.lookupRequest("with-buttons")!.status).toBe("pending");
    expect(buttons.host.starts).toHaveLength(2);
    // A card that is only on the transcript was never listed in this conversation; its label still answers it.
    const elsewhere = await setup();
    await ownerOnChat(elsewhere);
    elsewhere.sessions.request(question("web-only", { connectionId: "web" }));
    elsewhere.chat.say("n1", "1", OWNER_ON_CHAT);
    await elsewhere.round(); elsewhere.host.finish(2, "ok"); await elsewhere.round();
    expect(elsewhere.sessions.lookupRequest("web-only")!.status).toBe("pending");
    expect(elsewhere.host.starts).toHaveLength(2);
    elsewhere.chat.say("n2", "允许一次", OWNER_ON_CHAT);
    await elsewhere.round();
    expect(elsewhere.sessions.lookupRequest("web-only")).toMatchObject({ status: "answered", choice: "allow", surface: "channel" });
    expect(elsewhere.chat.sent.at(-1)!.text).toBe("已收到回答：允许一次。");
  });
  it("never take a stop command for an answer, even when a choice has that label", async () => {
    const h = await setup();
    h.chat.say("m1", "a long task", OWNER_ON_CHAT);
    await h.round();
    h.sessions.request(approval("stop-label", { kind: "question", choices: [{ id: "go", label: "继续" }, { id: "stop", label: "取消" }] }));
    await h.round();
    h.chat.say("m2", "取消", OWNER_ON_CHAT);
    await h.round();
    // The running turn is stopped; the request still waits and is answered by its button or by quoting it.
    expect(h.sessions.lookupRequest("stop-label")!.status).toBe("pending");
    expect(h.host.runs.get("run-1")!.status).toBe("cancelled");
    expect(h.chat.sent.map((item) => item.text)).toContain("正在停止当前任务。");
  });
  it("read a message that answered a request only once, also when dispatch is repeated after a restart", async () => {
    const h = await setup();
    await ownerOnChat(h);
    const request = h.sessions.request(question());
    await h.round();
    h.chat.say("m2", "允许一次", OWNER_ON_CHAT);
    await h.round();
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "allow" });
    // The process stopped after the answer was committed and before the message was marked as consumed.
    const inputId = h.ledger.cardRecord(request.cardId)!.answerKey!.slice("channel:".length);
    h.ledger.updateInput(inputId, "starting");
    const sent = h.chat.sent.length;
    await h.round();
    expect(h.ledger.input(inputId)).toMatchObject({ state: "control" });
    expect(h.host.starts).toHaveLength(1);
    expect(h.chat.sent).toHaveLength(sent);
  });
  it("count an answer typed in the web chat as a web answer and tell the conversation the card was sent to", async () => {
    const h = await setup();
    await ownerOnChat(h);
    h.sessions.request(question("typed", { connectionId: "chat" }));
    await h.round();
    h.web.say("w1", "拒绝", OWNER_PERSON);
    await h.round();
    expect(h.sessions.lookupRequest("typed")).toMatchObject({ status: "answered", choice: "deny", surface: "web" });
    expect(h.chat.sent.at(-1)!.text).toBe("已在网页回答。");
    expect(h.host.starts).toHaveLength(1);
  });
  it("decide an approval by its button or in the web console only: a typed label, number or quoted reply is an ordinary message", async () => {
    const h = await setup();
    await ownerOnChat(h);
    const request = h.sessions.request(approval());
    await h.round();
    // Without buttons the channel shows the request and where to decide it; no numbered choices invite a reply.
    expect(h.chat.sent[0]!.text).toBe("Partner needs your approval\n\nSend the report to the customer?\n这个渠道不能批准，请到网页控制台操作。");
    const message = h.sessions.lookupRequest("approve-1")!.delivery.externalId!;
    for (const [id, text, extra] of [["t1", "允许一次", {}], ["t2", "1", {}], ["t3", "允许一次", { quoted: { messageId: message } }]] as const) {
      const starts = h.host.starts.length;
      h.chat.say(id, text, OWNER_ON_CHAT, extra);
      await h.round(); h.host.finish(h.host.starts.length, "ok"); await h.round();
      expect(h.sessions.lookupRequest("approve-1")!.status).toBe("pending");
      // The agent got it as a message of the conversation.
      expect(h.host.starts).toHaveLength(starts + 1);
    }
    h.web.say("w1", "允许一次", OWNER_PERSON);
    await h.round(); h.host.finish(h.host.starts.length, "ok"); await h.round();
    expect(h.sessions.lookupRequest("approve-1")!.status).toBe("pending");
    await expect(h.control.answer(request.cardId, { key: "k1", by: OWNER_PERSON, surface: "web", text: "允许一次" })).rejects.toMatchObject({ message: "invalid_answer", status: 422 });
    expect((await h.control.answer(request.cardId, { key: "k2", by: OWNER_PERSON, surface: "web", choiceId: "0" })).card.status).toBe("approved");
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "answered", choice: "allow", surface: "web" });
  });
  it("only take an answer from the owner", async () => {
    const h = await setup({ buttons: true });
    await ownerOnChat(h);
    h.sessions.request(approval());
    await h.round();
    const token = h.chat.sent[0]!.buttons![0]!.token;
    h.chat.say("s1", "", "someone-else", { action: { token } });
    h.chat.say("s2", "允许一次", "someone-else");
    await h.round();
    expect(h.sessions.lookupRequest("approve-1")!.status).toBe("pending");
  });
  it("expire at their deadline: the result is expired, the card closes, and a late answer is refused on every surface", async () => {
    const h = await setup({ buttons: true });
    await ownerOnChat(h);
    const request = h.sessions.request(approval("short", { expiresAt: soon(200) }));
    await h.round();
    const token = h.chat.sent[0]!.buttons![0]!.token;
    await new Promise((resolve) => setTimeout(resolve, 260));
    // Read before any loop ran: a request past its deadline never reads as pending.
    expect(h.sessions.lookupRequest("short")).toMatchObject({ status: "expired", settledAt: expect.any(String) });
    expect(h.sessions.lookupRequest("short")).not.toHaveProperty("choice");
    expect(updates(h)).toEqual([{ cardId: request.cardId, status: "expired" }]);
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("这个请求已过期。");
    expect(await h.control.answer(request.cardId, { key: "web:late", by: OWNER_PERSON, surface: "web", choiceId: "0" })).toMatchObject({ status: "stale", card: { status: "expired" } });
    h.chat.say("press", "", OWNER_ON_CHAT, { action: { token } });
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("这个请求已过期。");
    expect(h.sessions.lookupRequest("short")!.status).toBe("expired");
    expect(h.host.starts).toHaveLength(1);
  });
  it("are expired by the channel loop and by an answer that comes too late, without anyone reading them", async () => {
    const h = await setup();
    const loop = h.sessions.request(approval("loop", { expiresAt: soon(200) })), late = h.sessions.request(approval("late", { expiresAt: soon(200) }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(await h.control.answer(late.cardId, { key: "web:late", by: OWNER_PERSON, surface: "web", choiceId: "0" })).toMatchObject({ status: "stale", card: { status: "expired" } });
    expireRequests(h.ledger, h.core);
    expect(h.ledger.cardRecord(loop.cardId)!.status).toBe("expired");
    // A deadline that has not passed is left alone.
    const open = h.sessions.request(approval("open"));
    expireRequests(h.ledger, h.core);
    expect(h.ledger.cardRecord(open.cardId)!.status).toBe("pending");
  });
  it("can be withdrawn: the card closes as canceled, external conversations are told, and answers are refused", async () => {
    const h = await setup({ buttons: true });
    await ownerOnChat(h);
    const request = h.sessions.request(approval());
    await h.round();
    const token = h.chat.sent[0]!.buttons![0]!.token;
    expect(h.sessions.withdrawRequest("approve-1")).toMatchObject({ status: "withdrawn", settledAt: expect.any(String) });
    expect(h.sessions.withdrawRequest("approve-1").status).toBe("withdrawn");
    expect(updates(h)).toEqual([{ cardId: request.cardId, status: "canceled" }]);
    await h.round();
    expect(h.chat.sent.map((item) => item.text).filter((text) => text === "这个请求已撤回。")).toHaveLength(1);
    expect(await h.control.answer(request.cardId, { key: "web:late", by: OWNER_PERSON, surface: "web", choiceId: "0" })).toMatchObject({ status: "stale", card: { status: "canceled" } });
    h.chat.say("press", "", OWNER_ON_CHAT, { action: { token } });
    await h.round();
    expect(h.chat.sent.at(-1)!.text).toBe("这个请求已撤回。");
    // Withdrawing an answered request changes nothing.
    const answered = h.sessions.request(approval("answered"));
    await h.control.answer(answered.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "0" });
    expect(h.sessions.withdrawRequest("answered")).toMatchObject({ status: "answered", choice: "allow" });
  });
  it("apply the connection rule: transcript only, a named connection without a conversation, and a push", async () => {
    const h = await setup({ notify: { questions: false } });
    await ownerOnChat(h);
    expect(h.sessions.request(approval("web-only", { connectionId: "web" })).delivery).toEqual({ connectionId: "web", state: "web", externalId: null, error: null });
    expect(h.sessions.request(approval("pushed", { connectionId: "push" })).delivery).toMatchObject({ connectionId: "push", state: "queued" });
    await h.round();
    expect(h.chat.sent).toEqual([]);
    expect(h.push.pushed).toEqual([{ text: expect.stringContaining("Send the report to the customer?"), purpose: "question" }]);
    expect(h.sessions.lookupRequest("pushed")!.delivery).toMatchObject({ connectionId: "push", state: "accepted" });

    const web = await setup();
    web.web.say("w1", "hello", OWNER_PERSON);
    await web.round(); web.host.finish(1, "hi"); await web.round();
    expect(web.sessions.request(approval("elsewhere", { connectionId: "chat" })).delivery).toEqual({ connectionId: "chat", state: "suppressed", externalId: null, error: "no_conversation_on_connection" });
    expect(cards(web)).toHaveLength(1);
    expect(web.chat.sent).toEqual([]);
  });
  it("are pushed like a question of a turn when they reach the owner only through the transcript", async () => {
    const h = await setup({ notify: {} });
    h.sessions.request(approval("first"));
    await h.round();
    expect(h.push.pushed).toEqual([{ text: expect.stringContaining("Partner needs your approval"), purpose: "question" }]);
    h.core.watching = () => true;
    h.sessions.request(approval("second"));
    await h.round();
    expect(h.push.pushed).toHaveLength(1);
  });
  it("end as expired when the owner clears the conversation", async () => {
    const h = await setup();
    h.sessions.request(approval());
    await h.control.purge(OWNER_CHAT);
    expect(h.sessions.lookupRequest("approve-1")).toMatchObject({ status: "expired", settledAt: expect.any(String) });
    expect(h.ledger.pendingCards(OWNER_CHAT)).toBe(0);
  });
});

describe("owner requests through the web API", () => {
  it("serves the card like a card of a run, answers it once and counts it as waiting for the owner", async () => {
    const t = await service(cleanup);
    const sessions = t.extension().sessions!;
    const request = sessions.request({ eventId: "approve-web", kind: "approval", text: "Send the report to the customer?",
      choices: [{ id: "allow", label: "允许一次" }, { id: "deny", label: "拒绝" }], expiresAt: soon() });
    const card = await t.card((item) => item.cardId === request.cardId);
    expect(card).toMatchObject({ kind: "approval", source: "product", status: "pending", freeText: false, text: "Send the report to the customer?",
      choices: [{ choiceId: "0", label: "允许一次" }, { choiceId: "1", label: "拒绝" }] });
    const live = await t.api(`${t.chat}/cards/${encodeURIComponent(request.cardId)}`);
    expect(live.data).toMatchObject({ cardId: request.cardId, status: "pending", source: "product" });
    // The chat index counts it as a card waiting for the owner.
    expect((await until(() => t.api(`${t.chat}`), (response) => response.data.pendingCards === 1)).data.pendingCards).toBe(1);
    expect(await t.answer(request.cardId, { idempotencyKey: ik(), result: { choice: "allow" } })).toEqual({ status: 422, data: { error: "choice_or_text_required" } });
    const key = ik();
    expect((await t.answer(request.cardId, { idempotencyKey: key, choiceId: "0" })).data).toMatchObject({ status: "accepted", card: { status: "approved" } });
    expect((await t.answer(request.cardId, { idempotencyKey: key, choiceId: "0" })).data).toMatchObject({ status: "duplicate", card: { status: "approved" } });
    expect((await t.answer(request.cardId, { idempotencyKey: ik(), choiceId: "1" })).data).toMatchObject({ status: "stale", card: { status: "approved" } });
    expect(await t.answer(request.cardId, { idempotencyKey: ik(), choiceId: "0" }, "bob")).toEqual({ status: 404, data: { error: "chat_not_found" } });
    expect(sessions.lookupRequest("approve-web")).toMatchObject({ status: "answered", choice: "allow", answeredBy: personId(owner), surface: "web" });
    const events = await t.events();
    expect(events.find((event) => event.kind === "card.update")).toMatchObject({ cardId: request.cardId, status: "approved", summary: "允许一次", answeredBy: { type: "person", id: personId(owner) } });
    expect((await t.api(`${t.chat}`)).data.pendingCards).toBe(0);

  }, 30_000);
});
