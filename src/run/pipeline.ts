import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "../config/env.js";
import type { DB } from "../db/index.js";
import type { NormalizedPosting } from "../discovery/types.js";
import { draftResume, type DraftDeps } from "../drafting/draft.js";
import type { Profile } from "../drafting/render.js";
import type { EligibilityResult } from "../eligibility/rules.js";
import { loadClaims, type Claim } from "../evidence/claims.js";
import { SpendCapError, type LlmClient } from "../llm/client.js";
import { log } from "../log.js";
import { recordEvent, transition, type State } from "../pipeline/states.js";
import { loadApprovedWording } from "../evidence/wording.js";
import { sha256 } from "../pipeline/dedupe.js";
import { analyzePosting, type PostingAnalysis } from "../suitability/analyze.js";
import { scoreSuitability, type Preferences, type Weights } from "../suitability/score.js";
import { DEFAULT_TARGET, loadTarget, type Target } from "../config/target.js";
import { findTerms } from "../validate/claims-validator.js";

export interface LlmConfig {
  drafting: { max_per_day: number; min_suitability: number; cover_letter: string; max_queue: number };
  suitability: { weights: Weights };
}

export function loadLlmConfig(file = path.join(PROJECT_ROOT, "config", "llm.yaml")): LlmConfig {
  const raw = YAML.parse(readFileSync(file, "utf8"));
  return z
    .object({
      drafting: z.object({ max_per_day: z.number().int().min(0), min_suitability: z.number().min(0).max(1), cover_letter: z.string(), max_queue: z.number().int().min(0).default(8) }),
      suitability: z.object({ weights: z.object({ technical_alignment: z.number(), ai_native_culture: z.number(), compensation: z.number(), experience_alignment: z.number(), career_development: z.number() }) }),
    })
    .parse(raw);
}

export function loadPreferences(file = path.join(PROJECT_ROOT, "config", "preferences.yaml")): Preferences {
  const P = z.object({ bonus: z.number(), pattern: z.string() });
  return z
    .object({
      deprioritized_work: z.array(z.object({ label: z.string(), pattern: z.string(), scope: z.enum(["title", "title_and_responsibilities"]), fit: z.number().min(0).max(1), source: z.string() })),
      target_titles: z.object({ primary: P, secondary: P }),
    })
    .parse(YAML.parse(readFileSync(file, "utf8")));
}

export function loadProfile(file = path.join(PROJECT_ROOT, "config", "profile.local.yaml")): Profile {
  return z.object({ name: z.string(), location: z.string(), email: z.string(), phone: z.string(), linkedin: z.string(), github: z.string() }).parse(YAML.parse(readFileSync(file, "utf8")));
}

export function loadVoiceProfile(file = path.join(PROJECT_ROOT, "career-evidence", "voice-profile.md")): string {
  return readFileSync(file, "utf8");
}

/** The candidate's technologies, from confirmed claims only. */
export function candidateStack(claims: Claim[], techTerms: string[], target: Target = DEFAULT_TARGET): string[] {
  const text = claims.filter((c) => c.status === "VERIFIED" || c.status === "USER_CONFIRMED").map((c) => c.claim_text).join("\n");
  return [...findTerms(text, techTerms), ...target.extra_skill_synonyms];
}

interface Row {
  id: number;
  state: State;
  normalized_json: string;
  eligibility_json: string;
  analysis_json: string | null;
}

/** Analyzes (Haiku) and scores postings that are eligible but not yet scored. */
export async function scorePending(db: DB, llm: LlmClient, opts: { model: string; weights: Weights; techTerms: string[]; claims: Claim[]; limit?: number; rescore?: boolean; prefs?: Preferences; target?: Target; targetBase?: number }) {
  // rescore: recompute every score from stored analyses (no model calls for already-analyzed postings).
  const rows = db
    .prepare(`SELECT id, state, normalized_json, eligibility_json, analysis_json FROM postings WHERE state IN ('QUALIFIED','NEEDS_ATTENTION') AND closed_at IS NULL AND ${opts.rescore ? "1=1" : "suitability_score IS NULL"} ORDER BY id LIMIT ?`)
    .all(opts.limit ?? 1000) as Row[];
  const target = opts.target ?? DEFAULT_TARGET;
  const stack = candidateStack(opts.claims, opts.techTerms, target);
  let analyzed = 0;
  let failed = 0;
  let stoppedForCap = false;
  for (const r of rows) {
    const p = JSON.parse(r.normalized_json) as NormalizedPosting;
    const e = JSON.parse(r.eligibility_json) as EligibilityResult;
    let a: PostingAnalysis | null = r.analysis_json ? JSON.parse(r.analysis_json) : null;
    if (!a) {
      try {
        let res = await analyzePosting(llm, p, opts.model, r.id, target);
        if (!res.ok && res.retryable) res = await analyzePosting(llm, p, opts.model, r.id, target);
        if (!res.ok) {
          failed++;
          recordEvent(db, { postingId: r.id, kind: "analysis_failed", actor: "system", detail: { error: res.error } });
          continue;
        }
        a = res.data;
        analyzed++;
      } catch (err) {
        if (err instanceof SpendCapError) {
          stoppedForCap = true;
          log.warn({ err: err.message }, "spend cap reached; stopping scoring");
          break;
        }
        throw err;
      }
    }
    const s = scoreSuitability(a, e, stack, opts.weights, opts.targetBase ?? 150000, p.title, opts.prefs, target);
    db.prepare("UPDATE postings SET analysis_json = ?, suitability_score = ?, suitability_json = ? WHERE id = ?").run(JSON.stringify(a), s.score, JSON.stringify(s), r.id);
    recordEvent(db, { postingId: r.id, kind: "scored", actor: "system", detail: { score: s.score } });
  }
  return { candidates: rows.length, analyzed, failed, stoppedForCap };
}

/**
 * Rejects NEEDS_ATTENTION holds (e.g. employer AI-use policy) whose suitability score is below the
 * drafting floor, so they never reach the queue (decision 0005, user decision 2026-10-27).
 * Unscored holds are left for the user. The user can restore one (USER_REJECTED -> QUALIFIED).
 */
export function dropBelowScoreFloor(db: DB, minScore: number) {
  const rows = db
    .prepare("SELECT id, suitability_score AS score FROM postings WHERE state = 'NEEDS_ATTENTION' AND closed_at IS NULL AND suitability_score IS NOT NULL AND suitability_score < ?")
    .all(minScore) as { id: number; score: number }[];
  for (const r of rows) {
    transition(db, r.id, "USER_REJECTED", "system", { reason: "below_score_floor", score: r.score, floor: minScore, decision: "0005" });
  }
  return { dropped: rows.map((r) => r.id) };
}

/** Drafts resumes for the top-scoring qualified postings, within the daily attention budget. */
export const MIN_USABLE_CLAIMS = 5;

export async function draftTop(db: DB, deps: DraftDeps, opts: { maxPerDay: number; minScore: number; onlyId?: number; maxQueue?: number }) {
  deps = { ...deps, approvedWording: loadApprovedWording(db, deps.claims) };
  // A fresh install has no confirmed claims; drafting from nothing would only produce failures.
  const usable = deps.claims.filter((c) => (c.status === "VERIFIED" || c.status === "USER_CONFIRMED") && c.permitted_use.includes("resume")).length;
  if (usable < MIN_USABLE_CLAIMS) {
    return { draftedToday: 0, waiting: 0, room: 0, results: [] as { id: number; ok: boolean; reason?: string }[], stoppedForCap: false, blocked: `drafting needs at least ${MIN_USABLE_CLAIMS} VERIFIED or USER_CONFIRMED claims permitted for resumes (found ${usable}); see ONBOARDING.md` };
  }
  const today = new Date().toISOString().slice(0, 10);
  const draftedToday = (db.prepare("SELECT count(DISTINCT posting_id) AS n FROM materials WHERE kind = 'resume' AND version = 1 AND substr(created_at, 1, 10) = ?").get(today) as { n: number }).n;
  // Don't pile up drafts the user hasn't reviewed: they go stale and cost attention later.
  const waiting = (db.prepare("SELECT count(*) AS n FROM postings WHERE state = 'READY_FOR_REVIEW'").get() as { n: number }).n;
  const queueRoom = opts.maxQueue == null ? Infinity : Math.max(0, opts.maxQueue - waiting);
  const room = opts.onlyId ? 1 : Math.max(0, Math.min(opts.maxPerDay - draftedToday, queueRoom));
  const rows = db
    .prepare(
      `SELECT p.id, p.company_name, p.title, p.description_text, p.analysis_json FROM postings p
       WHERE p.state = 'QUALIFIED' AND p.closed_at IS NULL AND p.suitability_score >= ? ${opts.onlyId ? "AND p.id = ?" : ""}
         AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.posting_id = p.id AND m.kind = 'resume')
       ORDER BY p.suitability_score DESC LIMIT ?`,
    )
    .all(...(opts.onlyId ? [opts.minScore, opts.onlyId, room] : [opts.minScore, room])) as { id: number; company_name: string; title: string; description_text: string; analysis_json: string | null }[];

  const results: { id: number; ok: boolean; reason?: string }[] = [];
  for (const r of rows) {
    transition(db, r.id, "DRAFTING", "system");
    let outcome;
    try {
      outcome = await draftResume(deps, { company: r.company_name, title: r.title, text: r.description_text }, r.analysis_json ? JSON.parse(r.analysis_json) : null, r.id);
    } catch (err) {
      if (err instanceof SpendCapError) {
        // Nothing was drafted: back to the queue for the next run.
        transition(db, r.id, "QUALIFIED", "system", { reason: "daily spend cap reached before drafting finished" });
        break;
      }
      throw err;
    }
    persistOutcome(db, r.id, outcome, 0);
    results.push({ id: r.id, ok: outcome.ok, reason: outcome.reason });
  }
  return { draftedToday, waiting, room, results, stoppedForCap: results.length < rows.length };
}

/**
 * True when no draft was produced and every attempt failed for a transient reason (timeout, network,
 * rate limit, server error). Those go back to the queue; only real validation failures need the user.
 */
export function onlyTransientFailures(outcome: Awaited<ReturnType<typeof draftResume>>): boolean {
  if (outcome.ok || outcome.attempts.some((a) => a.draft)) return false;
  return outcome.attempts.every((a) => /timed out|timeout|ECONN|ETIMEDOUT|network|socket|fetch failed|overloaded|rate limit|\b5\d\d\b|Connection error/i.test(a.validation.schemaError ?? ""));
}

/** Stores every attempt as a material version (after `offset`) and moves the posting to review or attention. */
function persistOutcome(db: DB, postingId: number, outcome: Awaited<ReturnType<typeof draftResume>>, offset: number) {
  if (onlyTransientFailures(outcome)) {
    // Incident 2026-10-26: timeouts during Mac sleep were held as "failed validation twice".
    transition(db, postingId, "QUALIFIED", "system", { reason: "model unavailable (transient); will retry next run", errors: outcome.attempts.map((a) => a.validation.schemaError) });
    return;
  }
  db.transaction(() => {
    outcome.attempts.forEach((a, i) => {
      if (!a.draft || !a.rendered) return;
      const content = JSON.stringify(a.draft);
      const isFinal = i === outcome.attempts.length - 1;
      db.prepare("INSERT INTO materials (posting_id, kind, version, content_json, rendered_md, content_hash, status, validation_json) VALUES (?, 'resume', ?, ?, ?, ?, ?, ?)").run(
        postingId,
        offset + a.attempt,
        content,
        a.rendered,
        sha256(content),
        a.validation.passed ? "validated" : isFinal ? "failed" : "superseded",
        JSON.stringify(a.validation),
      );
    });
    transition(db, postingId, "VALIDATING", "system", { attempts: outcome.attempts.length });
    if (outcome.ok) {
      transition(db, postingId, "READY_FOR_REVIEW", "system");
    } else {
      db.prepare("UPDATE postings SET attention_reason = ? WHERE id = ?").run(outcome.reason ?? "drafting failed", postingId);
      transition(db, postingId, "NEEDS_ATTENTION", "system", { reason: outcome.reason });
    }
  })();
}

/** Re-drafts postings the user sent back with a revision note. Earlier versions are superseded. */
export async function redraftRevisions(db: DB, deps: DraftDeps) {
  deps = { ...deps, approvedWording: loadApprovedWording(db, deps.claims), wordingMode: "prefer" };
  const rows = db
    .prepare(
      `SELECT p.id, p.company_name, p.title, p.description_text, p.analysis_json,
              (SELECT note FROM decisions d WHERE d.posting_id = p.id AND d.decision = 'revise' ORDER BY d.id DESC LIMIT 1) AS note,
              (SELECT coalesce(max(version), 0) FROM materials m WHERE m.posting_id = p.id AND m.kind = 'resume') AS v
       FROM postings p WHERE p.state = 'DRAFTING'`,
    )
    .all() as { id: number; company_name: string; title: string; description_text: string; analysis_json: string | null; note: string | null; v: number }[];
  const results: { id: number; ok: boolean }[] = [];
  for (const r of rows.filter((x) => x.note)) {
    db.prepare("UPDATE materials SET status = 'superseded' WHERE posting_id = ? AND status IN ('validated','approved')").run(r.id);
    let outcome;
    try {
      outcome = await draftResume(deps, { company: r.company_name, title: r.title, text: r.description_text }, r.analysis_json ? JSON.parse(r.analysis_json) : null, r.id, r.note!);
    } catch (err) {
      if (err instanceof SpendCapError) break;
      throw err;
    }
    persistOutcome(db, r.id, outcome, r.v);
    results.push({ id: r.id, ok: outcome.ok });
  }
  return { results };
}

export function loadDraftDeps(llm: LlmClient, extra: { banned: DraftDeps["banned"]; techTerms: string[]; draftModel: string; reviewModel: string }): DraftDeps {
  return { llm, claims: loadClaims(), voiceProfile: loadVoiceProfile(), profile: loadProfile(), roleNote: loadTarget().role_honesty_note, ...extra };
}
