import { describe, expect, it } from "vitest";
import type { CompanyConfig } from "../../src/discovery/types.js";
import { politeFetcher } from "../../src/discovery/http.js";
import { fetchBoard } from "../../src/discovery/adapters.js";
import { discover, reevaluate } from "../../src/run/discover.js";
import { cfg, fixtureFetcher, readFixture, testDb } from "../helpers.js";

const COMPANIES: CompanyConfig[] = [
  { name: "Vercel", ats: "greenhouse", token: "vercel", priority: "A" },
  { name: "Palantir", ats: "lever", token: "palantir", priority: "A" },
  { name: "Linear", ats: "ashby", token: "linear", priority: "A" },
];

type Row = { id: number; title: string; state: string; location_raw: string; duplicate_of: number | null; closed_at: string | null };
const rows = (db: ReturnType<typeof testDb>) => db.prepare("SELECT id, title, state, location_raw, duplicate_of, closed_at FROM postings ORDER BY id").all() as Row[];

describe("discovery pipeline (recorded fixtures)", () => {
  it("stores every listed posting with a snapshot, URL, and timestamp", async () => {
    const db = testDb();
    const stats = await discover(db, COMPANIES, fixtureFetcher(), cfg);
    expect(stats.boardFailures).toEqual([]);
    const n = (db.prepare("SELECT count(*) AS n FROM postings").get() as { n: number }).n;
    expect(n).toBeGreaterThan(8);
    expect(db.prepare("SELECT count(*) AS n FROM postings WHERE url = '' OR retrieved_at IS NULL OR first_seen_at IS NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(DISTINCT posting_id) AS n FROM posting_snapshots").get()).toEqual({ n });
    // Every posting reaches a decided state with a full event trail.
    for (const r of rows(db)) {
      expect(["QUALIFIED", "INELIGIBLE", "NEEDS_ATTENTION"]).toContain(r.state);
      const ev = db.prepare("SELECT to_state FROM events WHERE posting_id = ? ORDER BY id").all(r.id) as { to_state: string }[];
      expect(ev.map((e) => e.to_state).slice(0, 3)).toEqual(["DISCOVERED", "NORMALIZED", "ELIGIBILITY_PENDING"]);
    }
  });

  it("classifies the recorded postings as expected", async () => {
    const db = testDb();
    await discover(db, COMPANIES, fixtureFetcher(), cfg);
    const by = (title: string, loc?: string) => rows(db).filter((r) => r.title === title && (!loc || r.location_raw.includes(loc)));
    expect(by("Software Engineer, Backend")[0]?.state).toBe("QUALIFIED"); // Vercel, remote US, $ known
    expect(by("Account Executive, Commercial").every((r) => r.state === "INELIGIBLE")).toBe(true);
    expect(by("Forward Deployed AI Engineer", "New York")[0]?.state).toBe("INELIGIBLE"); // NYC office
    expect(by("Senior / Staff Product Engineer", "North America")[0]?.state).toBe("QUALIFIED");
    expect(by("Senior / Staff Product Engineer", "Europe")[0]?.state).toBe("INELIGIBLE");
    expect(by("Deployment Strategist, Internship")[0]?.state).toBe("INELIGIBLE");
  });

  it("regression: Ashby isRemote=true does not override an explicit Hybrid workplace type", async () => {
    const db = testDb();
    const list = readFixture("ashby-linear.json") as { jobs: Record<string, unknown>[] };
    const sf = { ...list.jobs[0]!, id: "hybrid-sf", title: "Software Engineer, Platform", location: "San Francisco", secondaryLocations: [], workplaceType: "Hybrid", isRemote: true, address: { postalAddress: { addressCountry: "United States" } } };
    await discover(db, [COMPANIES[2]!], fixtureFetcher({ "job-board/linear": { status: 200, json: { jobs: [sf] } } }), cfg);
    const r = db.prepare("SELECT state, json_extract(location_json, '$.classification') AS cls FROM postings").get() as { state: string; cls: string };
    expect(r).toEqual({ state: "INELIGIBLE", cls: "OFFICE_OTHER_US" });
  });

  it("skips Ashby postings marked unlisted", async () => {
    const db = testDb();
    const stats = await discover(db, [COMPANIES[2]!], fixtureFetcher(), cfg);
    expect(stats.listed).toBe(5);
    expect(stats.newPostings).toBe(4);
  });

  it("is idempotent: a second run creates no duplicates and no new events", async () => {
    const db = testDb();
    const f = fixtureFetcher();
    await discover(db, COMPANIES, f, cfg);
    const before = { p: rows(db).length, e: (db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n };
    const s2 = await discover(db, COMPANIES, f, cfg);
    expect(s2.newPostings).toBe(0);
    expect(s2.changed).toBe(0);
    expect(rows(db).length).toBe(before.p);
    expect((db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(before.e);
  });

  it("marks a second posting of the same role as a duplicate", async () => {
    const db = testDb();
    const list = readFixture("ashby-linear.json") as { jobs: Record<string, unknown>[] };
    const na = list.jobs.find((j) => j.title === "Product Engineer")!;
    const copy = { ...na, id: "dup-copy", title: "Product Engineer (Remote)", jobUrl: "https://jobs.ashbyhq.com/linear/dup-copy" };
    const f = fixtureFetcher({ "job-board/linear": { status: 200, json: { jobs: [...list.jobs, copy] } } });
    const stats = await discover(db, [COMPANIES[2]!], f, cfg);
    expect(stats.duplicates).toBe(1);
    const dup = rows(db).find((r) => r.title === "Product Engineer (Remote)")!;
    expect(dup.state).toBe("INELIGIBLE");
    expect(dup.duplicate_of).toBe(rows(db).find((r) => r.title === "Product Engineer")!.id);
  });

  it("closes listings removed from the board (expired listing)", async () => {
    const db = testDb();
    await discover(db, [COMPANIES[2]!], fixtureFetcher(), cfg);
    const list = readFixture("ashby-linear.json") as { jobs: { title: string; location: string }[] };
    const remaining = list.jobs.filter((j) => !(j.title === "Product Engineer"));
    const stats = await discover(db, [COMPANIES[2]!], fixtureFetcher({ "job-board/linear": { status: 200, json: { jobs: remaining } } }), cfg);
    expect(stats.closed).toBe(1);
    const gone = rows(db).find((r) => r.title === "Product Engineer")!;
    expect(gone.state).toBe("CLOSED");
    expect(gone.closed_at).toBeTruthy();
  });

  it("re-evaluates a changed listing", async () => {
    const db = testDb();
    await discover(db, [COMPANIES[2]!], fixtureFetcher(), cfg);
    const list = readFixture("ashby-linear.json") as { jobs: Record<string, unknown>[] };
    const changed = list.jobs.map((j) => (j.title === "Product Engineer" ? { ...j, descriptionPlain: `${j.descriptionPlain}\nActive TS/SCI clearance required.` } : j));
    const s = await discover(db, [COMPANIES[2]!], fixtureFetcher({ "job-board/linear": { status: 200, json: { jobs: changed } } }), cfg);
    expect(s.changed).toBe(1);
    expect(rows(db).find((r) => r.title === "Product Engineer")!.state).toBe("INELIGIBLE");
    expect(db.prepare("SELECT count(*) AS n FROM posting_snapshots s JOIN postings p ON p.id = s.posting_id WHERE p.title = 'Product Engineer'").get()).toEqual({ n: 2 });
  });

  it("a failed board (404, network, malformed JSON) is recorded and closes nothing", async () => {
    const db = testDb();
    await discover(db, [COMPANIES[2]!], fixtureFetcher(), cfg);
    for (const bad of [{ status: 404, json: null }, { status: 0, json: null }, { status: 200, json: { unexpected: true } }]) {
      const s = await discover(db, [COMPANIES[2]!], fixtureFetcher({ "job-board/linear": bad }), cfg);
      expect(s.boardFailures).toHaveLength(1);
      expect(s.closed).toBe(0);
    }
    expect(rows(db).every((r) => r.state !== "CLOSED")).toBe(true);
    expect(db.prepare("SELECT last_fetch_status FROM companies").get()).toEqual({ last_fetch_status: "error" });
  });

  it("routes an employer AI-use policy to NEEDS_ATTENTION and the system cannot release it", async () => {
    const db = testDb();
    const list = readFixture("ashby-linear.json") as { jobs: Record<string, unknown>[] };
    const withPolicy = list.jobs.map((j) => (j.title === "Product Engineer" ? { ...j, descriptionPlain: `${j.descriptionPlain}\nAI Policy for Applicants: please do not use AI tools to write your application answers.` } : j));
    await discover(db, [COMPANIES[2]!], fixtureFetcher({ "job-board/linear": { status: 200, json: { jobs: withPolicy } } }), cfg);
    const r = db.prepare("SELECT id, state, ai_policy_text FROM postings WHERE title = 'Product Engineer'").get() as { id: number; state: string; ai_policy_text: string };
    expect(r.state).toBe("NEEDS_ATTENTION");
    expect(r.ai_policy_text).toMatch(/do not use AI/);
    // Re-running discovery or re-evaluation never auto-resolves it.
    await discover(db, [COMPANIES[2]!], fixtureFetcher({ "job-board/linear": { status: 200, json: { jobs: withPolicy } } }), cfg);
    reevaluate(db, [COMPANIES[2]!], cfg);
    expect((db.prepare("SELECT state FROM postings WHERE id = ?").get(r.id) as { state: string }).state).toBe("NEEDS_ATTENTION");
  });

  it("Greenhouse detail adds structured pay and application questions", async () => {
    const f = fixtureFetcher();
    const res = await fetchBoard({ name: "Anthropic", ats: "greenhouse", token: "anthropic", priority: "A" }, f, { wantDetail: () => true });
    if (!res.ok) throw new Error("fetch failed");
    const [p] = res.postings;
    expect(p!.structuredPay[0]).toMatchObject({ min: 190000, max: 230000, currency: "USD", interval: "year" });
    expect(p!.questions?.some((q) => /AI Policy/i.test(q.label))).toBe(true);
    const vercel = await fetchBoard(COMPANIES[0]!, f, { wantDetail: () => true });
    if (!vercel.ok) throw new Error("fetch failed");
    expect(vercel.postings.find((x) => x.title === "Software Engineer, Backend")!.questions?.some((q) => /resume/i.test(q.label))).toBe(true);
  });

  it("skips the Greenhouse detail request for non-engineering titles", async () => {
    const db = testDb();
    const f = fixtureFetcher();
    await discover(db, [{ name: "Anthropic", ats: "greenhouse", token: "anthropic", priority: "A" }], f, cfg);
    expect(f.calls.filter((u) => /jobs\/\d+/.test(u))).toHaveLength(0);
    expect((db.prepare("SELECT state FROM postings").get() as { state: string }).state).toBe("INELIGIBLE");
  });

  it("reevaluate() re-runs rules offline after a config change", async () => {
    const db = testDb();
    await discover(db, [COMPANIES[0]!], fixtureFetcher(), cfg);
    const strict = { ...cfg, compensation: { ...cfg.compensation, min_base_usd: 900000 } };
    const out = reevaluate(db, [COMPANIES[0]!], strict);
    expect(out.reevaluated).toBeGreaterThan(0);
    expect(rows(db).filter((r) => r.state === "QUALIFIED")).toHaveLength(0);
  });
});

describe.runIf(process.env.CAS_LIVE_SMOKE === "1")("live smoke test (read-only)", () => {
  it("reads one real board from each ATS", async () => {
    const f = politeFetcher({ minIntervalMs: 500 });
    for (const c of [
      { name: "Vercel", ats: "greenhouse", token: "vercel", priority: "A" },
      { name: "Palantir", ats: "lever", token: "palantir", priority: "A" },
      { name: "Linear", ats: "ashby", token: "linear", priority: "A" },
    ] as CompanyConfig[]) {
      const r = await fetchBoard(c, f);
      expect(r.ok, `${c.name} board`).toBe(true);
      if (r.ok) expect(r.postings.length).toBeGreaterThan(0);
    }
  }, 60000);
});
