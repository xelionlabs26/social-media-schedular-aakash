#!/usr/bin/env bash
# First-time setup inside GitHub Codespaces / VS Code dev containers.
set -euo pipefail
sudo apt-get update -y && sudo apt-get install -y --no-install-recommends ffmpeg
corepack enable
pnpm install
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://scheduler:scheduler@db:5432/scheduler|" .env
  sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=')|" .env
  sed -i "s|^TOKEN_ENC_KEY=.*|TOKEN_ENC_KEY=$(openssl rand -base64 32)|" .env
  sed -i "s|^AI_MOCK=.*|AI_MOCK=true|" .env
  if [ -n "${CODESPACE_NAME:-}" ]; then
    sed -i "s|^APP_URL=.*|APP_URL=https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}|" .env
  fi
  echo
  echo "Created .env. Set your login with:  pnpm hash-password 'your password'"
  echo "then paste OWNER_EMAIL and OWNER_PASSWORD_HASH into .env and run:  pnpm dev"
fi
