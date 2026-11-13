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
fi

# A login so the app can be opened straight away. Saved to .data/login.txt (not committed).
# To pick your own password later: pnpm hash-password 'new password', then replace the line in .env.
if ! grep -q "^OWNER_PASSWORD_HASH=." .env; then
  password="$(openssl rand -base64 24 | tr -d '\n/+=' | cut -c1-16)"
  hash_line="$(pnpm --silent hash-password "$password" | grep '^OWNER_PASSWORD_HASH=')"
  HASH_LINE="$hash_line" awk '/^OWNER_PASSWORD_HASH=/ { print ENVIRON["HASH_LINE"]; next } { print }' .env > .env.tmp
  mv .env.tmp .env
  mkdir -p .data
  printf 'Email:    %s\nPassword: %s\n' "$(grep '^OWNER_EMAIL=' .env | cut -d= -f2-)" "$password" > .data/login.txt
  chmod 600 .data/login.txt
fi
echo
echo "Setup done. Your login:"
cat .data/login.txt 2>/dev/null || echo "(see OWNER_EMAIL in .env)"
