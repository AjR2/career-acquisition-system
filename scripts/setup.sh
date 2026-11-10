#!/bin/zsh
# First-time setup for a new CAS install. Safe to re-run: never overwrites existing personal files.
# Non-interactive (CI or testing): CAS_SETUP_NONINTERACTIVE=1 ./scripts/setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
say() { print -P "%F{cyan}==>%f $1"; }

say "Checking Node.js"
command -v node >/dev/null || { echo "Node.js 22.12+ is required: https://nodejs.org"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12)){console.error("Node 22.12+ required, found "+process.versions.node);process.exit(1)}'

say "Installing dependencies"
npm ci --no-audit --no-fund
say "Installing the Chromium browser used for PDFs and form filling"
npx playwright install chromium

copy_if_missing() { [[ -e "$2" ]] && echo "   keep  $2" || { cp "$1" "$2"; echo "   made  $2"; }; }
say "Creating your config files from templates (existing files are kept)"
copy_if_missing config/eligibility.example.yaml      config/eligibility.yaml
copy_if_missing config/target.example.yaml           config/target.yaml
copy_if_missing config/preferences.example.yaml      config/preferences.yaml
copy_if_missing config/standard-answers.example.yaml config/standard-answers.yaml
copy_if_missing config/companies.medical.yaml        config/companies.yaml
copy_if_missing config/profile.example.yaml          config/profile.local.yaml
copy_if_missing career-evidence/voice-profile.example.md career-evidence/voice-profile.md
copy_if_missing CLAUDE.template.md                    CLAUDE.md
mkdir -p career-evidence/writing-samples career-evidence/profile data
if [[ ! -e career-evidence/approved-claims.yaml ]]; then
  # Start empty (plus the one prohibition). Example claims are fictional and never copied.
  cat > career-evidence/approved-claims.yaml <<'YAML'
# Your confirmed claims. See approved-claims.example.yaml for the format and ONBOARDING.md step 4.
claims:
  - id: no-hand-written-code
    claim_text: "Any statement that I hand-wrote code that a coding agent generated."
    evidence: "Policy."
    source_location: "policy"
    status: PROHIBITED
    dates: always
    permitted_use: []
YAML
  echo "   made  career-evidence/approved-claims.yaml (empty)"
fi

if [[ ! -e .env ]]; then
  cp .env.example .env && chmod 600 .env
  echo "CAS_LAUNCHD_LABEL=com.cas.daily.$(whoami)" >> .env
  if [[ -z "${CAS_SETUP_NONINTERACTIVE:-}" ]]; then
    say "Anthropic API key (input hidden; stored only in .env). Press Enter to skip for now."
    read -rs "KEY?Key: "; echo
    if [[ -n "$KEY" ]]; then
      KEY_VALUE="$KEY" node -e 'const fs=require("fs");const p=".env";fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^ANTHROPIC_API_KEY=.*$/m,"ANTHROPIC_API_KEY="+process.env.KEY_VALUE));'
      echo "   key saved to .env"
    fi
    unset KEY
  fi
else
  echo "   keep  .env"
fi

say "Creating the development database"
CAS_ENV=dev npx tsx src/cli.ts migrate

if [[ -z "${CAS_SETUP_NONINTERACTIVE:-}" ]]; then
  say "Job target walkthrough: about 20 questions on the jobs you want (titles, pay, location, companies)"
  read -r "RUNWT?Run it now? [Y/n] "
  if [[ ! "$RUNWT" =~ ^[Nn] ]]; then
    CAS_ENV=dev npx tsx src/cli.ts setup-target
  else
    echo "   skipped. Run it any time with: npm run cas -- setup-target"
  fi
fi

say "Running the test suite"
npm test --silent

cat <<'MSG'

Setup complete. Easiest next step: double-click "Start CAS" and follow the Get started page.
Or by hand (see ONBOARDING.md):
  1. If you skipped it: npm run cas -- setup-target   (the jobs you want)
     Then edit config/profile.local.yaml and config/standard-answers.yaml
  2. Build your claims (Claude Code: "Run the CAS claims interview ...")
  3. Add writing samples and fill career-evidence/voice-profile.md
  4. CAS_ENV=dev npm run cas -- discover    then  score  then  draft  then  serve
  5. When happy: ./scripts/install-launchd.sh   and   npm run ui
MSG
