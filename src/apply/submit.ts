import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { PROJECT_ROOT } from "../config/env.js";
import type { DB } from "../db/index.js";
import { log } from "../log.js";
import { recordEvent, transition, type State } from "../pipeline/states.js";
import { claimsHash, latestValidated, planFor, revalidate, type DecisionContext } from "./decide.js";
import { renderPdf } from "./pdf.js";
import type { PlanItem } from "./plan.js";

export class AuthorizationError extends Error {}

// "Thank you for your interest" is deliberately absent: job descriptions often end with it.
const CONFIRMATION = /thank you for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|your application is (complete|in)/i;

export interface SubmitOptions {
  headless?: boolean;
  profileDir?: string;
  /** How long to wait for the user to press submit before declaring the result uncertain. */
  timeoutMs?: number;
  /** Tests only: point at a local fixture form instead of the real employer page. */
  applyUrlOverride?: string;
  evidenceDir?: string;
  materialsDir?: string;
  pollMs?: number;
  /** Called once fields are filled and the browser is waiting for the user. */
  onReady?: (page: Page, filled: FillReport) => void | Promise<void>;
}

export interface FillReport {
  filled: string[];
  leftForUser: { label: string; reason: string }[];
  resumeUploaded: boolean;
}

export interface SubmitResult {
  status: "submitted" | "uncertain";
  submissionId: number;
  evidence?: { url: string; text: string; screenshot: string };
  fill: FillReport;
}

/**
 * The single authorization gate for submission. External content can never reach here:
 * only an explicit user approval of the exact current material version unlocks it.
 */
export function authorize(db: DB, postingId: number, ctx: DecisionContext) {
  const p = db.prepare("SELECT state, description_text, dedupe_hash, ats, ats_job_id, url, apply_url, company_id FROM postings WHERE id = ?").get(postingId) as
    | { state: State; description_text: string; dedupe_hash: string; ats: string; ats_job_id: string; url: string; apply_url: string | null; company_id: number }
    | undefined;
  if (!p) throw new AuthorizationError("posting not found");
  if (p.state !== "APPROVED") throw new AuthorizationError(`posting is ${p.state}, not APPROVED`);
  const d = db.prepare("SELECT id, material_hash, claims_hash, answers_json FROM decisions WHERE posting_id = ? AND decision = 'approve' ORDER BY id DESC LIMIT 1").get(postingId) as
    | { id: number; material_hash: string; claims_hash: string; answers_json: string | null }
    | undefined;
  if (!d) throw new AuthorizationError("no approval decision on record");
  const m = latestValidated(db, postingId);
  if (!m || m.content_hash !== d.material_hash) throw new AuthorizationError("materials changed after approval; approve again");
  if (claimsHash(ctx.claimsFile) !== d.claims_hash) {
    const check = revalidate(m, ctx, p.description_text);
    if (check.claimIssues.length || check.lint.length) throw new AuthorizationError("claims changed after approval and the draft no longer validates; revise and approve again");
  }
  const answers = d.answers_json ? (JSON.parse(d.answers_json) as Record<string, string>) : {};
  const plan = planFor(db, postingId, ctx, answers);
  if (plan.needsUser.length) throw new AuthorizationError(`unanswered required questions: ${plan.needsUser.map((q) => q.label).join(" | ")}`);
  const prior = db.prepare("SELECT status FROM submissions WHERE idempotency_key = ?").get(p.dedupe_hash) as { status: string } | undefined;
  if (prior) throw new AuthorizationError(`already ${prior.status} for this role (idempotency key)`);
  const company = db.prepare("SELECT token FROM companies WHERE id = ?").get(p.company_id) as { token: string };
  return { posting: p, decisionId: d.id, material: m, plan, companyToken: company.token };
}

export function applyUrl(ats: string, token: string, jobId: string, fallback: string): string {
  // Canonical hosted form: employer career sites often wrap Greenhouse in an iframe.
  if (ats === "greenhouse") return `https://job-boards.greenhouse.io/${token}/jobs/${jobId}`;
  return fallback;
}

async function findField(page: Page, label: string): Promise<Locator | null> {
  const clean = label.replace(/\s*\*$/, "").trim();
  for (const loc of [page.getByLabel(clean, { exact: true }), page.getByLabel(clean)]) {
    if ((await loc.count()) > 0) return loc.first();
  }
  return null;
}

async function fillItem(page: Page, item: PlanItem): Promise<string | null> {
  const field = await findField(page, item.label);
  if (!field) return "field not found on page";
  const v = item.value ?? "";
  try {
    const tag = await field.evaluate((el) => el.tagName.toLowerCase());
    const role = await field.getAttribute("role");
    if (tag === "select") {
      const labels = await field.locator("option").allInnerTexts();
      const match = labels.find((l) => l.trim() === v.trim()) ?? labels.find((l) => l.trim().toLowerCase() === v.trim().toLowerCase());
      if (!match) return `no option matching "${v}"`;
      await field.selectOption({ label: match });
    } else if (role === "combobox") {
      await field.click();
      await field.fill(v);
      // Exact match first, then the same text ignoring case ("yes" -> "Yes"). Never a partial match.
      let option = page.getByRole("option", { name: v, exact: true });
      if ((await option.count()) === 0) option = page.getByRole("option", { name: new RegExp(`^\\s*${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") });
      if ((await option.count()) === 0) return `no option matching "${v}"`;
      await option.first().click();
    } else if (tag === "input" || tag === "textarea") {
      const type = (await field.getAttribute("type")) ?? "text";
      if (["checkbox", "radio", "file", "submit", "button"].includes(type)) return `field type ${type} left for you`;
      await field.fill(v);
    } else return `unsupported field (${tag})`;
    return null;
  } catch (e) {
    return `could not fill: ${(e as Error).message.split("\n")[0]}`;
  }
}

async function fillForm(page: Page, plan: ReturnType<typeof authorize>["plan"], pdfPath: string): Promise<FillReport> {
  const report: FillReport = { filled: [], leftForUser: [], resumeUploaded: false };
  for (const item of plan.items) {
    if (item.source === "eeo_manual" || item.source === "attestation" || item.source === "skip_optional") {
      if (item.source !== "skip_optional") report.leftForUser.push({ label: item.label, reason: item.reason ?? item.source });
      continue;
    }
    if (item.source === "resume_file") {
      // The label often belongs to an "Attach" button, not the file input (incident 2026-10-22).
      // Prefer a real file input: the one the label points to, then one near "resume", then the first.
      const candidates = [
        page.locator(`input[type="file"][id*="resume" i], input[type="file"][name*="resume" i]`),
        page.locator('input[type="file"]'),
      ];
      let done = false;
      for (const c of candidates) {
        if ((await c.count()) === 0) continue;
        try {
          await c.first().setInputFiles(pdfPath);
          done = true;
          break;
        } catch {
          // try the next candidate
        }
      }
      if (done) {
        report.resumeUploaded = true;
        report.filled.push(item.label);
      } else report.leftForUser.push({ label: item.label, reason: "could not find a file input for the resume; attach it yourself" });
      continue;
    }
    if (!item.value) continue;
    const problem = await fillItem(page, item);
    if (problem) report.leftForUser.push({ label: item.label, reason: problem });
    else report.filled.push(item.label);
  }
  if (!plan.known) {
    // No question list (Lever/Ashby): fill only the basics we can find by label; the user completes the rest.
    report.leftForUser.push({ label: "(all other questions)", reason: "this job board does not publish its questions; complete them in the browser" });
    const upload = page.locator('input[type="file"]').first();
    if ((await upload.count()) > 0) {
      await upload.setInputFiles(pdfPath).then(() => (report.resumeUploaded = true)).catch(() => undefined);
    }
  }
  return report;
}

async function showBanner(page: Page, fill: FillReport, pdfPath: string) {
  const items = [
    ...(fill.resumeUploaded ? [] : [{ label: "RESUME NOT ATTACHED", reason: `attach ${pdfPath} before you submit` }]),
    ...fill.leftForUser.filter((l) => !/resume|cv/i.test(l.label) || fill.resumeUploaded),
  ];
  if (!items.length) return;
  await page.evaluate(
    ({ items, ok }) => {
      const box = document.createElement("div");
      box.setAttribute("data-cas-banner", "1");
      box.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${ok ? "#fef3c7" : "#fee2e2"};color:#111;font:14px/1.4 -apple-system,sans-serif;padding:10px 14px;border-bottom:2px solid #b45309;max-height:40vh;overflow:auto`;
      const h = document.createElement("b");
      h.textContent = "CAS: complete these before you submit";
      box.appendChild(h);
      const ul = document.createElement("ul");
      ul.style.margin = "6px 0 0 18px";
      for (const i of items) {
        const li = document.createElement("li");
        li.textContent = `${i.label}: ${i.reason}`;
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Hide";
      close.style.cssText = "position:absolute;top:8px;right:12px";
      close.onclick = () => box.remove();
      box.appendChild(close);
      document.body.appendChild(box);
    },
    { items, ok: fill.resumeUploaded },
  );
}

interface Baseline {
  url: string;
  hadConfirmationText: boolean;
}

/**
 * Confirmation requires a change after the form was filled: a new URL, or the form gone, plus
 * confirmation wording that was not already on the page. Pre-existing text never counts.
 */
async function confirmation(context: BrowserContext, base: Baseline): Promise<{ page: Page; text: string } | null> {
  for (const page of context.pages()) {
    try {
      const text = await page.locator("body").innerText({ timeout: 1000 });
      const m = text.match(CONFIRMATION);
      const urlChanged = page.url() !== base.url;
      const formGone = (await page.locator('input[type="file"], form input[type="email"]').count()) === 0;
      const urlSaysDone = /\/confirmation|thank[-_]?you|application[-_]submitted/i.test(page.url());
      if ((urlChanged && (m || urlSaysDone)) || (m && !base.hadConfirmationText && formGone)) return { page, text: (m?.[0] ?? page.url()).slice(0, 300) };
    } catch {
      // page navigating or closed
    }
  }
  return null;
}

/**
 * Opens the employer's form in a visible browser, fills approved fields, uploads the resume, and
 * stops. The user reviews and clicks submit. The result is SUBMITTED only with confirmation evidence;
 * otherwise SUBMISSION_UNCERTAIN. Never clicks submit, never answers EEO, never retries.
 */
export async function assistedSubmit(db: DB, postingId: number, ctx: DecisionContext, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const auth = authorize(db, postingId, ctx);
  const evidenceDir = opts.evidenceDir ?? path.join(PROJECT_ROOT, "data", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const pdfPath = await renderPdf(auth.material.rendered_md, path.join(opts.materialsDir ?? path.join(PROJECT_ROOT, "data", "materials"), `posting-${postingId}-resume-v${auth.material.version}.pdf`));

  const submissionId = db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO submissions (posting_id, decision_id, idempotency_key, material_hash, status) VALUES (?, ?, ?, ?, 'started')")
        .run(postingId, auth.decisionId, auth.posting.dedupe_hash, auth.material.content_hash).lastInsertRowid,
    );
    transition(db, postingId, "SUBMITTING", "system", { submissionId: id });
    return id;
  })();

  const url = opts.applyUrlOverride ?? applyUrl(auth.posting.ats, auth.companyToken, auth.posting.ats_job_id, auth.posting.apply_url ?? auth.posting.url);
  let context: BrowserContext | null = null;
  let fill: FillReport = { filled: [], leftForUser: [], resumeUploaded: false };
  let result: SubmitResult["status"] = "uncertain";
  let evidence: SubmitResult["evidence"];
  try {
    context = await chromium.launchPersistentContext(opts.profileDir ?? path.join(PROJECT_ROOT, "data", "browser-profile"), { headless: opts.headless ?? false, viewport: null });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const baseline: Baseline = { url: page.url(), hadConfirmationText: CONFIRMATION.test(await page.locator("body").innerText().catch(() => "")) };
    fill = await fillForm(page, auth.plan, pdfPath);
    db.prepare("UPDATE submissions SET filled_json = ? WHERE id = ?").run(JSON.stringify({ ...fill, pdfPath }), submissionId);
    // Show what CAS did not fill directly on the form (incident 2026-10-22: a resume upload failed
    // silently and the employer's form accepted the application without it). Display only; no form field is touched.
    await showBanner(page, fill, pdfPath).catch(() => undefined);
    recordEvent(db, { postingId, kind: "form_filled", actor: "system", detail: { url, ...fill } });
    await opts.onReady?.(page, fill);

    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
    const poll = opts.pollMs ?? 2000;
    let closed = false;
    context.on("close", () => (closed = true));
    while (Date.now() < deadline && !closed) {
      const c = await confirmation(context, baseline);
      if (c) {
        const shot = path.join(evidenceDir, `posting-${postingId}-confirmation.png`);
        await c.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        evidence = { url: c.page.url(), text: c.text, screenshot: shot };
        result = "submitted";
        break;
      }
      if (context.pages().length === 0) break; // user closed the window without a confirmation
      await new Promise((r) => setTimeout(r, poll));
    }
  } catch (e) {
    log.warn({ postingId, err: (e as Error).message.slice(0, 200) }, "assisted submission interrupted");
    recordEvent(db, { postingId, kind: "submission_error", actor: "system", detail: { error: (e as Error).message.slice(0, 500) } });
  } finally {
    await context?.close().catch(() => undefined);
  }

  db.transaction(() => {
    db.prepare("UPDATE submissions SET status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), confirmation_json = ?, evidence_path = ? WHERE id = ?").run(
      result,
      evidence ? JSON.stringify({ method: "confirmation_page", url: evidence.url, text: evidence.text }) : null,
      evidence?.screenshot ?? null,
      submissionId,
    );
    transition(db, postingId, result === "submitted" ? "SUBMITTED" : "SUBMISSION_UNCERTAIN", "system", evidence ? { evidence } : { reason: "no confirmation detected" });
  })();
  return { status: result, submissionId, evidence, fill };
}
