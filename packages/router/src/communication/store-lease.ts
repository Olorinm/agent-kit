import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

interface Lease { owner: string; expires: number }

/** Process coordination shares the database transaction lock. On ephemeral container disks
 * renewals can live in an attached, machine-local file outside the replicated state tree. */
export class StoreLease {
  private readonly table: string;

  constructor(private readonly db: DatabaseSync, path: string, private readonly conflict: string) {
    const directory = process.env.AGENT_LOCAL_LEASE_DIR;
    this.table = "main.documents";
    if (!directory || path === ":memory:") return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(realpathSync(path)).digest("hex");
    const file = join(directory, key + ".db");
    db.prepare("ATTACH DATABASE ? AS coordination").run(file);
    chmodSync(file, 0o600);
    db.exec("CREATE TABLE IF NOT EXISTS coordination.lease (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    this.table = "coordination.lease";
  }

  current(): Lease | undefined {
    const row = this.table === "main.documents"
      ? this.db.prepare("SELECT value FROM main.documents WHERE collection='meta' AND id='lease'").get()
      : this.db.prepare("SELECT value FROM coordination.lease WHERE id=1").get();
    return row && JSON.parse(row.value as string) as Lease;
  }

  /** Called inside BEGIN IMMEDIATE, which locks both the journal and its attached lease. */
  acquire(owner: string, now: number): void {
    if (this.table === "coordination.lease") {
      const old = this.db.prepare("SELECT value FROM main.documents WHERE collection='meta' AND id='lease'").get();
      if (old) {
        const previous = JSON.parse(old.value as string) as Lease;
        if (previous.owner !== owner && previous.expires > now) throw new Error(this.conflict);
        this.db.exec("DELETE FROM main.documents WHERE collection='meta' AND id='lease'");
      }
    }
    const lease = this.current();
    if (lease && lease.owner !== owner && lease.expires > now) throw new Error(this.conflict);
    if (lease?.owner === owner && lease.expires - now > 15_000) return;
    const value = JSON.stringify({ owner, expires: now + 30_000 });
    if (this.table === "coordination.lease") {
      this.db.prepare("INSERT INTO coordination.lease VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value);
    } else {
      this.db.prepare("INSERT INTO main.documents VALUES('meta','lease',?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value").run(value);
    }
  }

  release(owner: string): void {
    const sql = this.table === "coordination.lease"
      ? "DELETE FROM coordination.lease WHERE id=1 AND json_extract(value,'$.owner')=?"
      : "DELETE FROM main.documents WHERE collection='meta' AND id='lease' AND json_extract(value,'$.owner')=?";
    this.db.prepare(sql).run(owner);
  }
}
