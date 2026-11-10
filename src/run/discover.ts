import type { DB } from "../db/index.js";
import type { EligibilityConfig } from "../config/files.js";
import { fetchBoard, splitLocations } from "../discovery/adapters.js";
import type { CompanyConfig, Fetcher, NormalizedPosting } from "../discovery/types.js";
import { classifyRole } from "../eligibility/classifiers.js";
import { evaluateEligibility, type EligibilityResult } from "../eligibility/rules.js";
import { log } from "../log.js";
import { dedupeHash, sha256 } from "../pipeline/dedupe.js";
import { PRE_SUBMISSION, recordEvent, transition, type State } from "../pipeline/states.js";

export interface DiscoverStats {
  companies: number;
  boardFailures: { company: string; status: number; error: string }[];
  listed: number;
  newPostings: number;
  changed: number;
  unchanged: number;
  closed: number;
  qualified: number;
  ineligible: number;
  needsAttention: number;
  duplicates: number;
  detailFailures: number;
}

export interface DiscoverOptions {
  now?: () => Date;
  /** Fetch Greenhouse per-job details (pay, questions). Default true. */
  greenhouseDetail?: boolean;
}

const NON_US_ONLY = /^(?!.*\b(remote|us|usa|united states|americas)\b).*\b(london|dublin|toronto|bangalore|bengaluru|singapore|tokyo|sydney|berlin|paris|amsterdam|zurich|munich|tel aviv|seoul|india|germany|japan|uk|united kingdom|canada|australia|ireland|france|netherlands|brazil|mexico)\b/i;

export async function discover(db: DB, companies: CompanyConfig[], fetcher: Fetcher, cfg: EligibilityConfig, opts: DiscoverOptions = {}): Promise<DiscoverStats> {
  const now = opts.now ?? (() => new Date());
  const stats: DiscoverStats = { companies: companies.length, boardFailures: [], listed: 0, newPostings: 0, changed: 0, unchanged: 0, closed: 0, qualified: 0, ineligible: 0, needsAttention: 0, duplicates: 0, detailFailures: 0 };

  for (const c of companies) {
    const companyId = upsertCompany(db, c);
    const runStart = now().toISOString();
    // Only fetch Greenhouse detail for engineering titles not clearly located outside the US.
    const wantDetail = opts.greenhouseDetail === false ? undefined : (title: string, loc: string) => classifyRole(title, cfg.roles).ok && !splitLocations(loc).every((l) => NON_US_ONLY.test(l));
    const res = await fetchBoard(c, fetcher, { wantDetail });
    if (!res.ok) {
      stats.boardFailures.push({ company: c.name, status: res.status, error: res.error });
      db.prepare("UPDATE companies SET last_fetch_at = ?, last_fetch_status = ?, last_error = ? WHERE id = ?").run(runStart, res.status === 404 ? "not_found" : "error", res.error, companyId);
      recordEvent(db, { kind: "board_fetch_failed", actor: "system", detail: { company: c.name, ats: c.ats, token: c.token, status: res.status, error: res.error } });
      log.warn({ company: c.name, status: res.status }, "board fetch failed");
      continue;
    }
    stats.listed += res.listed;
    stats.detailFailures += res.detailFailures;

    for (const p of res.postings) {
      try {
        const outcome = processPosting(db, companyId, c, p, cfg, now());
        stats[outcome.kind]++;
        if (outcome.state === "QUALIFIED") stats.qualified++;
        if (outcome.state === "INELIGIBLE") stats.ineligible++;
        if (outcome.state === "NEEDS_ATTENTION") stats.needsAttention++;
        if (outcome.duplicate) stats.duplicates++;
      } catch (e) {
        log.error({ company: c.name, job: p.atsJobId, err: e instanceof Error ? e.message : String(e) }, "posting processing failed");
        recordEvent(db, { kind: "posting_error", actor: "system", detail: { company: c.name, atsJobId: p.atsJobId, error: e instanceof Error ? e.message : String(e) } });
      }
    }

    // Listings missing from a successful full fetch were removed by the employer.
    stats.closed += closeRemoved(db, companyId, runStart);
    db.prepare("UPDATE companies SET last_fetch_at = ?, last_fetch_status = 'ok', last_error = NULL WHERE id = ?").run(runStart, companyId);
  }
  return stats;
}

function upsertCompany(db: DB, c: CompanyConfig): number {
  db.prepare("INSERT INTO companies (name, ats, token, priority) VALUES (?, ?, ?, ?) ON CONFLICT(ats, token) DO UPDATE SET name = excluded.name, priority = excluded.priority, active = 1").run(c.name, c.ats, c.token, c.priority);
  return (db.prepare("SELECT id FROM companies WHERE ats = ? AND token = ?").get(c.ats, c.token) as { id: number }).id;
}

function contentHash(p: NormalizedPosting): string {
  return sha256(JSON.stringify([p.title, p.locationRaw, p.locations, p.workplaceType, p.employmentTypeRaw, p.descriptionText, p.structuredPay, p.questions, p.aiDisclaimer, p.deadline]));
}

/** States in which a changed listing is re-evaluated (nothing has been drafted or sent yet). */
const REEVALUATE_FROM: State[] = ["INELIGIBLE", "QUALIFIED"];

function processPosting(db: DB, companyId: number, c: CompanyConfig, p: NormalizedPosting, cfg: EligibilityConfig, at: Date) {
  const nowIso = at.toISOString();
  const hash = contentHash(p);
  return db.transaction(() => {
    const existing = db.prepare("SELECT id, state, content_hash, closed_at FROM postings WHERE ats = ? AND company_id = ? AND ats_job_id = ?").get(p.ats, companyId, p.atsJobId) as
      | { id: number; state: State; content_hash: string; closed_at: string | null }
      | undefined;

    if (existing) {
      db.prepare("UPDATE postings SET last_seen_at = ?, retrieved_at = ? WHERE id = ?").run(nowIso, nowIso, existing.id);
      if (existing.closed_at) {
        recordEvent(db, { postingId: existing.id, kind: "listing_reappeared", actor: "system" });
        return { kind: "unchanged" as const, state: existing.state, duplicate: false };
      }
      if (existing.content_hash === hash) return { kind: "unchanged" as const, state: existing.state, duplicate: false };
      writeSnapshot(db, existing.id, p, hash, nowIso);
      updatePostingFields(db, existing.id, p, hash);
      recordEvent(db, { postingId: existing.id, kind: "listing_changed", actor: "system" });
      if (!REEVALUATE_FROM.includes(existing.state)) return { kind: "changed" as const, state: existing.state, duplicate: false };
      transition(db, existing.id, "ELIGIBILITY_PENDING", "system", { reason: "listing changed" });
      const r = applyEligibility(db, existing.id, p, c, cfg, at);
      return { kind: "changed" as const, ...r };
    }

    const ins = db
      .prepare(
        `INSERT INTO postings (company_id, ats, ats_job_id, company_name, title, url, apply_url, location_raw, description_text, content_hash, dedupe_hash, state, first_seen_at, last_seen_at, retrieved_at, questions_json, normalized_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, ?, ?, ?, ?)`,
      )
      .run(companyId, p.ats, p.atsJobId, p.companyName, p.title, p.url, p.applyUrl, p.locationRaw, p.descriptionText, hash, dedupeHash(p.companyName, p.title), nowIso, nowIso, nowIso, p.questions ? JSON.stringify(p.questions) : null, normalizedJson(p));
    const id = Number(ins.lastInsertRowid);
    recordEvent(db, { postingId: id, kind: "discovered", to: "DISCOVERED", actor: "system", detail: { url: p.url, source: p.sourceUrl } });
    writeSnapshot(db, id, p, hash, nowIso);
    transition(db, id, "NORMALIZED", "system");
    transition(db, id, "ELIGIBILITY_PENDING", "system");
    const r = applyEligibility(db, id, p, c, cfg, at);
    return { kind: "newPostings" as const, ...r };
  })();
}

function normalizedJson(p: NormalizedPosting): string {
  const { raw: _raw, ...rest } = p;
  return JSON.stringify(rest);
}

function writeSnapshot(db: DB, postingId: number, p: NormalizedPosting, hash: string, at: string) {
  db.prepare("INSERT OR IGNORE INTO posting_snapshots (posting_id, retrieved_at, source_url, content_hash, raw_json) VALUES (?, ?, ?, ?, ?)").run(postingId, at, p.sourceUrl, hash, JSON.stringify(p.raw));
}

function updatePostingFields(db: DB, id: number, p: NormalizedPosting, hash: string) {
  db.prepare(
    "UPDATE postings SET title = ?, url = ?, apply_url = ?, location_raw = ?, description_text = ?, content_hash = ?, dedupe_hash = ?, questions_json = ?, normalized_json = ?, analysis_json = NULL, suitability_score = NULL, suitability_json = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(p.title, p.url, p.applyUrl, p.locationRaw, p.descriptionText, hash, dedupeHash(p.companyName, p.title), p.questions ? JSON.stringify(p.questions) : null, normalizedJson(p), id);
}

function applyEligibility(db: DB, id: number, p: NormalizedPosting, c: CompanyConfig, cfg: EligibilityConfig, at: Date): { state: State; duplicate: boolean } {
  const r: EligibilityResult = evaluateEligibility(p, cfg, c, at);
  db.prepare(
    "UPDATE postings SET eligibility_json = ?, comp_json = ?, location_json = ?, flags_json = ?, employment_type = ?, lane = ?, ai_policy_text = ? WHERE id = ?",
  ).run(JSON.stringify(r), JSON.stringify(r.comp), JSON.stringify(r.location), JSON.stringify(r.flags), r.employment.type, r.lane, r.aiPolicy.text, id);

  if (r.verdict === "INELIGIBLE") {
    transition(db, id, "INELIGIBLE", "system", { reasons: r.reasons, rulesVersion: r.rulesVersion });
    return { state: "INELIGIBLE", duplicate: false };
  }

  // Same role at the same company already in the pipeline: do not pursue twice.
  const dup = db
    .prepare(`SELECT id FROM postings WHERE dedupe_hash = (SELECT dedupe_hash FROM postings WHERE id = ?) AND id != ? AND closed_at IS NULL AND state NOT IN ('INELIGIBLE','DISCOVERED','NORMALIZED','ELIGIBILITY_PENDING','CLOSED') ORDER BY id LIMIT 1`)
    .get(id, id) as { id: number } | undefined;
  if (dup) {
    db.prepare("UPDATE postings SET duplicate_of = ? WHERE id = ?").run(dup.id, id);
    transition(db, id, "INELIGIBLE", "system", { reasons: [`duplicate of posting #${dup.id}`], rulesVersion: r.rulesVersion });
    return { state: "INELIGIBLE", duplicate: true };
  }
  db.prepare("UPDATE postings SET duplicate_of = NULL WHERE id = ?").run(id);

  // Employer AI-use policy: the user decides each posting (decision 0003). Never auto-resolved.
  if (r.aiPolicy.detected) {
    transition(db, id, "NEEDS_ATTENTION", "system", { reason: "employer AI-use policy; user decides", policy: r.aiPolicy.text });
    return { state: "NEEDS_ATTENTION", duplicate: false };
  }
  transition(db, id, "QUALIFIED", "system", { flags: r.flags.map((f) => f.code), rulesVersion: r.rulesVersion });
  return { state: "QUALIFIED", duplicate: false };
}

function closeRemoved(db: DB, companyId: number, runStart: string): number {
  const gone = db.prepare("SELECT id, state FROM postings WHERE company_id = ? AND closed_at IS NULL AND last_seen_at < ?").all(companyId, runStart) as { id: number; state: State }[];
  for (const g of gone) {
    db.transaction(() => {
      db.prepare("UPDATE postings SET closed_at = ? WHERE id = ?").run(runStart, g.id);
      if (PRE_SUBMISSION.includes(g.state)) transition(db, g.id, "CLOSED", "system", { reason: "listing removed from job board" });
      else recordEvent(db, { postingId: g.id, kind: "listing_removed", actor: "system", detail: { state: g.state } });
    })();
  }
  return gone.length;
}

/**
 * Re-runs eligibility for postings not yet drafted (after a rules or config change).
 * Postings held in NEEDS_ATTENTION for an employer AI policy can only be moved to INELIGIBLE
 * (a hard rule now fails); the system never releases the hold (decision 0003).
 */
export function reevaluate(db: DB, companies: CompanyConfig[], cfg: EligibilityConfig, at = new Date()): { reevaluated: number; heldNowIneligible: number } {
  const rows = db
    .prepare(`SELECT p.id, p.ats, p.state, p.attention_reason, c.token FROM postings p JOIN companies c ON c.id = p.company_id WHERE p.state IN ('INELIGIBLE','QUALIFIED','NEEDS_ATTENTION') AND p.closed_at IS NULL`)
    .all() as { id: number; ats: string; state: State; attention_reason: string | null; token: string }[];
  let n = 0;
  let heldNowIneligible = 0;
  for (const row of rows) {
    const p = rebuildFromDb(db, row.id);
    const c = companies.find((x) => x.ats === row.ats && x.token === row.token);
    if (!p || !c) continue;
    if (row.state === "NEEDS_ATTENTION") {
      if (row.attention_reason) continue; // drafting holds are the user's
      const r = evaluateEligibility(p, cfg, c, at);
      if (r.verdict !== "INELIGIBLE") continue;
      db.transaction(() => {
        transition(db, row.id, "ELIGIBILITY_PENDING", "system", { reason: "re-evaluation of held posting" });
        applyEligibility(db, row.id, p, c, cfg, at);
      })();
      heldNowIneligible++;
      n++;
      continue;
    }
    db.transaction(() => {
      transition(db, row.id, "ELIGIBILITY_PENDING", "system", { reason: "re-evaluation" });
      applyEligibility(db, row.id, p, c, cfg, at);
    })();
    n++;
  }
  return { reevaluated: n, heldNowIneligible };
}

/** Normalized posting is stored so re-evaluation does not need the network. */
function rebuildFromDb(db: DB, id: number): NormalizedPosting | null {
  const r = db.prepare("SELECT normalized_json FROM postings WHERE id = ?").get(id) as { normalized_json: string | null } | undefined;
  return r?.normalized_json ? ({ ...JSON.parse(r.normalized_json), raw: null } as NormalizedPosting) : null;
}
