# Career Acquisition System (CAS)

CAS finds job postings on public Greenhouse, Lever, and Ashby boards, filters them against hard rules written as deterministic code, ranks the rest, and drafts a tailored resume for the best matches using only facts the user has confirmed. Nothing leaves the machine without explicit human approval, and the user always clicks submit.

## How it works

- **Discovery:** polite fetchers for each job board's public API, with deduplication and retry handling (`src/discovery/`).
- **Eligibility:** salary (base vs. total compensation), remote vs. hybrid, office days, and clearance are code with tests, not model calls (`src/eligibility/`).
- **Suitability:** a model analyzes each posting; scoring weights live in config (`src/suitability/`).
- **Drafting:** the model may only cite claims from an approved-claims ledger. Every draft is schema-validated, then checked by deterministic validators: every number and technology must trace to a cited claim, banned phrases fail, sections and required claims are enforced. One retry with the errors fed back, then the item is held for review (`src/drafting/`, `src/validate/`).
- **Trust boundaries:** job postings are untrusted input, passed to the model as delimited data with no tools. Tests confirm injected instructions can change neither eligibility verdicts nor what a draft may claim (`docs/security/trust-boundaries.md`).
- **Human approval:** approve, reject, and release are user-only state transitions enforced in code (`src/pipeline/states.ts`).
- **Spend:** every model call is logged with its cost, and a daily cap is enforced in code (`src/llm/client.ts`).

Design decisions are in `docs/decisions/`. Every defect gets an incident record with root cause, preventive control, and regression test in `docs/incidents/`.

## Setup

Requires macOS (scheduling uses launchd; everything else also runs on Linux), Node.js 22.12+, and an Anthropic API key.

```
git clone <this repo>
cd career-acquisition-system
./scripts/setup.sh
```

`scripts/setup.sh` installs dependencies, creates your personal files from the templates below (it never overwrites existing ones), asks for your API key, and creates the database.

### Personal files you create

These hold your own data and are git-ignored. Setup makes each one from its template; edit them before your first run.

| File | Template | What goes in it |
|---|---|---|
| `.env` | `.env.example` | API key, models, daily spend cap |
| `config/eligibility.yaml` | `config/eligibility.example.yaml` | Salary floor and target, home city, commute area, clearance status |
| `config/target.yaml` | `config/target.example.yaml` | The kind of role you want (or run the setup walkthrough) |
| `config/preferences.yaml` | `config/preferences.example.yaml` | Work you'd rather avoid, target titles |
| `config/companies.yaml` | `config/companies.medical.yaml` | The job boards to watch (starts as a healthcare starter list; the setup walkthrough can replace it) |
| `config/standard-answers.yaml` | `config/standard-answers.example.yaml` | Answers to recurring application questions |
| `config/profile.local.yaml` | `config/profile.example.yaml` | Name and contact details for the resume header |
| `career-evidence/approved-claims.yaml` | `career-evidence/approved-claims.example.yaml` | Every fact a draft may state, with evidence and status (starts empty) |
| `career-evidence/voice-profile.md` | `career-evidence/voice-profile.example.md` | How you write |
| `CLAUDE.md` | `CLAUDE.template.md` | Instructions for Claude Code in your copy |

Your resume, writing samples, database, logs, and generated materials stay in `career-evidence/profile/`, `career-evidence/writing-samples/`, and `data/`, which are also git-ignored.

The full step-by-step guide, including the claims interview and the daily schedule, is in `ONBOARDING.md`.

## Tests

```
npm run verify   # typecheck and the full test suite
```

Tests use frozen configs in `tests/config/` and recorded fixtures in `fixtures/`, so they pass on a fresh clone without any personal files.

The evaluation tests in `tests/eval/` score the classifier against a hand-labeled set of real postings (`fixtures/labeled/`). That set stays local because it reflects one user's company list and judgments; generate your own with `npm run cas -- labelset` and the eval tests run automatically when it exists.
