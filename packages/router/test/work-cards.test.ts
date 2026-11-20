import { afterEach, describe, expect, it } from "vitest";
import { enc, ik, owner, root, setup, until } from "./ledger-fixture.js";
import { personId } from "../src/ledger/registry.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("an approval asked by a turn that no channel message started", () => {
  it("is a card in the agent's chat with the owner: listed, counted, answered by the owner only, and the run continues", async () => {
    const t = await setup(cleanup), sessions = t.extension().sessions!, work = `${root}/agents/${t.agent.id}/communication/work-events`;
    t.host.plan = () => [{ id: "a1", kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "make deploy" } }];
    const sender = { kind: "agent" as const, id: "partner-b", name: "Partner B" }, origin = { kind: "delegation", reference: "message-7", sender };
    const submitted = await sessions.submit({ eventId: "from-partner", sessionId: sessions.openOwnerConversation().sessionId, input: "Deploy what I built.", sender,
      admission: { kind: "delegation", owner, agentId: t.agent.id, reference: "message-7", toolGrants: {} } });
    const card = await t.card((item) => item.callId === "a1");
    const text = "［这一轮由 Agent「Partner B」的消息发起，不是你发起的］\nmake deploy\nmake deploy";
    expect(card).toMatchObject({ kind: "approval", source: "host", status: "pending", turnId: submitted.taskId, text, origin,
      choices: [{ choiceId: "0", label: "同意" }, { choiceId: "1", label: "拒绝" }] });
    expect((await t.api(`${t.chat}/cards/${enc(card.cardId)}`)).data).toMatchObject({ cardId: card.cardId, status: "pending", origin });
    // The chat index shows a turn that waits for the owner.
    expect((await until(() => t.api(t.chat), (response) => response.data.pendingCards === 1)).data).toMatchObject({ activeTurns: 1, pendingCards: 1 });
    // The product reads the same from the work event, over HTTP or in process.
    const waiting = (await t.api(`${work}/from-partner`)).data;
    expect(waiting).toMatchObject({ status: "working", pendingCards: [{ cardId: card.cardId, chatId: t.chatId, kind: "approval", text, origin }] });
    expect((await sessions.wait(["from-partner"], { timeoutMs: 0 })).data[0]!.pendingCards).toHaveLength(1);
    // Another owner does not reach the chat; text is not a decision.
    expect(await t.answer(card.cardId, { idempotencyKey: ik(), choiceId: "0" }, "bob")).toEqual({ status: 404, data: { error: "chat_not_found" } });
    expect((await t.answer(card.cardId, { idempotencyKey: ik(), text: "同意" })).status).toBe(422);
    expect(t.host.resolved).toEqual([]);
    expect((await t.answer(card.cardId, { idempotencyKey: ik(), choiceId: "0" })).data).toMatchObject({ status: "accepted", card: { status: "approved" } });
    expect(t.host.resolved).toEqual([{ runId: "run-1", callId: "a1", result: { decision: "accept" } }]);
    expect((await t.answer(card.cardId, { idempotencyKey: ik(), choiceId: "1" })).data).toMatchObject({ status: "stale", card: { status: "approved" } });
    const done = await until(() => sessions.get("from-partner"), (result) => result.status === "completed");
    expect(done).toMatchObject({ answer: "回答-1" });
    expect(done).not.toHaveProperty("pendingCards");
    expect((await until(() => t.api(t.chat), (response) => response.data.activeTurns === 0)).data.pendingCards).toBe(0);
    expect((await t.events()).find((event) => event.kind === "card.update")).toMatchObject({ cardId: card.cardId, status: "approved", answeredBy: { type: "person", id: personId(owner) } });
  }, 30_000);
});
