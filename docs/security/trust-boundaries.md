# Trust boundaries

## Untrusted inputs
| Input | Where it enters | Handling |
|---|---|---|
| ATS JSON (Greenhouse, Lever, Ashby) | `src/discovery/adapters.ts` | Parsed with zod; malformed responses fail the board, not the run. HTML converted to text. Stored raw in `posting_snapshots` for evidence only. |
| Posting text (descriptions, questions, disclaimers) | eligibility rules, later LLM stages | Deterministic rules read it as data. Tested: injected instructions in a description cannot change a verdict (`tests/unit/rules.test.ts`). LLM stages (Session 3) receive it inside delimiters, with no tools. |
| Application forms (Session 4) | Playwright | Fills only approved fields. Stops at submit, attestations, CAPTCHA, EEO. |
| Model output (Session 3) | drafting, scoring | Untrusted until it passes zod and the claim validator. One retry, then NEEDS_ATTENTION. |

## Authority
- No external content can authorize an action. Approval, rejection, deferral, release of NEEDS_ATTENTION holds, and resolution of SUBMISSION_UNCERTAIN are user-only transitions enforced in `src/pipeline/states.ts`.
- All state changes go through `transition()`, which checks legality and actor and writes an immutable event.

## Approval UI (Session 4)
- Binds to 127.0.0.1 only. Requests whose Host header is not `127.0.0.1:<port>` or `localhost:<port>` get 421 (DNS-rebinding defense).
- Every form carries a per-process random token; POSTs without it, or with a foreign Origin, get 403 (CSRF defense).
- All posting text is HTML-escaped; CSP `default-src 'none'` blocks scripts entirely; posting links render only for https URLs.
- Tested in `tests/integration/apply.test.ts`.

## Assisted submission
- Only reachable from APPROVED, through `authorize()`: latest approval must match the current material hash; if the claims file changed, the draft is re-validated; every required question must have an approved or user-supplied answer; the role's idempotency key must be unused.
- The browser uses a dedicated profile (`data/browser-profile/`), fills only approved values, uploads the approved PDF, and never clicks submit, checks declarations, answers demographic questions, or solves CAPTCHAs.
- SUBMITTED requires a confirmation page that appeared after the form (URL change or form gone, plus confirmation wording not present before). Otherwise SUBMISSION_UNCERTAIN, resolved only by the user. No automatic retry.

## Secrets
- From the environment (`.env`, git-ignored) only. Never in CLAUDE.md, logs, or the DB.
- Logs pass through redaction (emails, phone numbers, `sk-ant-` keys).

## Network exposure
- Outbound only, to the three public ATS APIs (and the Anthropic API from Session 3).
- The UI (Session 4) binds to 127.0.0.1:4780 only.

## Isolation from Link
- No reads or writes to the owner's other self-hosted system: its folder, database, credentials, launch agents, or Cloudflare config.
