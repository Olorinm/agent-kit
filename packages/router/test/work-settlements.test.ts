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
const approval = (eventId: string) => ({ eventId, kind: "approval" as const, text: "Send the report to the customer?",
  choices: [{ id: "allow", label: "允许一次" }, { id: "deny", label: "拒绝" }], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
async function ownerOnChat(h: Harness) {
  h.chat.say("m1", "hello", OWNER_ON_CHAT);
  await h.round(); h.host.finish(h.host.starts.length, "hi"); await h.round();
  h.chat.sent = [];
}

describe("settlements", () => {
  it("list what ended, in order, once, for work events of every outcome and for owner requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "settlements-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "agent.sqlite"), host = new WorkHost();
    let h = await harness({ path, host });
    expect(h.sessions.settlements()).toEqual({ data: [], cursor: 0 });
    await h.sessions.submit({ eventId: "done", input: "one", admission: admission("delegation") });
    await h.sessions.submit({ eventId: "fails", input: "two", admission: admission("schedule") });
    await h.sessions.submit({ eventId: "stopped", input: "three", admission: admission("owner") });
    await h.sessions.submit({ eventId: "runs", input: "four", admission: admission("delegation") });
    const asked = h.sessions.request(approval("ask"));
    await h.round();
    // Nothing ended yet.
    expect(h.sessions.settlements()).toEqual({ data: [], cursor: 0 });
    // Sessions start in no particular order: each run is found through its event.
    const run = (eventId: string) => h.sessions.get(eventId).runId!;
    host.finish(run("done"), "first answer");
    await h.round();
    const first = h.sessions.settlements();
    expect(first.data).toEqual([{ seq: 1, settledAt: expect.any(String), kind: "work", event: expect.objectContaining({ eventId: "done", status: "completed", answer: "first answer" }) }]);
    expect(first.cursor).toBe(1);
    host.finish(run("fails"), "", "failed");
    await h.round();
    await h.sessions.cancel("stopped");
    await h.round();
    await h.control.answer(asked.cardId, { key: "web:1", by: OWNER_PERSON, surface: "web", choiceId: "1" });
    // The reader stops and starts again with the cursor it kept; so does the agent.
    await h.close();
    h = await setup({ path, host });
    const second = h.sessions.settlements({ after: first.cursor });
    expect(second.data.map((item) => [item.seq, item.kind, item.kind === "work" ? item.event.eventId : item.request.eventId, item.kind === "work" ? item.event.status : item.request.status]))
      .toEqual([[2, "work", "fails", "failed"], [3, "work", "stopped", "cancelled"], [4, "request", "ask", "answered"]]);
    expect(second.data[2]).toMatchObject({ kind: "request", request: { choice: "deny" } });
    expect(second.cursor).toBe(4);
    expect(h.sessions.settlements({ after: second.cursor })).toEqual({ data: [], cursor: 4 });
    // Paging, and a turn that is still running is not in the list.
    expect(h.sessions.settlements({ limit: 2 })).toMatchObject({ data: [{ seq: 1 }, { seq: 2 }], cursor: 2 });
    expect(h.sessions.get("runs").status).toBe("working");
    host.finish(h.sessions.get("runs").runId!, "late answer");
    await h.round();
    expect(h.sessions.settlements({ after: 4 }).data).toMatchObject([{ seq: 5, kind: "work", event: { eventId: "runs", status: "completed", answer: "late answer" } }]);
    expect(() => h.sessions.settlements({ after: -1 })).toThrow();
    expect(() => h.sessions.settlements({ limit: 0 })).toThrow();
  });
  it("record a turn whose outcome is unknown only when it is closed, and a turn canceled before it started", async () => {
    const h = await setup();
    h.host.failStart = new Error("socket_hang_up");
    await h.sessions.submit({ eventId: "lost", input: "one", admission: admission("delegation") });
    await h.round(1);
    expect(h.sessions.get("lost")).toMatchObject({ status: "unknown", outcomeUnknown: true });
    expect(h.sessions.settlements().data).toEqual([]);
    const claimId = h.worker.status().runs[0]!.claimId;
    await h.worker.closeUnknown(claimId);
    expect(h.sessions.settlements().data).toMatchObject([{ kind: "work", event: { eventId: "lost", status: "failed" } }]);
    h.host.failStart = undefined;
    await h.sessions.submit({ eventId: "never", input: "two", admission: admission("delegation") });
    await h.sessions.cancel("never");
    expect(h.sessions.settlements({ after: 1 }).data).toMatchObject([{ kind: "work", event: { eventId: "never", status: "cancelled" } }]);
  });
  it("lists a turn that answers the owner when its task ends; its reply receipt follows", async () => {
    const h = await setup();
    await ownerOnChat(h);
    await h.sessions.submit({ eventId: "answering", sessionId: OWNER_CHAT, input: "The partner finished.", admission: admission("delegation"), reply: {} });
    await h.round(); h.host.finish(2, "Your report is ready.");
    await h.worker.tick(); await h.worker.tick();
    expect(h.sessions.settlements().data).toMatchObject([{ kind: "work", event: { eventId: "answering", status: "completed", answer: "Your report is ready.", reply: { state: "pending" } } }]);
    await h.round();
    expect(h.sessions.settlements().data).toMatchObject([{ kind: "work", event: { reply: { connectionId: "chat", state: "accepted" } } }]);
  });
  it("lists an open owner request as expired when the owner clears the conversation", async () => {
    const h = await setup();
    h.sessions.request(approval("cleared"));
    await h.control.purge(OWNER_CHAT);
    expect(h.sessions.settlements().data).toMatchObject([{ kind: "request", request: { eventId: "cleared", status: "expired" } }]);
  });
  it("does not list channel turns", async () => {
    const h = await setup();
    await ownerOnChat(h);
    expect(h.sessions.settlements()).toEqual({ data: [], cursor: 0 });
  });
});
