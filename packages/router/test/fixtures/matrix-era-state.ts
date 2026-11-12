import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A Router state directory written by 0.8.0-alpha.2 with Matrix on (`matrix-era-state.json`, a dump of its SQLite
 * files and configuration): one agent, `coco`, of `@owner:example.test`, created with a Matrix account, with a Matrix
 * connection (`{ id: "matrix", kind: "matrix" }`), a bound Host and one finished owner turn over Matrix. The agent
 * record has no `matrix` state, as records written before 0.7 do not. Only `AGENT_LEDGER_READ` was on.
 */
export interface MatrixEraState {
  owner: string;
  agent: { id: string; owner: string; name: string; address: string; matrixId: string; createdAt: string; status: string };
  /** `communication_host/scope` as that release stored it (Host instructions `prior instructions`, runtime `fixture`). */
  scope: string;
  /** The owner-main conversation and its Host session binding. */
  session: string; binding: { sessionId: string; runtimeId: string };
  instanceId: string;
}
interface Dump extends MatrixEraState {
  files: Record<string, unknown>;
  databases: Record<string, { userVersion: number; tables: string[]; rows: Record<string, { columns: string[]; values: unknown[][] }>; after: string[] }>;
}
const dump = JSON.parse(readFileSync(new URL("./matrix-era-state.json", import.meta.url), "utf8")) as Dump;

/** Write the state into `stateDir` (which must be empty) and return what the release recorded about it. */
export function restoreMatrixEraState(stateDir: string): MatrixEraState {
  for (const [name, value] of Object.entries(dump.files)) {
    const path = join(stateDir, name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  }
  for (const [name, database] of Object.entries(dump.databases)) {
    const path = join(stateDir, name); mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      for (const sql of database.tables) db.exec(sql);
      for (const [table, { columns, values }] of Object.entries(database.rows)) {
        const insert = db.prepare(`INSERT INTO "${table}"(${columns.map((column) => `"${column}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
        for (const row of values) insert.run(...row.map((value) => value && typeof value === "object" ? Buffer.from((value as { $blob: string }).$blob, "base64") : value as string | number | null));
      }
      for (const sql of database.after) db.exec(sql);
      db.exec(`PRAGMA user_version=${database.userVersion}`);
    } finally { db.close(); }
  }
  const { files: _files, databases: _databases, ...state } = dump;
  return state;
}
