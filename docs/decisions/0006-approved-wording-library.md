# 0006: Approved wording library

Context: Drafts for different postings cited mostly the same claims (median 59% claim overlap; 8 claims in every draft) but reworded them from scratch each time (median 31% text similarity). Every draft needed a full re-read, applications to the same company read inconsistently, and each rewrite was a new chance for a rule violation.

Decision: Approving a resume saves the exact text of each experience and project bullet, keyed by the sorted set of claim IDs it cites (`approved_wording` table, `src/evidence/wording.ts`). New drafts receive the approved wording in the prompt and must reuse it verbatim; a deterministic structure check rejects a bullet that cites an approved claim set with different text (spacing and a trailing period are ignored). The model still chooses which bullets to include, their order, the summary, and wording for claim sets that have none. The review page lists only the summary and new lines.

Editing: Revisions (the user's "Request revision" note) run in prefer mode: approved wording is offered but not enforced, so a note can change a line, and approving the revision replaces the stored wording. Editing a claim in approved-claims.yaml makes its stored wording stale (fingerprint of the cited claims' text and dates), so it is drafted fresh and reviewed again.

Trade-offs: Less variation between postings. Wording that fit one posting is reused for all; the summary and bullet selection carry the tailoring. Latest approval wins per claim set. Bullets that break a current rule (for example a pronoun) are never stored.

Verification: `tests/integration/wording.test.ts`.
