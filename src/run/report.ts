import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config/env.js";
import type { DB } from "../db/index.js";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");

/**
 * Weekly report for the 15-minute Sunday audit (spec section 10). Recommendations are suggestions only;
 * the system never changes hard constraints.
 */
export function weeklyReport(db: DB, now = new Date(), opts: { tripwireDate?: string; interviewThreshold?: number | null } = {}): string {
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const everIn = (states: string[]) =>
    (db.prepare(`SELECT count(DISTINCT posting_id) AS n FROM events WHERE to_state IN (${states.map(() => "?").join(",")}) AND at >= ?`).get(...states, since) as { n: number }).n;
  const discovered = (db.prepare("SELECT count(*) AS n FROM postings WHERE first_seen_at >= ?").get(since) as { n: number }).n;
  const eligible = everIn(["QUALIFIED", "NEEDS_ATTENTION"]);
  const qualified = everIn(["QUALIFIED"]);
  const drafted = everIn(["READY_FOR_REVIEW"]);
  const approved = everIn(["APPROVED"]);
  const submitted = everIn(["SUBMITTED"]);
  const responses = everIn(["RECRUITER_RESPONSE", "INTERVIEW_REQUESTED", "REJECTED"]);
  const interviews = everIn(["INTERVIEW_REQUESTED", "INTERVIEWING"]);
  const allSubmitted = (db.prepare("SELECT count(*) AS n FROM submissions WHERE status = 'submitted'").get() as { n: number }).n;
  const allInterviews = (db.prepare("SELECT count(DISTINCT posting_id) AS n FROM events WHERE to_state IN ('INTERVIEW_REQUESTED','INTERVIEWING')").get() as { n: number }).n;

  const cost = db.prepare("SELECT coalesce(sum(cost_usd),0) AS usd, count(*) AS calls FROM llm_calls WHERE at >= ?").get(since) as { usd: number; calls: number };
  const sample = db
    .prepare("SELECT p.id, p.company_name, p.title, s.finished_at FROM submissions s JOIN postings p ON p.id = s.posting_id WHERE s.status = 'submitted' ORDER BY random() LIMIT 3")
    .all() as { id: number; company_name: string; title: string; finished_at: string }[];
  const contract = db
    .prepare("SELECT company_name, title, url FROM postings WHERE lane = 'contract' AND closed_at IS NULL AND first_seen_at >= ? AND json_extract(eligibility_json, '$.role.ok') = 1 ORDER BY company_name")
    .all(since) as { company_name: string; title: string; url: string }[];
  const waits = db
    .prepare(
      `SELECT p.company_name, p.title, (julianday(coalesce(d.at, 'now')) - julianday(r.at)) * 24 AS hours, d.to_state AS outcome
       FROM events r JOIN postings p ON p.id = r.posting_id
       LEFT JOIN events d ON d.posting_id = r.posting_id AND d.from_state = 'READY_FOR_REVIEW' AND d.id > r.id
       WHERE r.to_state = 'READY_FOR_REVIEW' AND r.at >= ? GROUP BY r.id`,
    )
    .all(since) as { company_name: string; title: string; hours: number; outcome: string | null }[];
  const failedBoards = db.prepare("SELECT name, last_fetch_status, last_error FROM companies WHERE last_fetch_status != 'ok'").all() as { name: string; last_fetch_status: string; last_error: string }[];
  const rejectReasons = db
    .prepare(`SELECT substr(json_extract(eligibility_json,'$.reasons[0]'),1,40) AS r, count(*) AS n FROM postings WHERE state = 'INELIGIBLE' AND first_seen_at >= ? AND json_extract(eligibility_json,'$.role.ok') = 1 GROUP BY r ORDER BY n DESC LIMIT 5`)
    .all(since) as { r: string; n: number }[];
  const userRejected = (db.prepare("SELECT count(*) AS n FROM decisions WHERE decision IN ('reject','skip') AND decided_at >= ?").get(since) as { n: number }).n;

  const noResume = db
    .prepare(`SELECT p.company_name, p.title FROM submissions s JOIN postings p ON p.id = s.posting_id WHERE s.status = 'submitted' AND json_extract(s.filled_json, '$.resumeUploaded') = 0`)
    .all() as { company_name: string; title: string }[];
  const recs: string[] = [];
  if (noResume.length) recs.push(`${noResume.length} submission(s) went in without a resume attached by CAS: ${noResume.map((n) => `${n.company_name} (${n.title})`).join("; ")}. Decide whether to follow up.`);
  if (drafted && userRejected / Math.max(1, drafted) > 0.5) recs.push("You rejected more than half of the drafts. Consider adding the pattern to config/preferences.yaml or raising drafting.min_suitability.");
  if (failedBoards.length) recs.push(`Fix ${failedBoards.length} failing job board(s) in config/companies.yaml (see below).`);
  if (submitted >= 10 && !responses) recs.push("Ten or more submissions with no responses: review targeting and resume positioning.");
  const waitAvg = waits.length ? waits.reduce((a, w) => a + w.hours, 0) / waits.length : 0;
  if (waitAvg > 48) recs.push(`Drafts waited ${Math.round(waitAvg)} hours on average. Lower drafting.max_per_day to match your review time.`);
  if (!recs.length) recs.push("No changes recommended this week.");

  const tripwire = opts.tripwireDate ?? "2026-12-13";
  const lead =
    now.toISOString().slice(0, 10) >= tripwire && opts.interviewThreshold != null && allInterviews < opts.interviewThreshold
      ? `**Recalibration recommended:** ${allInterviews} first-round interview(s) since launch, below your threshold of ${opts.interviewThreshold}. Review targeting and materials before submitting more.\n\n`
      : "";

  return `# Weekly report: week ending ${now.toISOString().slice(0, 10)}

${lead}## Funnel (last 7 days)
| Stage | Count | Conversion from previous |
|---|---|---|
| Discovered | ${discovered} | |
| Eligible | ${eligible} | ${pct(eligible, discovered)} |
| Qualified | ${qualified} | ${pct(qualified, eligible)} |
| Drafted | ${drafted} | ${pct(drafted, qualified)} |
| Approved | ${approved} | ${pct(approved, drafted)} |
| Submitted | ${submitted} | ${pct(submitted, approved)} |
| Responses | ${responses} | ${pct(responses, submitted)} |
| Interviews | ${interviews} | ${pct(interviews, submitted)} |

Primary metric (all time): ${allInterviews} first-round interview(s) from ${allSubmitted} submission(s) (${pct(allInterviews, allSubmitted)}).

## Three submissions to review
${sample.map((s) => `- ${s.company_name}: ${s.title} (submitted ${s.finished_at?.slice(0, 10)}), posting #${s.id}`).join("\n") || "- None yet."}

## Contract lane (report only)
${contract.map((c) => `- ${c.company_name}: ${c.title} ${c.url}`).join("\n") || "- None this week."}

## Model cost (last 7 days)
- Total: $${cost.usd.toFixed(2)} over ${cost.calls} call(s)
- Per qualified opportunity: ${qualified ? `$${(cost.usd / qualified).toFixed(3)}` : "n/a"}
- Per submission: ${submitted ? `$${(cost.usd / submitted).toFixed(2)}` : "n/a"}

## Time in the approval queue
${waits.map((w) => `- ${w.company_name}: ${w.title}: ${Math.round(w.hours)} h${w.outcome ? ` → ${w.outcome}` : " (still waiting)"}`).join("\n") || "- Nothing entered review."}

## Top rejection reasons for target-title roles
${rejectReasons.map((r) => `- ${r.r}: ${r.n}`).join("\n") || "- None."}

## Failing job boards
${failedBoards.map((b) => `- ${b.name}: ${b.last_fetch_status} (${b.last_error})`).join("\n") || "- None."}

## Recommendations (suggestions only; hard constraints never change automatically)
${recs.map((r) => `- ${r}`).join("\n")}
`;
}

export function writeWeeklyReport(db: DB, now = new Date()): string {
  const dir = path.join(PROJECT_ROOT, "data", "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `weekly-${now.toISOString().slice(0, 10)}.md`);
  writeFileSync(file, weeklyReport(db, now));
  return file;
}
