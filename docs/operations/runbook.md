# CAS operations runbook

## Environments

| CAS_ENV | Database | Use |
|---|---|---|
| test | in-memory | `npm test`. A guard refuses any path named `cas.db` or the prod path. |
| dev | `data/cas-dev.db` | Local experiments, live discovery while building. |
| prod | `data/cas.db` | The real pipeline (launchd from Session 4). |

Set `CAS_ENV` in `.env` or per command. `data/` is git-ignored.

## Commands

```
npm run verify                      # typecheck + all tests (run after every change)
CAS_LIVE_SMOKE=1 npm test           # adds one read-only live request per ATS
npm run cas -- migrate              # create/upgrade the DB
npm run cas -- discover             # all companies in config/companies.yaml (about 12 min)
npm run cas -- discover --only vercel,linear
npm run cas -- discover --no-detail # skip Greenhouse per-job requests (faster; no pay/questions)
npm run cas -- reevaluate           # re-run eligibility offline after editing config/eligibility.yaml
npm run cas -- stats                # counts by state, lane, company
npm run cas -- show <id>            # one posting: verdict, reasons, flags, events
npm run cas -- companies            # board health per company
```

## Daily use (about 15 minutes)

1. `npm run ui` (production data) and open http://127.0.0.1:4780. For dev data: `CAS_ENV=dev npm run cas -- serve`.
2. Queue: for each READY_FOR_REVIEW item, read the facts, score, resume, and form plan. Answer any required questions, then Approve, Reject, Defer, or Request revision (revisions are re-drafted on the next `draft` or daily run).
3. NEEDS_ATTENTION items: employer AI-use policies and failed drafts. Proceed (with a recorded reason) or Skip.
4. APPROVED items: "Open application in browser". CAS fills approved fields and uploads the resume PDF, then stops. Complete anything left (declarations, demographic questions are yours, CAPTCHAs), and click submit yourself. CAS marks SUBMITTED only when it sees a confirmation page; otherwise SUBMISSION_UNCERTAIN, which you resolve from the item page with the confirmation email text.
5. Pipeline view: set RECRUITER_RESPONSE / INTERVIEW_REQUESTED / REJECTED etc. as replies arrive.

## Scheduled job

- Installed by `scripts/install-launchd.sh` as `~/Library/LaunchAgents/<label>.plist`, `CAS_ENV=prod`. Label: `CAS_LAUNCHD_LABEL` in `.env` (default `com.cas.daily.<username>`).
- Runs at 06:30 and at login (catch-up after sleep or downtime). `cas daily` skips if a successful daily run already happened today; the `daily` lease blocks overlap.
- Sundays it also writes `data/reports/weekly-YYYY-MM-DD.md` (also shown at /report).
- Logs: `data/logs/daily.log`, `data/logs/daily.err.log`.
- Status: `launchctl print gui/$(id -u)/<label> | grep -E "state|last exit"`.
- Run now: `launchctl kickstart gui/$(id -u)/<label>` (or `CAS_ENV=prod npm run cas -- daily --force`).
- Remove: `launchctl bootout gui/$(id -u)/<label> && rm ~/Library/LaunchAgents/<label>.plist`.

## Changing eligibility rules

1. Edit `config/eligibility.yaml` (user decision; the system never edits it).
2. `npm run verify`
3. `npm run cas -- reevaluate`. Only INELIGIBLE and QUALIFIED postings are re-run. NEEDS_ATTENTION holds are never released by the system.

## Concurrency and restarts

- Every run takes a DB lease (`leases` table). A second concurrent run records `skipped` in `runs` and exits.
- A crashed run's lease expires (discover: 2 h) and the next run takes over.
- Each posting is processed in its own transaction, so an interrupted run leaves no half-written posting. The next run continues from the stored state.

## Database safeguards

- WAL mode, foreign keys on, `busy_timeout` 5 s.
- `events` is append-only (UPDATE/DELETE triggers abort).
- Backup (until Tier 2 backup/restore): `sqlite3 data/cas.db ".backup data/backup-$(date +%F).db"`.

## Board failures

`npm run cas -- companies` shows `last_fetch_status`. `not_found` usually means the employer moved ATS: find the new board and update `config/companies.yaml`. Failed boards never close postings.
