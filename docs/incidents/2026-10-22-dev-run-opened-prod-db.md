Observed failure: `CAS_ENV=dev npm run cas -- score` opened and migrated `data/cas.db` (the production path) instead of `data/cas-dev.db`.

Expected behavior: dev commands use the dev database; only `CAS_ENV=prod` touches `data/cas.db`.

Actual behavior: a new empty production database was created and one empty scoring run was recorded in it. No postings, no model calls, no data loss. Discovered immediately because the score run found 0 candidates and the follow-up query hit a database without the new columns.

Root cause: `.env` was created from `.env.example`, which set `CAS_DB_PATH=./data/cas.db`. An explicit `CAS_DB_PATH` overrides the per-environment default, so dev resolved to the prod file. The guard only blocked the prod path under tests.

Evidence: `data/cas.db` contained 0 postings, 1 run, 0 llm_calls; deleted after inspection.

Correction: removed `CAS_DB_PATH` from `.env` and `.env.example` (the path now always derives from `CAS_ENV`). `assertDbAllowed` now refuses to open the production database unless `CAS_ENV=prod`.

Preventive control: the guard runs in `openDb()` for every command and test.

Regression test: `tests/unit/pipeline.test.ts` ("dev cannot open the production database").

Remaining risks: a deliberately set `CAS_DB_PATH` with a different filename is still honored; acceptable for explicit overrides.
