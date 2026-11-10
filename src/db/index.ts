import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { assertDbAllowed, loadEnv, type Env } from "../config/env.js";
import { MIGRATIONS } from "./migrations.js";

export type DB = Database.Database;

export function openDb(opts: { path?: string; env?: Pick<Env, "CAS_ENV"> } = {}): DB {
  const env = opts.env ?? loadEnv();
  const dbPath = opts.path ?? loadEnv().dbPath;
  assertDbAllowed(env, dbPath);
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r) => (r as { id: number }).id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
    })();
  }
}
