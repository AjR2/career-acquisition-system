Observed failure: On Oct 23, 25, and 26 the scheduled run's model calls timed out. Oct 26 drafted nothing; 5 postings were held in NEEDS_ATTENTION as "resume failed validation twice: Request timed out". The Oct 25 run took about 10 hours.

Expected behavior: A transient failure (timeout, network) leaves the posting queued for the next run. NEEDS_ATTENTION is only for real validation failures and policy holds.

Actual behavior: Any two failed attempts were treated as validation failures. The scheduled job ran while the Mac was in maintenance DarkWake around 06:30 and the machine slept mid-request.

Root cause: (1) Failure handling did not distinguish transient errors from validation errors. (2) Nothing kept the Mac awake during the job. (3) A 2-minute request timeout was tight for Sonnet drafting with adaptive thinking.

Evidence: llm_calls errors "Request timed out." on 2026-10-23/25/26; pmset log shows DarkWake/Sleep cycles; run durations 1.5 h to 10 h for a job that takes about 15 minutes awake.

Correction: Transient-only failures (no draft produced) go back to QUALIFIED with a logged reason. The launchd job runs under `caffeinate -i -s`. Request timeout raised to 5 minutes. Also: drafting pauses while 8 or more drafts wait for review (`drafting.max_queue`), and the weekly report's contract lane lists engineering roles only.

Preventive control: `onlyTransientFailures()` gate before any NEEDS_ATTENTION transition from drafting.

Regression test: `tests/integration/drafting.test.ts` ("timeouts with no draft go back to QUALIFIED", "does not draft more while the review queue is full").

Remaining risks: With the lid closed on battery the Mac still sleeps; the run then catches up at next login. The 5 postings already held need the user to release them (the system may not release NEEDS_ATTENTION holds).
