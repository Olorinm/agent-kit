import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../dist/index.js";

test("the store runs in WAL mode and every file it leaves on disk is private", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "connectors-store-"));
  try {
    const store = new Store(directory);
    store.putCredential("connection", "sealed", new Date());
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    const files = readdirSync(directory).sort();
    assert.deepEqual(files, ["connectors.sqlite", "connectors.sqlite-shm", "connectors.sqlite-wal"]);
    for (const file of files) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600, file);
    store.db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
