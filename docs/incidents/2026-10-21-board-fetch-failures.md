Observed failure: First full discovery run (46 companies, Oct 21 2026 18:47 UTC) reported 23 of 46 boards as failed with status 0.

Expected behavior: All reachable public boards are fetched; a transient network problem is retried.

Actual behavior: 23 boards failed within about 1 second each, in two clusters. The run still succeeded for the other 23 and correctly closed nothing for failed boards.

Root cause: Not fully established. The fetcher swallowed the exception and returned status 0 with no message, so the cause was lost. Direct requests to the same boards moments later returned 200, which points to a transient network condition on the host. Contributing defects: no retry, a 30 s timeout too short for large boards (the largest board is about 14 MB), and no error detail.

Evidence: run 1 stats in `data/cas-dev.db` (`runs` table) and the run log; curl to two of the failed boards returned 200 in under 0.5 s; re-running three failed boards with the fixed fetcher succeeded (1,097 postings).

Correction: `src/discovery/http.ts` now returns the network error message (`FetchResult.error`), retries network errors, 429, and 5xx twice with 5 s and 10 s backoff, and uses a 60 s timeout. Adapters include the network error text in the board failure.

Preventive control: Board failures are recorded per company (`companies.last_fetch_status`, `board_fetch_failed` events) and never close postings. Planned for Session 4: the weekly report and the daily run summary list failed boards so a silent partial run cannot pass unnoticed.

Regression test: `tests/integration/discover.test.ts` ("a failed board (404, network, malformed JSON) is recorded and closes nothing").

Remaining risks: If the host network is down for the whole retry window (about 15 s), the board is skipped until the next daily run. Acceptable at daily cadence.
