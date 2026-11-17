import { afterEach, describe, expect, it } from "vitest";
import { TEXT_DELIVERY_BOUNDARY, TEXT_DELIVERY_NOTICE } from "../src/execution/delivery.js";
import { admission, harness, WorkHost, type Harness } from "./fixtures/work-harness.js";
import { owner, setup as service, until } from "./ledger-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async (nativeItems?: "supported" | "unsupported"): Promise<Harness> => {
  const host = new WorkHost(); host.nativeItems = nativeItems;
  const h = await harness({ host }); cleanup.push(() => h.close()); return h;
};

describe("the sender of a submitted input", () => {
  it("names the agent that sent the input: in the ledger, in the tool output and in the text notice", async () => {
    const sender = { kind: "agent" as const, id: "partner-b", name: "Partner B" };
    const submission = { eventId: "from-partner", input: "Summarize the report.", admission: admission("delegation"), sender };
    const native = await setup("supported");
    const submitted = await native.sessions.submit(submission);
    expect(await native.sessions.submit(submission)).toEqual(submitted);
    await expect(native.sessions.submit({ ...submission, sender: { ...sender, name: "Someone else" } })).rejects.toThrow("work_event_id_reused");
    await native.round();
    expect(native.host.starts[0]!.toolOutput).toEqual({ namespace: "mau", name: "work_sessions", retain: false,
      output: "{\"source\":{\"kind\":\"delegation\",\"reference\":\"reference-1\",\"sender\":{\"kind\":\"agent\",\"id\":\"partner-b\",\"name\":\"Partner B\"}},\"message\":\"Summarize the report.\"}" });
    const [event] = native.ledger.events(submitted.sessionId).filter((item) => item.kind === "message");
    expect(event).toMatchObject({ role: "user", senderType: "agent", senderId: "partner-b", turnId: submitted.taskId,
      body: { text: "Summarize the report.", origin: "delegation", reference: "reference-1", sender } });
    const text = await setup("unsupported");
    await text.sessions.submit(submission);
    await text.round();
    expect(text.host.starts[0]!.input).toBe(`${TEXT_DELIVERY_NOTICE}\nSource: {"kind":"delegation","reference":"reference-1","sender":{"kind":"agent","id":"partner-b","name":"Partner B"}}\n${TEXT_DELIVERY_BOUNDARY}\n\nSummarize the report.`);
    // Without a sender the input stays a system event of its admission.
    const plain = await text.sessions.submit({ eventId: "plain", input: "Check.", admission: admission("schedule") });
    expect(text.ledger.events(plain.sessionId).find((item) => item.kind === "message")).toMatchObject({ senderType: "system", senderId: "schedule", body: { text: "Check.", origin: "schedule", reference: "reference-1" } });
    expect(text.ledger.events(plain.sessionId).find((item) => item.kind === "message")!.body).not.toHaveProperty("sender");
  });
  it("refuses a sender on the owner's own work, and a malformed one", async () => {
    const h = await setup("supported"), sender = { kind: "agent" as const, id: "partner-b", name: "Partner B" };
    await expect(h.sessions.submit({ eventId: "owner", input: "Do it.", admission: admission("owner"), sender })).rejects.toMatchObject({ message: "work_sender_admission_mismatch", status: 403 });
    for (const invalid of [{ ...sender, kind: "person" }, { ...sender, id: "" }, { ...sender, name: " " }, { ...sender, extra: true }])
      await expect(h.sessions.submit({ eventId: "bad", input: "Do it.", admission: admission("delegation"), sender: invalid as never })).rejects.toThrow();
    expect(h.work.list(true)).toEqual([]);
    expect(h.sessions.lookup("owner")).toBeNull();
  });
  it("is the event's sender in the web chat API, beside inputs without one", async () => {
    const t = await service(cleanup);
    const sessions = t.extension().sessions!;

    // An input another agent sent is rendered as that agent's message, not as a system message.
    const admitted = { kind: "delegation" as const, owner, agentId: t.agent.id, reference: "message-1", toolGrants: {} };
    const { sessionId } = sessions.openOwnerConversation();
    await sessions.submit({ eventId: "from-partner", sessionId, input: "The report is ready.", admission: admitted, sender: { kind: "agent", id: "partner-b", name: "Partner B" }, reply: {} });
    await sessions.submit({ eventId: "from-schedule", sessionId, input: "Check the inbox.", admission: { ...admitted, kind: "schedule", reference: "rule-1" } });
    const listed = await until(t.events, (items) => items.filter((event) => event.kind === "message" && event.role === "assistant").length === 2);
    expect(listed.find((event) => event.text === "The report is ready.")).toMatchObject({ kind: "message", role: "user", origin: "delegation",
      sender: { type: "agent", id: "partner-b", name: "Partner B" } });
    expect(listed.find((event) => event.text === "Check the inbox.")).toMatchObject({ kind: "message", role: "user", origin: "schedule", channel: { kind: "schedule" },
      sender: { type: "system", id: "schedule", name: "schedule" } });
    // The agent's own answers keep its own name, and the turn answered once.
    expect(listed.filter((event) => event.kind === "message" && event.role === "assistant").map((event) => event.sender)).toEqual([
      { type: "agent", id: t.agent.id, name: "helper" }, { type: "agent", id: t.agent.id, name: "helper" }]);
    expect(t.host.starts.map((start) => JSON.parse(String(start.toolOutput!.output)).source)).toEqual([
      { kind: "delegation", reference: "message-1", sender: { kind: "agent", id: "partner-b", name: "Partner B" } }, { kind: "schedule", reference: "rule-1" }]);
  }, 30_000);
});
