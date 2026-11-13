Observed failure: Found on Nov 13 while tracing how postings reach SUBMITTED. When the authorization gate refused a submission started from the UI, the page showed nothing. The posting stayed APPROVED with no submission record, and the only trace of the reason was a log line.

Expected behavior: Clicking Submit on an approved item either opens the employer form or shows why it was refused (for example "materials changed after approval; approve again").

Actual behavior: The route redirected back to the item page as if nothing had happened.

Root cause: The `/p/:id/submit` route started `assistedSubmit()` as a background task and waited 300 ms "so refusals show up on the page". `authorize()` runs inside that async function, so a refusal became a rejected promise. The route's `.catch` only logged it, and the route's own try/catch, which renders `AuthorizationError` on the page, never saw it. The 300 ms wait did nothing useful.

Evidence: Code reading of `src/ui/server.ts` (submit branch) and `src/apply/submit.ts` (`assistedSubmit` calls `authorize` first). The new regression test failed against the old route: it got a 303 redirect instead of a 400 with the reason.

Impact: No known case in production. All 17 approvals in `data/cas.db` reached a SUBMITTING state, so none were silently refused. Posting 6234 has been APPROVED since Oct 27 because the user resolved it "not sent" twice, not because of this bug.

Correction: The route calls `authorize()` synchronously before starting the background task. A refusal now throws into the route's handler and is shown on the item page with status 400. `assistedSubmit()` still checks the gate itself before opening anything; the gate logic is unchanged.

Preventive control: Errors that should reach the user are raised before starting work in the background, not inside it.

Regression test: `tests/integration/apply.test.ts` ("submit route (regression: incident 2026-11-13)").

Remaining risks: A refusal that only becomes true between the route's check and the background task's check (a narrow race, such as materials re-drafted at that moment) is still only logged. The posting then stays APPROVED and nothing is sent, so it fails safe.
