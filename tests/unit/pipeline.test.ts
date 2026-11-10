import { describe, expect, it } from "vitest";
import { assertDbAllowed, PROD_DB_PATH } from "../../src/config/env.js";
import { openDb } from "../../src/db/index.js";
import { dedupeHash, normalizeTitle } from "../../src/pipeline/dedupe.js";
import { assertTransition, canTransition, IllegalTransitionError, recordEvent, STATES, transition } from "../../src/pipeline/states.js";
import { acquireLease, releaseLease, runExclusive } from "../../src/run/lease.js";
import { redactText } from "../../src/log.js";
import { dropBelowScoreFloor } from "../../src/run/pipeline.js";
import { testDb } from "../helpers.js";

function insertPosting(db: ReturnType<typeof testDb>, state: string) {
  db.prepare("INSERT INTO companies (name, ats, token) VALUES ('Acme','greenhouse','acme') ON CONFLICT DO NOTHING").run();
  const r = db
    .prepare("INSERT INTO postings (company_id, ats, ats_job_id, company_name, title, url, content_hash, dedupe_hash, state, first_seen_at, last_seen_at, retrieved_at) VALUES (1,'greenhouse',?, 'Acme','SWE','u','h','d',?, 'now','now','now')")
    .run(String(Math.random()), state);
  return Number(r.lastInsertRowid);
}

describe("state machine", () => {
  it("allows the normal path and rejects illegal transitions", () => {
    expect(canTransition("DISCOVERED", "NORMALIZED")).toBe(true);
    expect(() => assertTransition("DISCOVERED", "SUBMITTED")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("QUALIFIED", "SUBMITTING")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("CLOSED", "QUALIFIED")).toThrow(IllegalTransitionError);
  });

  it("approval, rejection, and deferral are user-only", () => {
    expect(canTransition("READY_FOR_REVIEW", "APPROVED", "system")).toBe(false);
    expect(canTransition("READY_FOR_REVIEW", "APPROVED", "user")).toBe(true);
    expect(canTransition("READY_FOR_REVIEW", "DEFERRED", "system")).toBe(false);
  });

  it("an interrupted submission can only go to SUBMITTED or SUBMISSION_UNCERTAIN, and never retries automatically", () => {
    expect(canTransition("SUBMITTING", "SUBMISSION_UNCERTAIN")).toBe(true);
    expect(canTransition("SUBMITTING", "APPROVED")).toBe(false);
    expect(canTransition("SUBMISSION_UNCERTAIN", "SUBMITTING")).toBe(false);
    expect(canTransition("SUBMISSION_UNCERTAIN", "SUBMITTED", "system")).toBe(false);
    expect(canTransition("SUBMISSION_UNCERTAIN", "SUBMITTED", "user")).toBe(true);
  });

  it("USER_REJECTED and REJECTED are distinct states", () => {
    expect(STATES).toContain("USER_REJECTED");
    expect(STATES).toContain("REJECTED");
    expect(canTransition("READY_FOR_REVIEW", "REJECTED", "user")).toBe(false);
  });

  it("regression (decision 0003): the system can never release a NEEDS_ATTENTION hold", () => {
    for (const to of ["QUALIFIED", "DRAFTING", "READY_FOR_REVIEW", "DEFERRED"] as const) {
      expect(canTransition("NEEDS_ATTENTION", to, "system")).toBe(false);
      expect(canTransition("NEEDS_ATTENTION", to, "user")).toBe(true);
    }
    // Decision 0005: the system may reject (never release) a hold below the score floor.
    expect(canTransition("NEEDS_ATTENTION", "USER_REJECTED", "user")).toBe(true);
  });

  it("decision 0005: holds scored below the floor are rejected; unscored and at-floor holds stay", () => {
    const db = testDb();
    const low = insertPosting(db, "NEEDS_ATTENTION");
    const atFloor = insertPosting(db, "NEEDS_ATTENTION");
    const unscored = insertPosting(db, "NEEDS_ATTENTION");
    const qualifiedLow = insertPosting(db, "QUALIFIED");
    db.prepare("UPDATE postings SET suitability_score = ? WHERE id = ?").run(0.69, low);
    db.prepare("UPDATE postings SET suitability_score = ? WHERE id = ?").run(0.7, atFloor);
    db.prepare("UPDATE postings SET suitability_score = ? WHERE id = ?").run(0.2, qualifiedLow);
    expect(dropBelowScoreFloor(db, 0.7).dropped).toEqual([low]);
    const state = (id: number) => (db.prepare("SELECT state FROM postings WHERE id = ?").get(id) as { state: string }).state;
    expect(state(low)).toBe("USER_REJECTED");
    expect(state(atFloor)).toBe("NEEDS_ATTENTION");
    expect(state(unscored)).toBe("NEEDS_ATTENTION");
    expect(state(qualifiedLow)).toBe("QUALIFIED");
    const ev = db.prepare("SELECT actor, detail_json FROM events WHERE posting_id = ? AND kind = 'state_change'").get(low) as { actor: string; detail_json: string };
    expect(ev.actor).toBe("system");
    expect(JSON.parse(ev.detail_json)).toMatchObject({ reason: "below_score_floor", decision: "0005" });
  });

  it("removed listings close any pre-submission state but not submitted ones", () => {
    expect(canTransition("QUALIFIED", "CLOSED")).toBe(true);
    expect(canTransition("NEEDS_ATTENTION", "CLOSED")).toBe(true);
    expect(canTransition("SUBMITTING", "CLOSED")).toBe(false);
  });

  it("transition() writes the state and an event atomically", () => {
    const db = testDb();
    const id = insertPosting(db, "DISCOVERED");
    transition(db, id, "NORMALIZED", "system");
    expect((db.prepare("SELECT state FROM postings WHERE id = ?").get(id) as { state: string }).state).toBe("NORMALIZED");
    expect(db.prepare("SELECT from_state, to_state, actor FROM events WHERE posting_id = ?").all(id)).toEqual([{ from_state: "DISCOVERED", to_state: "NORMALIZED", actor: "system" }]);
    expect(() => transition(db, id, "APPROVED", "system")).toThrow();
    expect((db.prepare("SELECT state FROM postings WHERE id = ?").get(id) as { state: string }).state).toBe("NORMALIZED");
  });
});

describe("event log", () => {
  it("is immutable", () => {
    const db = testDb();
    recordEvent(db, { kind: "test", actor: "system" });
    expect(() => db.prepare("UPDATE events SET kind = 'x'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/immutable/);
  });
});

describe("deduplication keys", () => {
  it("collapses location and arrangement variants", () => {
    expect(normalizeTitle("Software Engineer (Remote)")).toBe(normalizeTitle("Software Engineer - New York"));
    expect(normalizeTitle("Sr. Software Engineer")).toBe("senior software engineer");
    expect(dedupeHash("Acme AI, Inc.", "Software Engineer [NYC]")).toBe(dedupeHash("Acme", "Software Engineer"));
  });
  it("keeps different specializations apart", () => {
    expect(normalizeTitle("Software Engineer - Agents")).not.toBe(normalizeTitle("Software Engineer - Billing"));
    expect(normalizeTitle("Software Engineer (Agents)")).not.toBe(normalizeTitle("Software Engineer"));
    expect(dedupeHash("Acme", "Software Engineer")).not.toBe(dedupeHash("Other Co", "Software Engineer"));
  });
});

describe("run lease (duplicate scheduler runs)", () => {
  it("a second concurrent run is skipped", async () => {
    const db = testDb();
    let release!: () => void;
    const first = runExclusive(db, "daily", 60000, () => new Promise<string>((r) => (release = () => r("done"))));
    const second = await runExclusive(db, "daily", 60000, async () => "should not run");
    expect(second.status).toBe("skipped");
    release();
    expect((await first).status).toBe("succeeded");
    const third = await runExclusive(db, "daily", 60000, async () => "ok");
    expect(third.status).toBe("succeeded");
  });

  it("an expired lease from a crashed run can be taken over", () => {
    const db = testDb();
    expect(acquireLease(db, "daily", 1000, new Date("2026-10-21T00:00:00Z"))).toBeTruthy();
    expect(acquireLease(db, "daily", 1000, new Date("2026-10-21T00:00:00.500Z"))).toBeNull();
    const h = acquireLease(db, "daily", 1000, new Date("2026-10-21T00:00:02Z"));
    expect(h).toBeTruthy();
    releaseLease(db, "daily", h!);
  });

  it("records failures", async () => {
    const db = testDb();
    const out = await runExclusive(db, "daily", 60000, async () => {
      throw new Error("boom");
    });
    expect(out.status).toBe("failed");
    expect(db.prepare("SELECT status, error FROM runs WHERE id = ?").get(out.runId)).toEqual({ status: "failed", error: "boom" });
  });
});

describe("test/production isolation", () => {
  it("refuses the production database under test", () => {
    expect(() => assertDbAllowed({ CAS_ENV: "test" }, PROD_DB_PATH)).toThrow(/Refusing/);
    expect(() => openDb({ path: PROD_DB_PATH, env: { CAS_ENV: "test" } })).toThrow(/Refusing/);
    expect(() => assertDbAllowed({ CAS_ENV: "test" }, ":memory:")).not.toThrow();
  });
  it("dev cannot open the production database (incident 2026-10-22)", () => {
    expect(() => assertDbAllowed({ CAS_ENV: "dev" }, PROD_DB_PATH)).toThrow(/Refusing/);
  });
});

describe("log redaction", () => {
  it("removes emails, phone numbers, and API keys", () => {
    const fakeKey = ["sk", "ant", "abc123456789xyz"].join("-"); // built at runtime so no key-shaped string sits in source
    const s = redactText(`mail me at jane@example.com or 301-555-1234, key ${fakeKey}`);
    expect(s).not.toMatch(/jane@|555-1234|sk-ant-abc/);
  });
});
