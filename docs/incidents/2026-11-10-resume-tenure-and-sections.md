Observed failure: Tailored resumes overstated the user's tenure at one employer by a year, listed self-built tools under Experience next to paid roles, and left out the two strongest pieces of evidence the user had (one of them the only work with an outside user). Found in a manual review on 2026-11-10.

Expected behavior: Tenure matches elapsed time. Experience holds only employment and the user's own company; self-built systems sit under Projects. The strongest evidence appears on every resume.

Actual behavior: Every check passed because the source data was wrong and the schema had no Projects section. The validator confirmed the number against the tenure claim, which itself held the wrong number.

Root cause: (1) Data: the tenure claim counted school years instead of elapsed time from the start date, and a second claim gave a year count during the fourth school year (about three years elapsed). (2) Schema: `ResumeDraftSchema` had only `experience`, so the model had to put projects there. (3) Ledger gaps: the two strongest facts were never entered as claims. (4) One claim's wording implied an ongoing client practice where there were only prospects.

Evidence: Resume text reviewed in Claude chat 2026-11-10; `career-evidence/approved-claims.yaml` before this change.

Correction: (1) Claims fixed: tenure counted from the start date; the second claim says "since" a year instead of a count; the practice claim states the number of prospects. (2) The two missing facts added as claims with `always_include: true`. (3) Schema gains `projects`; `render.ts` prints a Projects section between Experience and Education. (4) `structureIssues` rejects an Experience heading that cites no `role-` claim, a Projects heading that cites one, and any resume missing an `always_include` claim. The prompt marks those claims [REQUIRED] and states the section rule.

Preventive control: `tests/unit/claims-data.test.ts` fails when the stated tenure no longer matches elapsed time since the start date, forcing an update instead of silent drift.

Regression test: `tests/integration/drafting.test.ts` ("resume sections and required claims", four cases); `tests/unit/claims-data.test.ts`.

Impact: Resumes already submitted carry the old tenure and structure. No other effect.

Remaining risks: The `role-` prefix is a naming convention; a new employment claim without it will be rejected from Experience (fails loudly, which is the intended direction). Voice review still runs when only the structure check fails, spending one extra review call per such draft.
