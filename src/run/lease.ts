import { randomUUID } from "node:crypto";
import type { DB } from "../db/index.js";

/**
 * Acquires a named lease. Returns a holder id, or null if another live holder exists.
 * Expired leases (crashed runs) can be taken over.
 */
export function acquireLease(db: DB, name: string, ttlMs: number, now = new Date()): string | null {
  const holder = `${process.pid}-${randomUUID()}`;
  const acquire = db.transaction(() => {
    const row = db.prepare("SELECT holder, expires_at FROM leases WHERE name = ?").get(name) as { holder: string; expires_at: string } | undefined;
    if (row && new Date(row.expires_at).getTime() > now.getTime()) return null;
    db.prepare(
      "INSERT INTO leases (name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at",
    ).run(name, holder, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
    return holder;
  });
  return acquire.immediate();
}

export function releaseLease(db: DB, name: string, holder: string): void {
  db.prepare("DELETE FROM leases WHERE name = ? AND holder = ?").run(name, holder);
}

export interface RunOutcome<T> {
  status: "succeeded" | "failed" | "skipped";
  runId: number;
  result?: T;
  error?: string;
}

/** Runs fn under a lease and records the run. A concurrent second run is recorded as skipped. */
export async function runExclusive<T>(db: DB, kind: string, ttlMs: number, fn: (runId: number) => Promise<T>): Promise<RunOutcome<T>> {
  const startedAt = new Date().toISOString();
  const holder = acquireLease(db, kind, ttlMs);
  if (!holder) {
    const r = db.prepare("INSERT INTO runs (kind, started_at, finished_at, status, error) VALUES (?, ?, ?, 'skipped', ?)").run(kind, startedAt, startedAt, "another run holds the lease");
    return { status: "skipped", runId: Number(r.lastInsertRowid), error: "another run holds the lease" };
  }
  const runId = Number(db.prepare("INSERT INTO runs (kind, started_at, status) VALUES (?, ?, 'running')").run(kind, startedAt).lastInsertRowid);
  try {
    const result = await fn(runId);
    db.prepare("UPDATE runs SET finished_at = ?, status = 'succeeded', stats_json = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify(result ?? null), runId);
    return { status: "succeeded", runId, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE runs SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(new Date().toISOString(), msg, runId);
    return { status: "failed", runId, error: msg };
  } finally {
    releaseLease(db, kind, holder);
  }
}

export function lastSuccessfulRun(db: DB, kind: string): string | null {
  const r = db.prepare("SELECT max(finished_at) AS t FROM runs WHERE kind = ? AND status = 'succeeded'").get(kind) as { t: string | null };
  return r.t;
}
