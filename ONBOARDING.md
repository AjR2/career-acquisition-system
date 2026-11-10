# Career Acquisition System (CAS): setup guide

CAS finds job postings in your field on public Greenhouse, Lever, and Ashby job boards, filters
them against your hard rules, ranks them, drafts a tailored resume for the best ones **using only facts
you have confirmed**, and helps you apply. **Nothing is sent without your explicit approval, and you
always click submit yourself.**

Plan on about an hour for first setup, most of it spent on your experience list (step 4).

## Easiest way (no Terminal needed)

Double-click **Start CAS**. It installs everything on first start, then opens the **Get started**
page in your browser, which walks you through every step below with forms: API key, the jobs you
want, contact details, your experience (paste your resume and confirm each statement), finding jobs,
and turning on the daily search. See `START HERE.txt` if your Mac blocks the file.

The rest of this guide is the same setup done by hand, for people comfortable with a terminal.

## What you need

- A Mac (scheduling uses launchd; everything else also runs on Linux).
- Node.js 22.12 or newer (`node -v`).
- An Anthropic API key, ideally in its own workspace with a monthly spending limit
  (console.anthropic.com → Settings → Workspaces). Typical cost: about $1 a week.
- Recommended: Claude Code, to run the claims interview and fill your voice profile.

## 1. Install

```
tar -xzf career-acquisition-system-*.tar.gz
cd cas
./scripts/setup.sh
```

The setup script installs dependencies and the browser, creates your config files from templates,
asks for your API key (input hidden; stored only in `.env`, which git ignores), creates the database,
offers the job target walkthrough (step 2), and runs the test suite.

## 2. The jobs you want: the walkthrough

CAS starts out set up for AI software engineering. The walkthrough changes that to your field. It asks
about 20 questions, one at a time:

- what kind of job you want, the titles you would apply for, and words that rule a title out
- kinds of work you would rather avoid, and what makes a team a great fit for you
- your strongest skills, years of experience, and target seniority
- minimum and target base salary
- your home city, whether remote roles are OK, and the places you could commute to
- whether you hold an active security clearance
- companies to watch (it checks which public job board each one uses)

It shows a summary and asks before writing anything. It writes `config/target.yaml` and updates
`config/eligibility.yaml`, `config/preferences.yaml`, `config/tech-terms.yaml`, and
`config/companies.yaml`, saving a backup of each (ending in `.bak-YYYYMMDD`). Run it again any time:

```
npm run cas -- setup-target
npm run cas -- reevaluate        # re-apply the rules to postings already found
npm run cas -- score --rescore   # re-rank with the new target
```

The hard filters (salary, location, clearance, titles) are applied by code with no AI involved.
Unknown pay is kept, never invented. You can also edit any of these files by hand.

## 3. Your profile and answers

- `config/profile.local.yaml`: name and contact details for the resume header and form filling (git-ignored).
- `config/standard-answers.yaml`: answers to recurring questions (work authorization, sponsorship,
  relocation...). Only answers you mark `USER_CONFIRMED` are ever filled in.

## 4. Your claims: `career-evidence/approved-claims.yaml` (most important)

Every fact in a drafted resume must trace to a claim in this file, including every number and every
technology. Drafting stays off until you have at least 5 confirmed claims.

Easiest way: open this folder in Claude Code and say:

> Read ONBOARDING.md and CLAUDE.md. Run the CAS claims interview: start from my resume
> (I'll paste it), ask me one question at a time to confirm each claim, and record my answers
> in career-evidence/approved-claims.yaml as USER_CONFIRMED. Never add anything I didn't confirm.

See `career-evidence/approved-claims.example.yaml` for the format (fictional examples; do not copy them).

## 5. Your voice: `career-evidence/voice-profile.md`

Put 5 or more things you wrote yourself in `career-evidence/writing-samples/` (git-ignored), state
your writing rules in section 1, and ask Claude Code to fill in the rest from the samples.

## 6. Companies and preferences

- `config/companies.yaml`: the job boards to watch. The shared version starts with 48 healthcare employers
  (`config/companies.medical.yaml`); the setup can replace or extend it. Each company needs its board type and token (the walkthrough finds these).
- `config/preferences.yaml`: soft ranking preferences, such as kinds of roles you keep rejecting.

## 7. First run (development data)

```
CAS_ENV=dev npm run cas -- discover     # about 12 minutes; free
CAS_ENV=dev npm run cas -- score        # about $0.10
CAS_ENV=dev npm run cas -- draft        # about $0.06 per resume, 4 a day max
CAS_ENV=dev npm run cas -- serve        # review screen at http://127.0.0.1:4780
```

## 8. Go live

```
./scripts/install-launchd.sh            # daily run at 06:30 and at login (production data)
npm run ui                              # review screen for production data
```

Daily routine (about 15 minutes): open the review screen, approve, reject, or revise drafts. For
approved items, click "Open application in browser": CAS fills approved fields and uploads the
resume, then stops. You finish anything flagged in the yellow banner and click submit. Record
replies in the Pipeline tab. A weekly report appears every Sunday.

## Safety rules built in

- Only facts from confirmed claims; no invented metrics, titles, or years.
- Job postings are treated as untrusted input and cannot instruct the system.
- Never answers demographic (EEO) questions, never checks agreement boxes, never clicks submit.
- Daily model spending cap ($3 by default, `CAS_DAILY_SPEND_CAP_USD` in `.env`).
- The review screen only listens on your own machine.

More detail: `docs/operations/runbook.md`, `docs/security/trust-boundaries.md`, `CLAUDE.md`.
