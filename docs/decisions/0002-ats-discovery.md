Decision: Discovery via Greenhouse, Lever, and Ashby public posting APIs, with Greenhouse per-job enrichment.

Context: Spec section 7 proposes public ATS JSON endpoints driven by `config/companies.yaml`. Phase 0 probes (see `docs/verification/2026-10-21-phase0-environment.md`) confirmed all three are live and unauthenticated.

Alternatives considered:
1. List endpoints only.
2. List endpoints plus Greenhouse per-job fetch (`pay_transparency=true&questions=true`) for postings that pass title and location prefilters.
3. HTML scraping or aggregator sites (LinkedIn, Indeed). Rejected: terms, access controls, fragility.

Trade-offs: Option 2 adds one request per candidate Greenhouse posting, but returns structured base pay and the full application question list. The question list lets CAS check every question against approved standard answers before drafting, so unsupported questions route to NEEDS_ATTENTION early instead of during submission.

Selected approach: Option 2.
- Greenhouse: list, prefilter, then per-job enrichment. Pay from `pay_input_ranges`; fall back to description parsing. A range whose blurb mentions OTE or commission is not treated as base.
- Lever: list only. Pay parsed from description text (no `salaryRange` seen in samples). 404 marks the company config as stale.
- Ashby: list with `includeCompensation=true`. Skip `isListed=false`.
- Once daily, sequential requests, 1 s spacing, User-Agent identifying the tool, raw snapshot stored per posting.

Reasoning: Structured data beats parsing; early question checks protect the attention budget.

Risks: Employers move ATS (seen: plaid off Lever). Undocumented rate limits. Greenhouse `pay_input_ranges` may hold OTE for sales roles. Companies using Workday or custom ATS are out of reach in Tier 1.

Verification: Recorded fixtures for each ATS; one live read-only smoke test; config health check flags 404 boards.

Date: 2026-10-21
