import { createServer, request, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, DecisionError, reject, release, resolveUncertain, type DecisionContext } from "../../src/apply/decide.js";
import { buildPlan } from "../../src/apply/plan.js";
import { assistedSubmit, AuthorizationError, authorize } from "../../src/apply/submit.js";
import type { ResumeDraft } from "../../src/drafting/schemas.js";
import { renderResume } from "../../src/drafting/render.js";
import type { Claim } from "../../src/evidence/claims.js";
import { sha256 } from "../../src/pipeline/dedupe.js";
import { weeklyReport } from "../../src/run/report.js";
import { startServer } from "../../src/ui/server.js";
import { loadTechTerms } from "../../src/validate/claims-validator.js";
import { loadBannedConfig } from "../../src/validate/linter.js";
import { testDb } from "../helpers.js";

const profile = { name: "Jordan Lee", location: "Bethesda, MD", email: "aj@example.com", phone: "(000) 000-0000", linkedin: "https://linkedin.com/in/aj", github: "https://github.com/aj" };
const answers = {
  sponsorship: { question: "", answer: "No", status: "USER_CONFIRMED" },
  hybrid_onsite: { question: "", answer: "Yes, within the Washington, DC metro area.", status: "USER_CONFIRMED" },
  desired_salary_text: { question: "", answer: "150k", status: "PENDING" },
  location: { question: "", answer: "Bethesda, MD", status: "USER_CONFIRMED" },
} as never;
const claims: Claim[] = [
  { id: "cas", claim_text: "Specified and directed a TypeScript pipeline that narrowed 6,341 postings to 239.", evidence: "", source_location: "", status: "VERIFIED", dates: "2026-10-present", permitted_use: ["resume"] },
  { id: "role", claim_text: "Founder and engineer, Example Labs LLC, 2023 to present.", evidence: "", source_location: "", status: "USER_CONFIRMED", dates: "2023-present", permitted_use: ["resume"] },
];
const ctx = (): DecisionContext => ({ claims, banned: loadBannedConfig(), techTerms: loadTechTerms(), profile, answers, claimsFile: path.join(__dirname, "../../career-evidence/approved-claims.yaml") });
const draft: ResumeDraft = {
  summary: [{ text: "Engineer who directs coding agents.", kind: "fact", claim_ids: ["cas"] }],
  experience: [{ heading: "Founder and Engineer | Example Labs LLC | 2023 – Present", heading_claim_ids: ["role"], bullets: [{ text: "Directed a TypeScript pipeline that narrowed 6,341 postings to 239", kind: "fact", claim_ids: ["cas"] }] }],
  projects: [],
  skills: { text: "TypeScript", kind: "fact", claim_ids: ["cas"] },
};
const questions = [
  { label: "First Name", required: true, fieldTypes: ["input_text"] },
  { label: "Last Name", required: true, fieldTypes: ["input_text"] },
  { label: "Email", required: true, fieldTypes: ["input_text"] },
  { label: "Resume/CV", required: true, fieldTypes: ["input_file"] },
  { label: "Will you now or in the future require visa sponsorship?", required: true, fieldTypes: ["multi_value_single_select"], options: ["Yes", "No"] },
  { label: "Why Acme?", required: true, fieldTypes: ["textarea"] },
  { label: "Gender", required: false, fieldTypes: ["multi_value_single_select"], options: ["Male", "Female", "Decline"] },
  { label: "I agree to the arbitration agreement", required: true, fieldTypes: ["input_checkbox"] },
];

function seed(db: ReturnType<typeof testDb>, state = "READY_FOR_REVIEW", title = "AI Engineer") {
  db.prepare("INSERT OR IGNORE INTO companies (id, name, ats, token) VALUES (1, 'Acme','greenhouse','acme')").run();
  const r = db
    .prepare(
      "INSERT INTO postings (company_id, ats, ats_job_id, company_name, title, url, description_text, content_hash, dedupe_hash, state, first_seen_at, last_seen_at, retrieved_at, questions_json) VALUES (1,'greenhouse',?, 'Acme', ?, 'https://example.com/j', 'Build agents. Thank you for your interest in Acme.', 'h', ?, ?, 'n','n','n', ?)",
    )
    .run(String(Math.random()), title, sha256(title + Math.random()), state, JSON.stringify(questions));
  const id = Number(r.lastInsertRowid);
  const content = JSON.stringify(draft);
  db.prepare("INSERT INTO materials (posting_id, kind, version, content_json, rendered_md, content_hash, status, validation_json) VALUES (?, 'resume', 1, ?, ?, ?, 'validated', '{}')").run(id, content, renderResume(draft, profile, claims), sha256(content));
  return id;
}

describe("application plan", () => {
  it("never answers EEO questions and never fills declarations", () => {
    const plan = buildPlan(questions, profile, answers);
    expect(plan.items.find((i) => i.label === "Gender")?.source).toBe("eeo_manual");
    expect(plan.declarations.map((d) => d.label)).toEqual(["I agree to the arbitration agreement"]);
    expect(plan.items.filter((i) => i.source === "eeo_manual" || i.source === "attestation").every((i) => !i.value)).toBe(true);
  });
  it("maps exact-option standard answers and routes free text to the user", () => {
    const plan = buildPlan(questions, profile, answers);
    expect(plan.items.find((i) => i.label.startsWith("Will you now"))?.value).toBe("No");
    expect(plan.needsUser.map((q) => q.label)).toEqual(["Why Acme?"]);
  });
  it("never shortens a conditional answer to fit a Yes/No field", () => {
    const plan = buildPlan([{ label: "Are you open to working in-person in one of our offices 25% of the time?", required: true, fieldTypes: ["select"], options: ["Yes", "No"] }], profile, answers);
    expect(plan.needsUser).toHaveLength(1);
    expect(plan.items[0]!.reason).toMatch(/does not match the form's options/);
  });
  it("maps clearance questions to the approved 'No'", () => {
    const a = { ...(answers as object), active_clearance: { question: "", answer: "No", status: "USER_CONFIRMED" } } as never;
    const plan = buildPlan([{ label: "Do you have a security clearance?", required: true, fieldTypes: ["select"], options: ["Yes", "No"] }], profile, a);
    expect(plan.items[0]).toMatchObject({ source: "standard", value: "No" });
  });
  it("PENDING standard answers are not used", () => {
    const plan = buildPlan([{ label: "What are your salary expectations?", required: true, fieldTypes: ["input_text"] }], profile, answers);
    expect(plan.needsUser).toHaveLength(1);
  });
});

describe("decisions", () => {
  it("approval requires answers to required questions and binds to the material hash", () => {
    const db = testDb();
    const id = seed(db);
    expect(() => approve(db, id, ctx(), {})).toThrow(/Why Acme/);
    const did = approve(db, id, ctx(), { "Why Acme?": "I build agents." });
    const d = db.prepare("SELECT material_hash, answers_json FROM decisions WHERE id = ?").get(did) as { material_hash: string; answers_json: string };
    expect(d.material_hash).toBe(sha256(JSON.stringify(draft)));
    expect(JSON.parse(d.answers_json)).toEqual({ "Why Acme?": "I build agents." });
    expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "APPROVED" });
  });
  it("approval is refused if the draft no longer validates against current claims", () => {
    const db = testDb();
    const id = seed(db);
    const changed = { ...ctx(), claims: claims.map((c) => (c.id === "cas" ? { ...c, status: "UNVERIFIED" as const } : c)) };
    expect(() => approve(db, id, changed, { "Why Acme?": "x" })).toThrow(/no longer validates/);
  });
  it("releasing a hold requires a recorded reason and is user-only", () => {
    const db = testDb();
    const id = seed(db, "NEEDS_ATTENTION");
    expect(() => release(db, id, "")).toThrow(DecisionError);
    release(db, id, "Proceeding; I will write the free-text answers myself.");
    expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "QUALIFIED" });
    expect(db.prepare("SELECT actor FROM events WHERE posting_id = ? ORDER BY id DESC LIMIT 1").get(id)).toEqual({ actor: "user" });
  });
  it("USER_REJECTED is distinct from employer REJECTED", () => {
    const db = testDb();
    const id = seed(db);
    reject(db, id);
    expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "USER_REJECTED" });
  });
});

// ---------- assisted submission against a local fixture form ----------
let fixture: Server;
let base = "";
let posts = 0;
const FORM = `<!doctype html><html><body><h1>AI Engineer</h1><p>Build agents. Thank you for your interest in Acme.</p>
<form method="post" action="/submit" enctype="multipart/form-data">
<label for="fn">First Name</label><input id="fn" name="fn" required>
<label for="ln">Last Name</label><input id="ln" name="ln" required>
<label for="em">Email</label><input id="em" name="em" type="email" required>
<label for="cv-btn">Resume/CV</label><button type="button" id="cv-btn">Attach</button><input id="resume" name="resume" type="file" style="opacity:0;width:1px">
<label for="sp">Will you now or in the future require visa sponsorship?</label><select id="sp" name="sp"><option value=""></option><option>Yes</option><option>No</option></select>
<label for="why">Why Acme?</label><textarea id="why" name="why"></textarea>
<label for="g">Gender</label><select id="g" name="g"><option value=""></option><option>Male</option><option>Female</option><option>Decline</option></select>
<label for="arb">I agree to the arbitration agreement</label><input id="arb" name="arb" type="checkbox">
<button id="submit" type="submit">Submit application</button></form></body></html>`;

beforeAll(async () => {
  fixture = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/submit") {
      posts++;
      req.resume();
      req.on("end", () => {
        res.writeHead(303, { Location: "/confirmation" });
        res.end();
      });
      return;
    }
    if (req.url === "/confirmation") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html><body><h1>Thank you for applying!</h1><p>Your application has been submitted.</p></body></html>");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(FORM);
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});
afterAll(() => fixture.close());

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cas-test-"));

describe("assisted submission (local fixture; never a real employer)", () => {
  it("refuses without approval: the authorization gate", () => {
    const db = testDb();
    const id = seed(db);
    expect(() => authorize(db, id, ctx())).toThrow(AuthorizationError);
  });

  it("fills approved fields, never clicks submit or touches EEO/declarations, and records SUBMITTED only after confirmation", async () => {
    const db = testDb();
    const id = seed(db);
    approve(db, id, ctx(), { "Why Acme?": "I build agents." });
    posts = 0;
    const result = await assistedSubmit(db, id, ctx(), {
      headless: true,
      profileDir: tmp(),
      evidenceDir: tmp(),
      materialsDir: tmp(),
      applyUrlOverride: base,
      pollMs: 100,
      timeoutMs: 15000,
      onReady: async (page, fill) => {
        expect(posts).toBe(0); // the system never submitted
        expect(await page.locator("#fn").inputValue()).toBe("Jordan");
        expect(await page.locator("#sp").inputValue()).toBe("No");
        expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(1); // regression: label pointed at a button
        expect(await page.locator("#why").inputValue()).toBe("I build agents.");
        expect(await page.locator("#g").inputValue()).toBe(""); // EEO untouched
        expect(await page.locator("#arb").isChecked()).toBe(false); // declaration untouched
        expect(fill.resumeUploaded).toBe(true);
        expect(fill.leftForUser.map((l) => l.label)).toEqual(expect.arrayContaining(["Gender", "I agree to the arbitration agreement"]));
        // The banner lists what is left; it never touches form fields.
        expect(await page.locator("[data-cas-banner]").innerText()).toMatch(/Gender|arbitration/);
        // Simulate the user reviewing the form and clicking submit.
        await page.locator("#arb").check();
        await page.locator("#submit").click();
      },
    });
    expect(result.status).toBe("submitted");
    expect(result.evidence?.text).toMatch(/Thank you for applying|submitted/);
    expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "SUBMITTED" });
    expect(db.prepare("SELECT status FROM submissions WHERE posting_id = ?").get(id)).toEqual({ status: "submitted" });
  }, 60000);

  it("pre-existing 'thank you' text on the form page does not count as confirmation; closing the window -> SUBMISSION_UNCERTAIN, never retried", async () => {
    const db = testDb();
    const id = seed(db);
    approve(db, id, ctx(), { "Why Acme?": "x" });
    const result = await assistedSubmit(db, id, ctx(), {
      headless: true,
      profileDir: tmp(),
      evidenceDir: tmp(),
      materialsDir: tmp(),
      applyUrlOverride: base,
      pollMs: 100,
      timeoutMs: 15000,
      onReady: async (page) => {
        await new Promise((r) => setTimeout(r, 400)); // let polling see the original page
        await page.close(); // user closes without submitting
      },
    });
    expect(result.status).toBe("uncertain");
    expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "SUBMISSION_UNCERTAIN" });
    // A second attempt is blocked: no automatic retry from SUBMISSION_UNCERTAIN.
    expect(() => authorize(db, id, ctx())).toThrow(AuthorizationError);
    // The user resolves it with evidence.
    resolveUncertain(db, id, "submitted", "Email from Acme: we received your application.");
    expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "SUBMITTED" });
  }, 60000);

  it("the idempotency key blocks a second application to the same role", async () => {
    const db = testDb();
    const id = seed(db);
    approve(db, id, ctx(), { "Why Acme?": "x" });
    const dedupe = (db.prepare("SELECT dedupe_hash FROM postings WHERE id = ?").get(id) as { dedupe_hash: string }).dedupe_hash;
    const did = (db.prepare("SELECT id FROM decisions WHERE posting_id = ? AND decision = 'approve'").get(id) as { id: number }).id;
    db.prepare("INSERT INTO submissions (posting_id, decision_id, idempotency_key, material_hash, status) VALUES (?, ?, ?, 'x', 'submitted')").run(id, did, dedupe);
    expect(() => authorize(db, id, ctx())).toThrow(/idempotency/);
  });
});

describe("approval UI security", () => {
  it("rejects wrong Host, missing CSRF token, and cross-origin posts; escapes posting text", async () => {
    const db = testDb();
    const id = seed(db, "READY_FOR_REVIEW", `<script>alert(1)</script> Engineer`);
    const { server, token } = startServer({ db, ctx }, 0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    // startServer allows only its configured port; tests use the real bound port via Host header.
    server.close();
    const s2 = startServer({ db, ctx }, port);
    await new Promise((r) => s2.server.once("listening", r));
    const url = `http://127.0.0.1:${port}`;
    try {
      // fetch() ignores custom Host headers; use a raw request to simulate DNS rebinding.
      const badStatus = await new Promise<number>((resolve, rej) => {
        const r = request({ host: "127.0.0.1", port, path: "/", headers: { Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", rej);
        r.end();
      });
      expect(badStatus).toBe(421);
      const q = await fetch(url);
      const html = await q.text();
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(q.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
      const noToken = await fetch(`${url}/p/${id}/reject`, { method: "POST", body: new URLSearchParams({}), redirect: "manual" });
      expect(noToken.status).toBe(403);
      const cross = await fetch(`${url}/p/${id}/reject`, { method: "POST", body: new URLSearchParams({ csrf: s2.token }), headers: { Origin: "https://evil.example" }, redirect: "manual" });
      expect(cross.status).toBe(403);
      const ok = await fetch(`${url}/p/${id}/reject`, { method: "POST", body: new URLSearchParams({ csrf: s2.token }), redirect: "manual" });
      expect(ok.status).toBe(303);
      expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "USER_REJECTED" });
      void token;
    } finally {
      s2.server.close();
    }
  });
});

describe("submit route (regression: incident 2026-11-13)", () => {
  it("shows an authorization refusal on the page and starts nothing", async () => {
    const db = testDb();
    const id = seed(db);
    approve(db, id, ctx(), { "Why Acme?": "x" });
    // Refusal cause: a submission already exists for this role (idempotency key).
    const dedupe = (db.prepare("SELECT dedupe_hash FROM postings WHERE id = ?").get(id) as { dedupe_hash: string }).dedupe_hash;
    const did = (db.prepare("SELECT id FROM decisions WHERE posting_id = ? AND decision = 'approve'").get(id) as { id: number }).id;
    db.prepare("INSERT INTO submissions (posting_id, decision_id, idempotency_key, material_hash, status) VALUES (?, ?, ?, 'x', 'submitted')").run(id, did, dedupe);
    const probe = startServer({ db, ctx }, 0);
    await new Promise((r) => probe.server.once("listening", r));
    const port = (probe.server.address() as AddressInfo).port;
    probe.server.close();
    const s = startServer({ db, ctx }, port);
    await new Promise((r) => s.server.once("listening", r));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/p/${id}/submit`, { method: "POST", body: new URLSearchParams({ csrf: s.token }), redirect: "manual" });
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(/already submitted for this role/);
      expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "APPROVED" });
      expect(db.prepare("SELECT count(*) n FROM submissions WHERE posting_id = ?").get(id)).toEqual({ n: 1 });
    } finally {
      s.server.close();
    }
  });
});

describe("approval UI in a real browser (regression: incident 2026-10-22)", () => {
  it("approving through the actual form works: the browser's Origin header is accepted", async () => {
    const { chromium } = await import("playwright");
    const db = testDb();
    const id = seed(db);
    const probe = startServer({ db, ctx }, 0);
    await new Promise((r) => probe.server.once("listening", r));
    const port = (probe.server.address() as AddressInfo).port;
    probe.server.close();
    const s = startServer({ db, ctx }, port);
    await new Promise((r) => s.server.once("listening", r));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/p/${id}`);
      await page.locator("textarea[name=a0]").fill("I build agents.");
      await page.getByRole("button", { name: "Approve" }).click();
      await page.waitForLoadState("load");
      expect(await page.locator("body").innerText()).not.toMatch(/cross-origin request refused/);
      expect(db.prepare("SELECT state FROM postings WHERE id = ?").get(id)).toEqual({ state: "APPROVED" });
    } finally {
      await browser.close();
      s.server.close();
    }
  }, 60000);
});

describe("weekly report", () => {
  it("has every required section and leads with recalibration after the tripwire date", () => {
    const db = testDb();
    seed(db);
    const r = weeklyReport(db, new Date("2026-12-13T12:00:00Z"), { tripwireDate: "2026-12-13", interviewThreshold: 2 });
    for (const h of ["## Funnel", "## Three submissions to review", "## Contract lane", "## Model cost", "## Time in the approval queue", "## Recommendations"]) expect(r).toContain(h);
    expect(r.split("\n").slice(0, 4).join("\n")).toMatch(/Recalibration recommended/);
    expect(weeklyReport(db, new Date("2026-11-01T12:00:00Z"), { interviewThreshold: 2 })).not.toMatch(/Recalibration/);
  });
});
