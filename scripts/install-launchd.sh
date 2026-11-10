#!/bin/zsh
# Installs the CAS daily job as a user LaunchAgent (label from CAS_LAUNCHD_LABEL, default com.cas.daily.<username>).
# Wrapped in caffeinate so the Mac does not idle-sleep mid-run (incident 2026-10-26).
# Runs at 06:30 and at login; `cas daily` skips itself if it already ran today, and a DB lease
# prevents overlapping runs. Does not touch any other launch agent.
set -euo pipefail
# Label: CAS_LAUNCHD_LABEL from the environment or .env, else com.cas.daily.<username>.
if [[ -z "${CAS_LAUNCHD_LABEL:-}" && -f "$(dirname "$0")/../.env" ]]; then
  CAS_LAUNCHD_LABEL="$(grep -E '^CAS_LAUNCHD_LABEL=' "$(dirname "$0")/../.env" | tail -1 | cut -d= -f2- || true)"
fi
LABEL="${CAS_LAUNCHD_LABEL:-com.cas.daily.$(whoami)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$ROOT/data/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string><string>-s</string>
    <string>$NODE</string><string>$ROOT/node_modules/tsx/dist/cli.mjs</string><string>$ROOT/src/cli.ts</string><string>daily</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>CAS_ENV</key><string>prod</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/logs/daily.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/daily.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
PL
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL -> $PLIST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|last exit" || true
