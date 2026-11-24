import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("keeps file-backed leases exclusive without adding heartbeat frames to the replicated database", () => {
  const root = mkdtempSync(join(tmpdir(), "router-lease-"));
  const file = join(root, "agent.sqlite");
  const old = new DurableStore(file, "test");
  old.acquireLease("previous", 1000);
  old.close();
  vi.stubEnv("AGENT_LOCAL_LEASE_DIR", join(root, "local"));
  try {
    const first = new DurableStore(file, "test"), second = new DurableStore(file, "test");
    try {
      expect(() => first.acquireLease("new", 30_999)).toThrow("connector_store_already_in_use");
      first.acquireLease("new", 31_000);
      first.db.exec("PRAGMA main.wal_checkpoint(TRUNCATE)");
      first.acquireLease("new", 46_000);
      expect(statSync(file + "-wal").size).toBe(0);
      expect(second.lease.current()).toEqual({ owner: "new", expires: 76_000 });
      expect(() => second.acquireLease("other", 75_999)).toThrow("connector_store_already_in_use");
      second.acquireLease("other", 76_000);
      first.releaseLease("new");
      expect(second.lease.current()?.owner).toBe("other");
    } finally { first.close(); second.close(); }
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
