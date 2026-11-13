Observed failure: The user could not reject a posting after approving it. Approved postings that the user no longer wanted to apply to stayed in the Approved list indefinitely, and so did postings whose submission was uncertain but known not to have been sent.

Expected behavior: Before anything is sent, the user can withdraw an approval and reject the posting. For an uncertain submission, the user can do the same after confirming it was not sent.

Actual behavior: APPROVED could only go to SUBMITTING or back to READY_FOR_REVIEW, and the move back had no function or button. SUBMISSION_UNCERTAIN could only go to SUBMITTED or APPROVED. Neither state could reach USER_REJECTED, from the UI or otherwise.

Root cause: The state machine allowed "withdraw approval" only as a return to review (APPROVED -> READY_FOR_REVIEW), and that was never wired to code. The SUBMISSION_UNCERTAIN design only considered "it was sent" and "try again".

Evidence: `src/pipeline/states.ts` transition table and USER_ONLY set before this change; no caller of APPROVED -> READY_FOR_REVIEW anywhere in `src/`. Affected in production: one APPROVED posting (since Oct 27) and two SUBMISSION_UNCERTAIN postings (since Nov 10).

Correction: New user-only transitions APPROVED -> USER_REJECTED and SUBMISSION_UNCERTAIN -> USER_REJECTED, through `withdrawApproval()` in `src/apply/decide.ts` and a "Withdraw approval" button on the item page for both states. From SUBMISSION_UNCERTAIN the form requires the box "I confirm this application was not sent". The function refuses without it, and then removes the uncertain submission record, as "It was not sent" does. The system can never make either move. SUBMITTING and SUBMITTED still cannot become USER_REJECTED. The decision is recorded as a `reject` with the note "withdrew approval ...", and the event records the previous state.

Preventive control: Every state the user can park a posting in needs a user exit, and every transition in the table needs a caller or a comment saying why it has none.

Regression tests: `tests/unit/pipeline.test.ts` ("withdrawing an approval ... is user-only") and `tests/integration/apply.test.ts` ("withdraw approval (incident 2026-11-13-no-withdraw-approval)").

Remaining risks: If the user confirms "not sent" for an application that was actually sent, the posting leaves the pipeline and an employer reply would not be tracked. The user can restore it (USER_REJECTED -> QUALIFIED), but the original submission record is gone. APPROVED -> READY_FOR_REVIEW still has no button.
