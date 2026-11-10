#!/bin/zsh
# Double-click to start CAS. The first start installs everything (about 5 minutes).
# Keep this window open while you use CAS; close it to stop.
cd "$(dirname "$0")" || exit 1
PORT="$(grep -E '^CAS_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"; PORT="${PORT:-4780}"
URL="http://127.0.0.1:$PORT/start"
pause() { echo; read -r "?Press Enter to close this window. "; }

echo "Starting CAS (Career Acquisition System)..."
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)'; then
  echo
  echo "CAS needs Node.js version 22 or newer, and it is not installed yet."
  echo "Your browser will open the Node.js download page:"
  echo "  1. Download the macOS installer (the .pkg file) and run it."
  echo "  2. Then double-click \"Start CAS\" again."
  open "https://nodejs.org/en/download"
  pause; exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "First start: installing CAS. This takes about 5 minutes and needs an internet connection."
  if ! CAS_SETUP_NONINTERACTIVE=1 ./scripts/setup.sh; then
    echo; echo "Installation did not finish. Scroll up for the error, or send a screenshot of this window to whoever gave you CAS."
    pause; exit 1
  fi
fi

if curl -s -o /dev/null "http://127.0.0.1:$PORT/start"; then
  echo "CAS is already running. Opening it in your browser."
  open "$URL"; exit 0
fi

CAS_ENV=prod npx tsx src/cli.ts serve &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
for i in {1..60}; do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/start" && break
  sleep 0.5
done
open "$URL"
echo
echo "CAS is running at $URL"
echo "Keep this window open while you use CAS. Close it (or press Ctrl+C) to stop."
wait $SERVER
