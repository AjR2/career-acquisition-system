Decision: Tier 1 architecture. Spec section 7 defaults, with the adjustments below. STATUS: APPROVED by user, 2026-10-21.

Context: Single user, single Mac, roughly 50 qualified opportunities a week, 15-minute daily attention budget, hard deadline Nov 1. Phase 0 found no contrary evidence to the defaults.

Alternatives considered: Postgres instead of SQLite (rejected: one machine, one user; revisit only for multi-machine). Persistent agent processes (rejected: harder to debug, no benefit at this volume). Anthropic Batch API for 50% off (deferred: cost is already low; adds up to 24 h latency and polling logic).

Trade-offs: SQLite gives zero ops and simple backups but no concurrent writers, which the run lease handles. Haiku for classification is very cheap but must be checked against the hand-labeled fixtures.

Selected approach: all section 7 defaults confirmed, plus:
1. Greenhouse per-job enrichment for structured pay and question lists (decision 0002).
2. Submission only through employer-hosted forms. Greenhouse and Lever application APIs need the employer's secret key, so the Playwright assisted flow is the only path.
3. Playwright uses its own persistent profile in `data/browser-profile/`, never the user's Chrome profile.
4. Tier 1 confirmation: page text only. If not detected, state is SUBMISSION_UNCERTAIN; the user can resolve it in the Pipeline view by pasting confirmation evidence (for example, the confirmation email text), which is stored and logged.
5. Models: `claude-haiku-5-5` (classify/extract), `claude-sonnet-5-5` (draft, voice compare; user confirmed Sonnet over Opus 2026-10-21). Configurable. Daily spend cap default $3, enforced before each call from recorded usage.
6. Employer AI-use policies: Greenhouse exposes `ai_disclaimer`, and some forms ask about AI use (Anthropic's form has an "AI Policy for Application" question). CAS detects these and routes the application to NEEDS_ATTENTION with the policy text shown in the queue. User decides per posting (user decision 2026-10-21). CAS never drafts free text for such an application until the user chooses.
7. Port 4780 on 127.0.0.1. launchd label set per install in `.env` (`CAS_LAUNCHD_LABEL`).

Security boundaries (detail goes in `docs/security/trust-boundaries.md`, Session 2):
- Untrusted: posting JSON/HTML, employer pages, application forms, model output.
- Model output is data until it passes zod and the claim validator. The model has no tools.
- One authorization gate in code for every external action. Approval records are tied to an exact material version hash; changing materials voids approval.
- Secrets from env only. Logs redact email, phone, address, keys.
- Test runs refuse to start if `CAS_DB_PATH` points at the prod DB.
- Nothing listens on anything except 127.0.0.1.

Estimated model cost (about 50 qualified a week, about 215 a month):
| Stage | Model | Volume/month | Est. cost |
|---|---|---|---|
| Responsibility analysis (postings passing deterministic filters) | Haiku 5.5 | ~400 | < $0.50 |
| Suitability explanation | Sonnet 5.5 | ~215 | ~$4-6 |
| Resume + cover letter drafting | Sonnet 5.5 | up to 215 (realistically 40-80) | ~$5-20 |
| Voice comparison | Sonnet 5.5 | same | ~$2-6 |
| **Total** | | | **~$10-35/month** (~$25-70 if drafting uses Opus 5.5) |
Prompt caching on the stable prefix (claims, voice profile, rules) reduces input cost further.

Reasoning: Keeps the system small, deterministic where possible, and inside the deadline.

Risks:
1. Inputs (API key, resume, samples, standard answers) arrive late; LLM stages and the first application slip.
2. Greenhouse forms vary (custom questions, CAPTCHA, file upload widgets); assisted fill may need per-company handling.
3. Many target companies may use Workday or custom ATSs, which Tier 1 cannot reach.
4. Confirmation-page detection is heuristic; without Gmail, some submissions will land in SUBMISSION_UNCERTAIN.
5. Haiku misclassifying remote policy; mitigated by deterministic rules first and the labeled fixture set.
6. Weekday maintenance capacity is minimal; anything flaky consumes the attention budget.

Verification: Tier 1 acceptance criteria in spec section 12; unit, fixture, and failure tests in spec section 14.

Date: 2026-10-21
