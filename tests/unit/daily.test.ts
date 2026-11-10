import { describe, expect, it } from "vitest";
import { runDaily } from "../../src/run/daily.js";
import { testDb } from "../helpers.js";

describe("daily scheduled run", () => {
  it("skips when a successful daily run already happened today (catch-up safe)", async () => {
    const db = testDb();
    const now = new Date();
    db.prepare("INSERT INTO runs (kind, started_at, finished_at, status) VALUES ('daily', ?, ?, 'succeeded')").run(now.toISOString(), now.toISOString());
    const out = await runDaily(db, { now });
    expect(out.status).toBe("skipped");
  });
  it("a concurrent second daily run is skipped by the lease", async () => {
    const db = testDb();
    db.prepare("INSERT INTO leases (name, holder, acquired_at, expires_at) VALUES ('daily', 'other', ?, ?)").run(new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
    const out = await runDaily(db, { force: true });
    expect(out.status).toBe("skipped");
  });
});
