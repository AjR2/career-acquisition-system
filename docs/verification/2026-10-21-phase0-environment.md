# Phase 0 environment investigation (Oct 21, 2026)

Read-only. No existing application was modified.

## Host
- macOS 26.6.2 (25G83), Apple Silicon (arm64), 24 GB RAM, 911 GB free.
- Node v22.19.0 (nvm), npm 10.9.3. No pnpm, no tsx (will be dev dependencies).
- git 2.50.1, gh 2.71.2, sqlite3 3.51.0, Python 3.14.3, Homebrew 7.0.9.
- Playwright Chromium build 1228 already in `~/Library/Caches/ms-playwright`. Playwright package will be a project dependency. (`npx playwright` without a local install hung; do not rely on a global install.)
- launchd available. User LaunchAgents present: Adobe, watchman, Google, OpenAI Atlas, Homebrew mongodb/neo4j/postgresql. No `cas` or `career` labels. No Link launch agent observed on this machine.
- Ports in use on localhost include 5000/7000 (macOS AirPlay), 5432, 7474/7687, 27017, 9151. **4780 is free** and reserved for CAS.

## Credentials (presence only)
- `ANTHROPIC_API_KEY`: not set in the environment or shell rc files. LLM stages BLOCKED until a dedicated key is supplied.

## Link
- The owner's other self-hosted system lives in a separate folder. Not opened or inspected beyond confirming the path. CAS uses none of its resources.

## ATS endpoints (live probes, Oct 21)

| ATS | Endpoint | Result | Notes |
|---|---|---|---|
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | 200 (anthropic 674 jobs, vercel 95) | No structured pay on list endpoint |
| Greenhouse | `GET .../jobs/{id}?pay_transparency=true&questions=true` | 200 | `pay_input_ranges` (min/max cents, currency, title, blurb). Full application question list, `compliance`, `demographic_questions`. |
| Lever | `GET api.lever.co/v0/postings/{site}?mode=json` | 200 (palantir 306); 404 for a site no longer on Lever | `salaryRange` absent on all sampled postings; parse description. `workplaceType`, `categories.commitment`. |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` | 200 (openai 808, linear 29) | Structured `compensation` tiers; `workplaceType`, `employmentType`, `isRemote`, `isListed`. |

## Terms
- Greenhouse docs: "Job Board data is publicly available, so authentication is not required for any GET endpoints." Programmatic application POST requires the employer's secret API key.
- Lever docs: GET examples are unauthenticated; published postings "may be scraped by third parties." Apply POST requires an employer API key.
- Ashby docs: unauthenticated; intended to populate careers pages. `isListed=false` jobs should only be reachable by direct link (CAS skips them).
- None of the three documents rate limits or a restriction on third-party reads. Conclusion: reading is acceptable at low volume (once daily, sequential, cached, identifying User-Agent). Applying through the APIs is not available to us; assisted submission through the employer's hosted form is the only legitimate path. This is not legal advice.
