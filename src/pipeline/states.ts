import type { DB } from "../db/index.js";

export const STATES = [
  "DISCOVERED", "NORMALIZED", "ELIGIBILITY_PENDING", "INELIGIBLE", "QUALIFIED",
  "RESEARCHING", "RESEARCHED", "DRAFTING", "VALIDATING", "NEEDS_ATTENTION",
  "READY_FOR_REVIEW", "APPROVED", "USER_REJECTED", "DEFERRED", "SUBMITTING",
  "SUBMITTED", "SUBMISSION_UNCERTAIN", "RECRUITER_RESPONSE", "INTERVIEW_REQUESTED",
  "INTERVIEWING", "REJECTED", "OFFER", "WITHDRAWN", "CLOSED",
] as const;
export type State = (typeof STATES)[number];

/** States before anything has been sent to an employer. A removed listing closes these. */
export const PRE_SUBMISSION: readonly State[] = [
  "DISCOVERED", "NORMALIZED", "ELIGIBILITY_PENDING", "INELIGIBLE", "QUALIFIED",
  "RESEARCHING", "RESEARCHED", "DRAFTING", "VALIDATING", "NEEDS_ATTENTION",
  "READY_FOR_REVIEW", "APPROVED", "DEFERRED",
];

const T: Record<State, readonly State[]> = {
  DISCOVERED: ["NORMALIZED"],
  NORMALIZED: ["ELIGIBILITY_PENDING"],
  // INELIGIBLE -> ELIGIBILITY_PENDING allows re-evaluation when the listing or the rules change.
  ELIGIBILITY_PENDING: ["INELIGIBLE", "QUALIFIED", "NEEDS_ATTENTION"],
  INELIGIBLE: ["ELIGIBILITY_PENDING"],
  QUALIFIED: ["RESEARCHING", "DRAFTING", "NEEDS_ATTENTION", "ELIGIBILITY_PENDING", "USER_REJECTED", "DEFERRED"],
  RESEARCHING: ["RESEARCHED", "NEEDS_ATTENTION"],
  RESEARCHED: ["DRAFTING"],
  // DRAFTING -> QUALIFIED: interrupted before any output (e.g. daily spend cap); back in the queue.
  DRAFTING: ["VALIDATING", "NEEDS_ATTENTION", "QUALIFIED"],
  VALIDATING: ["READY_FOR_REVIEW", "NEEDS_ATTENTION", "DRAFTING"],
  NEEDS_ATTENTION: ["DRAFTING", "READY_FOR_REVIEW", "USER_REJECTED", "DEFERRED", "QUALIFIED", "ELIGIBILITY_PENDING"],
  READY_FOR_REVIEW: ["APPROVED", "USER_REJECTED", "DEFERRED", "DRAFTING"],
  DEFERRED: ["READY_FOR_REVIEW", "USER_REJECTED", "QUALIFIED"],
  // Approval can be withdrawn by the user before submission starts.
  APPROVED: ["SUBMITTING", "READY_FOR_REVIEW"],
  // An interrupted submission is never retried automatically: it lands in SUBMISSION_UNCERTAIN.
  SUBMITTING: ["SUBMITTED", "SUBMISSION_UNCERTAIN"],
  // Resolved only by the user: with confirmation evidence (SUBMITTED) or a statement it was not sent (APPROVED).
  SUBMISSION_UNCERTAIN: ["SUBMITTED", "APPROVED"],
  SUBMITTED: ["RECRUITER_RESPONSE", "INTERVIEW_REQUESTED", "REJECTED", "WITHDRAWN", "CLOSED"],
  RECRUITER_RESPONSE: ["INTERVIEW_REQUESTED", "REJECTED", "WITHDRAWN", "CLOSED"],
  INTERVIEW_REQUESTED: ["INTERVIEWING", "REJECTED", "WITHDRAWN"],
  INTERVIEWING: ["OFFER", "REJECTED", "WITHDRAWN"],
  OFFER: ["WITHDRAWN", "CLOSED"],
  USER_REJECTED: ["QUALIFIED"],
  REJECTED: ["CLOSED"],
  WITHDRAWN: ["CLOSED"],
  CLOSED: [],
};

/** Transitions that only the user may make (never the system). */
const USER_ONLY = new Set<string>([
  "READY_FOR_REVIEW>APPROVED", "READY_FOR_REVIEW>USER_REJECTED", "READY_FOR_REVIEW>DEFERRED",
  "SUBMISSION_UNCERTAIN>SUBMITTED", "SUBMISSION_UNCERTAIN>APPROVED",
  "APPROVED>READY_FOR_REVIEW",
  // NEEDS_ATTENTION holds (employer AI policy, failed validation, unsupported questions) are
  // released only by the user. The system may only re-run eligibility, close a removed listing, or
  // reject a hold scored below drafting.min_suitability (decision 0005, via dropBelowScoreFloor).
  "NEEDS_ATTENTION>DRAFTING", "NEEDS_ATTENTION>READY_FOR_REVIEW", "NEEDS_ATTENTION>QUALIFIED",
  "NEEDS_ATTENTION>DEFERRED",
  "QUALIFIED>USER_REJECTED", "QUALIFIED>DEFERRED", "USER_REJECTED>QUALIFIED",
]);

export class IllegalTransitionError extends Error {
  constructor(public from: State, public to: State, reason = "not a legal transition") {
    super(`Illegal transition ${from} -> ${to}: ${reason}`);
  }
}

export type Actor = "system" | "user";

export function canTransition(from: State, to: State, actor: Actor = "system"): boolean {
  if (from !== to && PRE_SUBMISSION.includes(from) && to === "CLOSED") return true;
  if (!T[from].includes(to)) return false;
  if (USER_ONLY.has(`${from}>${to}`) && actor !== "user") return false;
  return true;
}

export function assertTransition(from: State, to: State, actor: Actor = "system"): void {
  if (!(STATES as readonly string[]).includes(to)) throw new Error(`Unknown state: ${to}`);
  if (canTransition(from, to, actor)) return;
  const reason = T[from].includes(to) ? `requires the user, actor was ${actor}` : "not a legal transition";
  throw new IllegalTransitionError(from, to, reason);
}

export function recordEvent(
  db: DB,
  e: { postingId?: number | null; kind: string; from?: State | null; to?: State | null; actor: Actor; detail?: unknown },
): void {
  db.prepare(
    "INSERT INTO events (posting_id, kind, from_state, to_state, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(e.postingId ?? null, e.kind, e.from ?? null, e.to ?? null, e.actor, e.detail === undefined ? null : JSON.stringify(e.detail));
}

/**
 * Moves a posting to a new state and logs the event in one transaction.
 * Uses compare-and-set on the current state so a concurrent change cannot be overwritten.
 */
export function transition(db: DB, postingId: number, to: State, actor: Actor, detail?: unknown): void {
  db.transaction(() => {
    const row = db.prepare("SELECT state FROM postings WHERE id = ?").get(postingId) as { state: State } | undefined;
    if (!row) throw new Error(`Posting ${postingId} not found`);
    assertTransition(row.state, to, actor);
    const res = db
      .prepare("UPDATE postings SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND state = ?")
      .run(to, postingId, row.state);
    if (res.changes !== 1) throw new Error(`Concurrent state change on posting ${postingId}`);
    recordEvent(db, { postingId, kind: "state_change", from: row.state, to, actor, detail });
  })();
}
