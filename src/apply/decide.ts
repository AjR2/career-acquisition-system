import { readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config/env.js";
import type { DB } from "../db/index.js";
import type { ApplicationQuestion } from "../discovery/types.js";
import type { Profile } from "../drafting/render.js";
import { resumeBlocks, type ResumeDraft } from "../drafting/schemas.js";
import type { Claim } from "../evidence/claims.js";
import { sha256 } from "../pipeline/dedupe.js";
import { transition, type State } from "../pipeline/states.js";
import { validateClaims } from "../validate/claims-validator.js";
import { lint, type BannedConfig } from "../validate/linter.js";
import { buildPlan, type ApplicationPlan, type loadStandardAnswers } from "./plan.js";

export class DecisionError extends Error {}

export interface DecisionContext {
  claims: Claim[];
  claimsFile?: string;
  banned: BannedConfig;
  techTerms: string[];
  profile: Profile;
  answers: ReturnType<typeof loadStandardAnswers>;
}

export function claimsHash(file = path.join(PROJECT_ROOT, "career-evidence", "approved-claims.yaml")): string {
  return sha256(readFileSync(file, "utf8"));
}

export interface QueueMaterial {
  id: number;
  version: number;
  content_json: string;
  rendered_md: string;
  content_hash: string;
}

export function latestValidated(db: DB, postingId: number): QueueMaterial | undefined {
  return db
    .prepare("SELECT id, version, content_json, rendered_md, content_hash FROM materials WHERE posting_id = ? AND kind = 'resume' AND status IN ('validated','approved') ORDER BY version DESC LIMIT 1")
    .get(postingId) as QueueMaterial | undefined;
}

/** Re-checks a stored draft against the claims as they are now (claims and counts change after drafting). */
export function revalidate(m: QueueMaterial, ctx: DecisionContext, postingText: string) {
  const draft = JSON.parse(m.content_json) as ResumeDraft;
  const blocks = resumeBlocks(draft);
  return {
    claimIssues: validateClaims(blocks, ctx.claims, "resume", { techTerms: ctx.techTerms, postingText }),
    lint: lint(blocks.map((b) => b.text).join("\n"), ctx.banned),
  };
}

export function planFor(db: DB, postingId: number, ctx: DecisionContext, userAnswers: Record<string, string> = {}): ApplicationPlan {
  const r = db.prepare("SELECT questions_json FROM postings WHERE id = ?").get(postingId) as { questions_json: string | null };
  return buildPlan(r.questions_json ? (JSON.parse(r.questions_json) as ApplicationQuestion[]) : null, ctx.profile, ctx.answers, userAnswers);
}

function state(db: DB, id: number): State {
  const r = db.prepare("SELECT state FROM postings WHERE id = ?").get(id) as { state: State } | undefined;
  if (!r) throw new DecisionError(`posting ${id} not found`);
  return r.state;
}

function record(db: DB, d: { postingId: number; decision: string; materialId?: number; materialHash?: string; claimsHash?: string; note?: string; answers?: Record<string, string> }): number {
  return Number(
    db
      .prepare("INSERT INTO decisions (posting_id, material_id, material_hash, claims_hash, decision, note, answers_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(d.postingId, d.materialId ?? null, d.materialHash ?? null, d.claimsHash ?? null, d.decision, d.note ?? null, d.answers ? JSON.stringify(d.answers) : null).lastInsertRowid,
  );
}

/**
 * Approval is the user's explicit act. It binds to one material version and the current claims file,
 * and is refused if the draft no longer validates or any required question lacks an answer.
 */
export function approve(db: DB, postingId: number, ctx: DecisionContext, userAnswers: Record<string, string>): number {
  if (state(db, postingId) !== "READY_FOR_REVIEW") throw new DecisionError("only items in READY_FOR_REVIEW can be approved");
  const m = latestValidated(db, postingId);
  if (!m) throw new DecisionError("no validated resume to approve");
  const text = (db.prepare("SELECT description_text FROM postings WHERE id = ?").get(postingId) as { description_text: string }).description_text;
  const check = revalidate(m, ctx, text);
  if (check.claimIssues.length || check.lint.length) {
    throw new DecisionError(`draft no longer validates against current claims: ${[...check.claimIssues.map((i) => i.detail), ...check.lint.map((l) => `banned "${l.match}"`)].slice(0, 3).join("; ")}. Use revise.`);
  }
  const cleaned = Object.fromEntries(Object.entries(userAnswers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  const plan = planFor(db, postingId, ctx, cleaned);
  if (plan.needsUser.length) throw new DecisionError(`answer the required questions first: ${plan.needsUser.map((q) => q.label).join(" | ")}`);
  return db.transaction(() => {
    const id = record(db, { postingId, decision: "approve", materialId: m.id, materialHash: m.content_hash, claimsHash: claimsHash(ctx.claimsFile), answers: cleaned });
    db.prepare("UPDATE materials SET status = 'approved' WHERE id = ?").run(m.id);
    transition(db, postingId, "APPROVED", "user", { decisionId: id, materialHash: m.content_hash });
    return id;
  })();
}

export function reject(db: DB, postingId: number, note?: string) {
  const s = state(db, postingId);
  db.transaction(() => {
    record(db, { postingId, decision: s === "NEEDS_ATTENTION" ? "skip" : "reject", note });
    transition(db, postingId, "USER_REJECTED", "user", { note });
  })();
}

export function defer(db: DB, postingId: number, note?: string) {
  db.transaction(() => {
    record(db, { postingId, decision: "defer", note });
    transition(db, postingId, "DEFERRED", "user", { note });
  })();
}

/** Sends a draft back for another attempt with the user's note as feedback (the drafter picks it up). */
export function requestRevision(db: DB, postingId: number, note: string) {
  if (!note.trim()) throw new DecisionError("a revision needs a note saying what to change");
  db.transaction(() => {
    record(db, { postingId, decision: "revise", note });
    transition(db, postingId, "DRAFTING", "user", { revision_note: note });
  })();
}

/** User releases a NEEDS_ATTENTION hold (e.g. decided to proceed despite an employer AI-use policy). */
export function release(db: DB, postingId: number, note: string) {
  if (state(db, postingId) !== "NEEDS_ATTENTION") throw new DecisionError("only held items can be released");
  if (!note.trim()) throw new DecisionError("say why you are releasing this item (recorded in the log)");
  db.transaction(() => {
    record(db, { postingId, decision: "release", note });
    db.prepare("UPDATE postings SET attention_reason = NULL WHERE id = ?").run(postingId);
    transition(db, postingId, "QUALIFIED", "user", { note });
  })();
}

/** Resolves SUBMISSION_UNCERTAIN. Never automatic. */
export function resolveUncertain(db: DB, postingId: number, outcome: "submitted" | "not_sent", evidence: string) {
  if (state(db, postingId) !== "SUBMISSION_UNCERTAIN") throw new DecisionError("item is not in SUBMISSION_UNCERTAIN");
  if (outcome === "submitted" && !evidence.trim()) throw new DecisionError("paste the confirmation evidence (e.g. the confirmation email text)");
  db.transaction(() => {
    record(db, { postingId, decision: outcome === "submitted" ? "resolve_submitted" : "resolve_not_sent", note: evidence });
    if (outcome === "submitted") {
      db.prepare("UPDATE submissions SET status = 'submitted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), confirmation_json = ? WHERE posting_id = ? AND status = 'uncertain'").run(
        JSON.stringify({ method: "user_evidence", evidence }),
        postingId,
      );
    } else {
      // Not sent: free the idempotency key so a later approved attempt can run.
      db.prepare("DELETE FROM submissions WHERE posting_id = ? AND status = 'uncertain'").run(postingId);
    }
    transition(db, postingId, outcome === "submitted" ? "SUBMITTED" : "APPROVED", "user", { evidence: evidence.slice(0, 500) });
  })();
}

const MANUAL_STATUS: State[] = ["RECRUITER_RESPONSE", "INTERVIEW_REQUESTED", "INTERVIEWING", "REJECTED", "OFFER", "WITHDRAWN", "CLOSED"];

/** Tier 1: post-submission states are set by the user from the Pipeline view. */
export function updateStatus(db: DB, postingId: number, to: State, note?: string) {
  if (!MANUAL_STATUS.includes(to)) throw new DecisionError(`not a manual status: ${to}`);
  db.transaction(() => {
    record(db, { postingId, decision: "status_update", note: `${to}${note ? `: ${note}` : ""}` });
    transition(db, postingId, to, "user", { note });
  })();
}
