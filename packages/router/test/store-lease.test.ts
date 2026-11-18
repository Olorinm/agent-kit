import { expect, it } from "vitest";
import { DurableStore } from "../src/communication/store.js";

it("keeps a held lease without writing until its second half, and refuses another owner while it is valid", () => {
  const store = new DurableStore(":memory:", "test");
  const changes = () => Number(store.db.prepare("SELECT total_changes() AS n").get()!.n);
  const start = 1_000_000;
  store.acquireLease("a", start);
  const afterFirst = changes();
  // A five-second heartbeat writes on every third beat.
  store.acquireLease("a", start + 5_000); store.acquireLease("a", start + 10_000);
  expect(changes()).toBe(afterFirst);
  store.acquireLease("a", start + 15_000);
  expect(changes()).toBe(afterFirst + 1);
  expect(store.get<{ expires: number }>("meta", "lease")!.expires).toBe(start + 45_000);

  expect(() => store.acquireLease("b", start + 44_999)).toThrow("connector_store_already_in_use");
  store.acquireLease("b", start + 45_000);
  expect(store.get<{ owner: string }>("meta", "lease")!.owner).toBe("b");
  store.releaseLease("a");
  expect(store.get("meta", "lease")).toBeDefined();
  store.releaseLease("b");
  expect(store.get("meta", "lease")).toBeUndefined();
  store.close();
});
