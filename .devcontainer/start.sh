#!/usr/bin/env bash
# Runs each time the codespace is opened: shows the login and starts the web app + worker.
set -euo pipefail
if [ -f .data/login.txt ]; then
  echo "──────── Your login ────────"
  cat .data/login.txt
  echo "────────────────────────────"
fi
if curl -s -o /dev/null http://localhost:3000/api/health; then
  echo "The app is already running on port 3000."
  exit 0
fi
echo "Starting the app. A browser tab opens on port 3000 when it is ready."
exec pnpm dev
