import { afterEach, describe, expect, it } from "vitest";
import { legacySession } from "../src/ledger/ledger.js";
import { admission, AGENT, harness, OWNER_ON_CHAT, type Harness, type HarnessOptions } from "./fixtures/work-harness.js";
import { owner, root, setup as service, until } from "./ledger-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async (options: HarnessOptions = {}): Promise<Harness> => { const h = await harness(options); cleanup.push(() => h.close()); return h; };
const OWNER_CHAT = legacySession(AGENT, "owner-main");
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
/** A text that appears in the display and nowhere else. */
const MARK = "as-the-sender-wrote-it";
const display = { format: "partner-message", text: MARK, parts: [{ from: "partner-b", lines: 2 }], quoted: null };
const sender = { kind: "agent" as const, id: "partner-b", name: "Partner B" };
const submission = { eventId: "from-partner", input: "Summarize the report.", admission: admission("delegation"), sender };
const question = (eventId: string, extra: Record<string, unknown> = {}) => ({ eventId, title: "Partner B asks", text: "Send the report?",
  choices: [{ id: "yes", label: "Send" }, { id: "no", label: "Hold" }], expiresAt: soon(), ...extra });
const messages = (h: Harness, sessionId: string) => h.ledger.events(sessionId).filter((event) => event.kind === "message");
const cards = (h: Harness) => h.ledger.events(OWNER_CHAT).filter((event) => event.kind === "card");
/** Everything the agent's store holds outside the ledger's own tables (work inputs, work queue, records). */
const documents = (h: Harness) => JSON.stringify(h.store.db.prepare("SELECT collection, value FROM documents").all());

describe("the display of a submitted input", () => {
  it("is kept on the input event and nowhere the model or the Host reads", async () => {
    const shown = await setup(), plain = await setup();
    const submitted = await shown.sessions.submit({ ...submission, display });
    await plain.sessions.submit(submission);
    await shown.round(); await plain.round();
    expect(messages(shown, submitted.sessionId)[0]!.body).toStrictEqual({ text: "Summarize the report.", origin: "delegation", reference: "reference-1", sender, display });
    // Without a display the event is the one it was before the member existed.
    expect(messages(plain, submitted.sessionId)[0]!.body).toStrictEqual({ text: "Summarize the report.", origin: "delegation", reference: "reference-1", sender });
    // The Host start request is the same with and without it, and the work input does not keep it.
    const request = ({ requestKey: _requestKey, ...start }: Harness["host"]["starts"][number]) => start;
    expect(shown.host.starts).toHaveLength(1);
    expect(request(shown.host.starts[0]!)).toStrictEqual(request(plain.host.starts[0]!));
    expect(JSON.stringify(shown.host.starts)).not.toContain(MARK);
    expect(shown.store.get("work_session_inputs", submitted.taskId)).toStrictEqual(plain.store.get("work_session_inputs", (await plain.sessions.get("from-partner")).taskId));
    expect(documents(shown)).not.toContain(MARK);
  });
  it("belongs to the submission: the same display is the same event, another one is refused", async () => {
    const h = await setup();
    const submitted = await h.sessions.submit({ ...submission, display });
    expect(await h.sessions.submit({ ...submission, display: structuredClone(display) })).toEqual(submitted);
    await expect(h.sessions.submit({ ...submission, display: { ...display, text: "something else" } })).rejects.toMatchObject({ message: "work_event_id_reused", status: 409 });
    await expect(h.sessions.submit(submission)).rejects.toMatchObject({ message: "work_event_id_reused", status: 409 });
    expect(messages(h, submitted.sessionId)).toHaveLength(1);
  });
  it("is a JSON object of at most 64,000 bytes", async () => {
    const h = await setup();
    const fits = { text: "x".repeat(64_000 - JSON.stringify({ text: "" }).length) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(64_000);
    await expect(h.sessions.submit({ ...submission, eventId: "large", display: { text: `${fits.text}x` } })).rejects.toMatchObject({ message: "work_display_too_large", status: 413 });
    // The limit counts bytes, not characters.
    await expect(h.sessions.submit({ ...submission, eventId: "wide", display: { text: "中".repeat(22_000) } })).rejects.toMatchObject({ message: "work_display_too_large", status: 413 });
    for (const invalid of ["text", ["text"], null, 7, { at: new Date(0) }, { value: undefined }])
      await expect(h.sessions.submit({ ...submission, eventId: "invalid", display: invalid as never })).rejects.toMatchObject({ name: "ZodError" });
    expect(h.work.list(true)).toEqual([]);
    expect(h.ledger.sessions()).toEqual([]);
    const largest = await h.sessions.submit({ ...submission, eventId: "fits", display: fits });
    expect(messages(h, largest.sessionId)[0]!.body.display).toEqual(fits);
    expect(messages(h, largest.sessionId)[0]!.body).not.toHaveProperty("truncated");
  });
  it("goes with the content of its event when that is removed", async () => {
    const h = await setup();
    const { sessionId } = h.sessions.openOwnerConversation();
    await h.sessions.submit({ ...submission, sessionId, display });
    h.sessions.request(question("ask", { display }));
    const [event] = messages(h, sessionId);
    expect(JSON.stringify(h.ledger.events(sessionId))).toContain(MARK);
    // A redacted event keeps its place and none of its content.
    h.ledger.redactBody(event!.eventId);
    expect(h.ledger.event(event!.eventId)!.body).toStrictEqual({ text: "", redacted: true, redactedAt: expect.any(String) });
    // Clearing the conversation deletes its events and its cards.
    await h.control.purge(sessionId, { cancelActive: true });
    expect(JSON.stringify(h.ledger.events(sessionId))).not.toContain(MARK);
    expect(h.ledger.pendingCards(sessionId)).toBe(0);
  });
});

describe("the display of an owner request", () => {
  it("is kept on the card, and the message an external channel gets is the one it got without it", async () => {
    const sent = async (extra: Record<string, unknown>, options: HarnessOptions = {}) => {
      const h = await setup(options);
      h.chat.say("m1", "hello", OWNER_ON_CHAT);
      await h.round(); h.host.finish(1, "hi"); await h.round();
      h.chat.sent = [];
      const request = h.sessions.request(question("ask", extra));
      await h.round();
      return { h, request };
    };
    const expiresAt = soon(), shown = await sent({ expiresAt, display }), plain = await sent({ expiresAt });
    expect(cards(shown.h)[0]!.body.card).toStrictEqual({ ...(cards(plain.h)[0]!.body.card as Record<string, unknown>), display });
    expect(cards(plain.h)[0]!.body.card).not.toHaveProperty("display");
    expect(shown.h.chat.sent).toEqual([{ route: { connectionId: "chat", target: OWNER_ON_CHAT, messageId: "m1", data: {} },
      text: "Partner B asks\n\nSend the report?\n1. Send\n2. Hold\n请回复选项名称或编号。", buttons: undefined }]);
    expect(shown.h.chat.sent).toEqual(plain.h.chat.sent);
    expect(JSON.stringify(shown.h.ledger.deliveriesFor(cards(shown.h)[0]!.eventId))).not.toContain(MARK);
    expect((await shown.h.control.view(shown.request.cardId)).display).toEqual(display);
    // Buttons carry the labels only.
    const buttons = await sent({ display }, { buttons: true });
    expect(buttons.h.chat.sent).toEqual([{ route: expect.anything(), text: "Partner B asks\n\nSend the report?\n可点击选项，或直接回复选项名称。",
      buttons: [{ label: "Send", token: expect.any(String) }, { label: "Hold", token: expect.any(String) }] }]);
    // A push gets the text of the card.
    const pushed = await setup({ notify: {} });
    pushed.sessions.request(question("ask", { display }));
    await pushed.round();
    expect(pushed.push.pushed).toHaveLength(1);
    expect(JSON.stringify(pushed.push.pushed)).not.toContain(MARK);
  });
  it("belongs to the request, and is a JSON object of at most 64,000 bytes", async () => {
    const h = await setup();
    const input = question("ask", { display }), first = h.sessions.request(input);
    expect(h.sessions.request({ ...input, display: structuredClone(display) })).toEqual(first);
    expect(() => h.sessions.request({ ...input, display: { ...display, text: "something else" } })).toThrow("owner_request_event_id_reused");
    expect(() => h.sessions.request(question("ask"))).toThrow("owner_request_event_id_reused");
    let refused: unknown;
    try { h.sessions.request(question("large", { display: { text: "x".repeat(64_000) } })); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ message: "owner_request_display_too_large", status: 413 });
    for (const invalid of ["text", ["text"], null, 7])
      expect(() => h.sessions.request(question("invalid", { display: invalid }))).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(h.sessions.lookupRequest("large")).toBeNull();
    expect(h.sessions.lookupRequest("invalid")).toBeNull();
    expect(cards(h)).toHaveLength(1);
  });
});

describe("display in the web chat API", () => {
  it("returns it on the message event and on the card, in history and on the socket", async () => {
    const t = await service(cleanup);
    const sessions = t.extension().sessions!;
    const { sessionId } = sessions.openOwnerConversation();
    const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
    const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`), frames: any[] = [];
    socket.addEventListener("message", (event) => frames.push(event.data === "pong" ? "pong" : JSON.parse(String(event.data))));
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    cleanup.push(() => socket.close());
    socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId: t.chatId }] } }));
    await until(() => frames, (items) => items.some((frame) => frame.id === "1"));
    const live = (predicate: (event: any) => boolean) => until(() => frames, (items) => items.some((frame) => frame.event === "chat.event" && predicate(frame.data)))
      .then((items) => items.find((frame) => frame.event === "chat.event" && predicate(frame.data)).data);

    const admitted = { kind: "delegation" as const, owner, agentId: t.agent.id, reference: "message-1", toolGrants: {} };
    await sessions.submit({ eventId: "from-partner", sessionId, input: "The report is ready.", admission: admitted, sender, reply: {}, display });
    await sessions.submit({ eventId: "from-schedule", sessionId, input: "Check the inbox.", admission: { ...admitted, kind: "schedule", reference: "rule-1" } });
    const request = sessions.request(question("ask", { display }));

    const shown = { kind: "message", role: "user", text: "The report is ready.", origin: "delegation", sender: { type: "agent", id: "partner-b", name: "Partner B" }, display };
    expect(await live((event) => event.kind === "message" && event.text === "The report is ready.")).toMatchObject(shown);
    expect(await live((event) => event.kind === "message" && event.text === "Check the inbox.")).not.toHaveProperty("display");
    expect((await live((event) => event.kind === "card" && event.card.cardId === request.cardId)).card).toMatchObject({ source: "product", status: "pending", text: "Partner B asks\n\nSend the report?", display });

    const listed = await until(t.events, (items) => items.filter((event) => event.kind === "message" && event.role === "assistant").length === 2);
    expect(listed.find((event) => event.text === "The report is ready.")).toMatchObject(shown);
    expect(listed.find((event) => event.text === "Check the inbox.")).not.toHaveProperty("display");
    expect(listed.find((event) => event.kind === "card").card).toMatchObject({ cardId: request.cardId, source: "product", display });
    expect((await t.api(`${t.chat}/cards/${encodeURIComponent(request.cardId)}`)).data).toMatchObject({ cardId: request.cardId, status: "pending", display });
    // Neither turn's Host request carries it.
    expect(t.host.starts).toHaveLength(2);
    expect(JSON.stringify(t.host.starts)).not.toContain(MARK);
  }, 30_000);
});
