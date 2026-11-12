import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendMessageRequest, TaskState, type Task } from "@a2a-js/sdk";
import { CliWork } from "../src/execution/work.js";
import { DurableStore } from "../src/communication/store.js";

const A = "@alice:a.example", B = "@bob:b.example";
const source = { sender: A, room: "!room:a.example", approved: false };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const request = (text = "hello", fields: object = {}) => SendMessageRequest.fromJSON({
  message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...fields }, configuration: { returnImmediately: true },
});
function queue(policy: () => "allow" | "ask" | "deny" = () => "allow") {
  const store = new DurableStore(":memory:", B); cleanup.push(() => store.close());
  return new CliWork(store, policy);
}
describe("work queue", () => {
  it("claims atomically, returns a lost claim to the same worker, and serializes a conversation", async () => {
    const work = queue();
    const first = await work.send(request(), source);
    const second = await work.send(request("next", { contextId: first.contextId }), source);
    const claim = work.claim("session-a")!;
    expect(claim.id).toBe(first.id); expect(work.claim("session-a")).toEqual(claim);
    expect(work.claim("session-b")).toBeNull();
    expect(() => work.claim("session-a", second.id)).toThrow("worker_already_has_work");
    work.update(claim.claimId!, "reply", "done");
    expect(work.claim("session-b")!.id).toBe(second.id);
  });
  it("persists claims and output events across restart without redelivering them to another worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-work-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let store = new DurableStore(join(dir, "work.sqlite"), B);
    let work = new CliWork(store, () => "allow");
    const task = await work.send(request(), source), claim = work.claim("persistent-session")!;
    work.update(claim.claimId!, "progress", "half done"); store.close();
    store = new DurableStore(join(dir, "work.sqlite"), B); cleanup.push(() => store.close());
    work = new CliWork(store, () => "allow");
    expect(work.claim("other-session")).toBeNull();
    expect(work.claim("persistent-session")!.claimId).toBe(claim.claimId);
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(work.events()).toHaveLength(2);
    work.update(claim.claimId!, "reply", "recovered");
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("durably orders progress and results, and retries the same reply without duplicate output", async () => {
    const work = queue(), req = request();
    const task = await work.send(req, source); expect((await work.send(req, source)).id).toBe(task.id);
    const claim = work.claim("worker")!;
    work.update(claim.claimId!, "progress", "working");
    const result = work.update(claim.claimId!, "reply", "answer", { count: 3 });
    expect(work.update(claim.claimId!, "reply", "answer", { count: 3 })).toEqual(result);
    expect(work.events().map((e) => e.value.status?.state)).toEqual([2, 2, 3]);
    expect(() => work.update(claim.claimId!, "reply", "different answer")).toThrow("claim_closed");
    expect((await work.get(task.id)).artifacts[0]!.parts).toHaveLength(2);
  });
  it("continues input-required work in the same context with a new claim and rejects stale submissions", async () => {
    const work = queue(), task = await work.send(request(), source);
    const claim = work.claim("worker")!; work.update(claim.claimId!, "need-input", "Which file?");
    expect(work.claim("worker")).toBeNull();
    const continued = await work.send(request("report.txt", { taskId: task.id, contextId: task.contextId }), source);
    expect(continued.id).toBe(task.id); expect(continued.contextId).toBe(task.contextId);
    const next = work.claim("worker")!; expect(next.claimId).not.toBe(claim.claimId);
    expect(() => work.update(claim.claimId!, "reply", "stale")).toThrow("claim_closed");
    work.update(next.claimId!, "reply", "done");
  });
  it("requires acknowledging new input arriving during work before allowing completion", async () => {
    const work = queue(), task = await work.send(request(), source), claim = work.claim("worker")!;
    await work.send(request("additional input", { taskId: task.id }), source);
    expect(work.inspect(claim.claimId!).newInput).toBe(true);
    expect(() => work.update(claim.claimId!, "reply", "old answer")).toThrow("new_input_available_claim_again");
    const next = work.claim("worker")!; expect(next.claimId).not.toBe(claim.claimId);
    expect(next.history).toHaveLength(2);
    work.update(next.claimId!, "reply", "updated answer");
  });
  it("cancels unclaimed work immediately but waits for claimed work to acknowledge stopping", async () => {
    const work = queue(), unclaimed = await work.send(request(), source);
    expect((await work.cancel(unclaimed.id)).status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(work.claim("worker")).toBeNull();
    const task = await work.send(request(), source), claim = work.claim("worker")!;
    expect((await work.cancel(task.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(work.inspect(claim.claimId!).cancelRequested).toBe(true);
    expect(() => work.update(claim.claimId!, "reply", "too late")).toThrow("cancellation_requested_stop_and_acknowledge");
    work.update(claim.claimId!, "cancelled", "Stopped.");
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("rechecks authorization before claiming and stops work when the sender is blocked", async () => {
    let permission: "allow" | "ask" | "deny" = "allow";
    const work = queue(() => permission), task = await work.send(request(), source);
    permission = "ask"; expect(work.claim("worker")).toBeNull(); expect(work.inspect(task.id).needsApproval).toBe(true);
    work.approve(task.id); const claim = work.claim("worker")!;
    permission = "deny"; work.reconcile(); expect(work.inspect(task.id).cancelRequested).toBe(true);
    expect(() => work.update(claim.claimId!, "progress", "continuing")).toThrow("cancellation_requested");
    work.update(claim.claimId!, "cancelled", "Stopped.");
    const other = await work.send(request(), source); work.reconcile();
    expect((await work.get(other.id)).status?.state).toBe(TaskState.TASK_STATE_REJECTED);
  });
  it("preserves the claim after an oversized result is rejected and accepts a smaller retry", async () => {
    const work = queue(), task = await work.send(request(), source), claim = work.claim("worker")!;
    expect(() => work.update(claim.claimId!, "reply", "x".repeat(50000))).toThrow("result_too_large");
    expect(work.inspect(task.id).claimId).toBe(claim.claimId);
    work.update(claim.claimId!, "reply", "x".repeat(30000));
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("isolates senders and room contexts and rejects changed retries", async () => {
    const work = queue(), req = request(), task = await work.send(req, source);
    req.message!.parts = request("tampered").message!.parts;
    await expect(work.send(req, source)).rejects.toThrow("work_message_id_reused");
    await expect(work.send(request("tampered", { taskId: task.id }), { ...source, sender: B })).rejects.toThrow("work_scope_mismatch");
  });
  it("keeps a context on the worker that first claimed it when claims are pinned", async () => {
    const work = queue();
    const first = await work.send(request("remember", { contextId: "context" }), source);
    const claim = work.claim("one", undefined, true)!;
    expect(claim.worker).toBe("one");
    expect(work.claim("two", undefined, true)).toBeNull();
    expect(() => work.update(claim.claimId!, "reply", "stolen", undefined, "two")).toThrow("claim_belongs_to_another_instance");
    work.update(claim.claimId!, "reply", "done", undefined, "one");
    expect((await work.get(first.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await work.send(request("continue", { contextId: "context" }), source);
    await work.send(request("independent", { contextId: "other-context" }), source);
    expect(work.claim("two", undefined, true)!.contextId).toBe("other-context");
    expect(work.claim("one", undefined, true)!.contextId).toBe("context");
  });
});
