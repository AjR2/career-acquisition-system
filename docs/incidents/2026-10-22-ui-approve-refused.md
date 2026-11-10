Observed failure: Clicking Approve on the item showed "cross-origin request refused". The user's answers were lost and nothing was approved.

Expected behavior: A form posted from the CAS page itself is accepted.

Actual behavior: The server rejected the POST with 403.

Root cause: The UI sent `Referrer-Policy: no-referrer`. With that policy Chrome sends `Origin: null` on form submissions, and the CSRF check correctly refuses a null or foreign Origin. The tests posted with fetch (no Origin header), so they never exercised a real browser.

Evidence: User screenshot of /p/1706/approve; decisions table had 0 rows; posting stayed READY_FOR_REVIEW.

Correction: `Referrer-Policy: same-origin`, so the browser sends the real origin for same-site posts and nothing for cross-site ones. The Origin check is unchanged (null and foreign origins are still refused).

Preventive control: UI changes are verified with a real browser, not only HTTP calls.

Regression test: `tests/integration/apply.test.ts` ("approving through the actual form works").

Remaining risks: Other browsers may differ; Chrome and Chromium are the ones in use.
