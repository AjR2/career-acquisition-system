#!/bin/zsh
# Builds a shareable archive of CAS with no personal data: dist/career-acquisition-system-<date>-<sha>.tar.gz
# Packages the last commit (commit first). Refuses to finish if any personal marker is found.
set -euo pipefail
setopt NULL_GLOB
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes. Commit first so the package matches a known version."; exit 1
fi
echo "==> Running tests"
npm run -s verify >/dev/null

SHA="$(git rev-parse --short HEAD)"
NAME="career-acquisition-system-$(date +%Y%m%d)-$SHA"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/cas" dist
git archive HEAD | tar -x -C "$TMP/cas"
cd "$TMP/cas"

echo "==> Removing personal files"
rm -rf \
  career-evidence/approved-claims.yaml career-evidence/voice-profile.md \
  config/standard-answers.yaml config/eligibility.yaml config/preferences.yaml config/target.yaml \
  fixtures/labeled docs/incidents docs/verification docs/decisions
mv CLAUDE.template.md CLAUDE.md
# Recipient gets the healthcare starter list instead of the AI-company list.
cp config/companies.medical.yaml config/companies.yaml
# This script holds the owner's privacy markers (below); recipients do not need it.
rm -f scripts/package.sh
# Drop the section about the original owner's other system from the security notes.
python3 -I - <<'PY'
import re, pathlib
p = pathlib.Path("docs/security/trust-boundaries.md")
s = p.read_text()
s = re.sub(r"\n## Isolation from Link\n(?:- .*\n?)*", "\n", s)
p.write_text(s)
PY

echo "==> Privacy scan"
# Your identity markers (name, email, phone, handles, employers) live in a git-ignored file, one
# extended regex per line, so this script never publishes them. API-key shapes are always checked.
MARKERS="$ROOT/scripts/privacy-markers.local"
[[ -s "$MARKERS" ]] || { echo "Missing $MARKERS: add one regex per line for your own identifiers."; exit 1; }
PATTERN="sk-ant-[A-Za-z0-9_-]{8}|$(grep -v '^#' "$MARKERS" | grep -v '^$' | paste -sd'|' -)"
if grep -rIn -E "$PATTERN" --exclude=package.sh . ; then
  echo "\nPrivacy scan FAILED: personal data found above. Nothing was packaged."; exit 1
fi
for f in .env config/profile.local.yaml data career-evidence/writing-samples/*.md career-evidence/profile/resume-*; do
  [[ -e "$f" ]] && { echo "Unexpected personal file in package: $f"; exit 1; }
done

cd "$TMP"
tar -czf "$ROOT/dist/$NAME.tar.gz" cas
cd "$ROOT"
echo "==> Built dist/$NAME.tar.gz"
shasum -a 256 "dist/$NAME.tar.gz"
echo "Send the .tar.gz; the recipient follows ONBOARDING.md (tar -xzf, cd cas, ./scripts/setup.sh)."
