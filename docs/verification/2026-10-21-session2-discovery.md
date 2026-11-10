# Session 2 verification (Oct 21, 2026)

## Automated
`npm run verify`: typecheck clean, 131 tests passing, 1 skipped (opt-in live smoke test).

Covered (spec section 14, Tier 1): salary parsing, remote classification, eligibility rules, deduplication, state transitions, user-only authorization of transitions, prod-DB guard, log redaction. Failure tests: missing compensation, contradictory remote policy, duplicate posting, expired listing (deadline and removed from board), malformed board response, prompt-injection text in a description (deterministic rules), duplicate scheduler run (lease), crashed-run lease takeover. Not yet applicable: malformed LLM output, interrupted submission (Sessions 3-4).

## Live (dev DB, read-only against public boards)
- Full discovery over 46 companies: all boards fetched after retry fix; 6,341 postings stored with snapshot, source URL, and retrieval timestamp.
- Second full pass: 0 duplicates created, unchanged postings untouched, changed postings re-evaluated, 4 removed listings closed.
- After final rules: 239 QUALIFIED, 18 NEEDS_ATTENTION (employer AI-use policy, awaiting user), 6,080 INELIGIBLE, across 34 companies with at least one eligible posting.
- Among eligible: 75 with unknown compensation (kept, flagged), 16 with 4+ office days (flagged OFFICE_DAYS_HIGH).
- 109 postings rejected for an active clearance requirement.
- One full run takes about 12 minutes, mostly Greenhouse per-job detail requests at 1 request per second.

## Manual spot checks
Random samples of qualified postings were checked against their locations, pay, and flags. Defects found and fixed during the session: pay basis misread from "Total compensation may also include" (Palantir), "Remote - AMER" not recognized, Ashby isRemote overriding Hybrid (incident record), clearance stated only in the title, and non-engineering titles containing "engineering". Each has a regression test.

## Gaps
- The hand-labeled set (`fixtures/labeled/label-me.yaml`) awaits the user. Until labeled, accuracy is measured only by spot checks.
- Classification of bare "Remote" with no country (REMOTE_UNSPECIFIED) is kept and flagged, not resolved.
