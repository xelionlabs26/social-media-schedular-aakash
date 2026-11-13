# Social Media Scheduler

A personal, minimal scheduler for your own vertical videos. Upload one or many videos; the app
watches each one (frames + speech), Claude writes a viral story-based caption/title for every
platform, you check or edit the text, and the app publishes to:

- **Instagram Reels** (our app publishes at the exact minute, since Instagram's API has no scheduler)
- **YouTube Shorts** (uploaded early, YouTube publishes at the time)
- **Facebook Page Reels** (uploaded early, Facebook publishes at the time)

See [PLAN.md](./PLAN.md) for the full design, the platform rules and the roadmap.

> **Status:** under active development. Platform publishing can't be tested end-to-end until the
> YouTube/Meta apps and a public HTTPS domain are set up (PLAN.md §11).

## Run it

### Option A: GitHub Codespaces (nothing to install)

1. On GitHub: **Code → Codespaces → Create codespace** on this branch.
2. Wait for setup (installs ffmpeg, dependencies, Postgres and creates `.env`).
3. Set your login: `pnpm hash-password 'your password'`, then paste `OWNER_EMAIL` and
   `OWNER_PASSWORD_HASH` into `.env`.
4. `pnpm dev` and open the forwarded port 3000.

Codespaces stop when idle, so they're for trying the app, not for running a schedule. Scheduled
Instagram posts need an always-on server (PLAN.md §6: Railway, ~$10–15/month).

### Option B: your computer

Needs Node.js 22.12+, pnpm 10 (`corepack enable`), PostgreSQL 16+ and ffmpeg.

```bash
pnpm install
cp .env.example .env          # then fill in the "Required" block
pnpm hash-password 'your password'   # paste the output into .env
createdb scheduler            # or use: docker compose up db
pnpm db:migrate
pnpm dev                      # web on http://localhost:3000 + background worker
```

Set `AI_MOCK=true` to try the flow without an Anthropic key.

### Option C: Docker

```bash
cp .env.example .env   # fill it in
docker compose up --build
```

## Project layout

```
apps/web        Next.js 16 app (UI, server actions, OAuth callbacks, upload endpoints)
apps/worker     Background worker (pg-boss): ffmpeg, speech-to-text, Claude, publishing engine
packages/db     Drizzle schema + SQL migrations (PostgreSQL)
packages/core   Business logic: storage, platform clients, AI, scheduling, text rules
```

## Scripts

| Command                  | What it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `pnpm dev`               | Web + worker with reload                                    |
| `pnpm typecheck`         | TypeScript across all packages                              |
| `pnpm test`              | Unit tests                                                  |
| `pnpm build`             | Production build of the web app                             |
| `pnpm db:generate`       | New SQL migration after editing `packages/db/src/schema.ts` |
| `pnpm db:migrate`        | Apply migrations (the worker also does this on start)       |
| `pnpm hash-password '…'` | Create `OWNER_PASSWORD_HASH`                                |

## Security notes

- Single owner login (email + scrypt password hash from env), signed session cookie, login rate limit.
- Platform tokens are encrypted at rest with AES-256-GCM (`TOKEN_ENC_KEY`).
- Never commit `.env`; in production put secrets in your host's environment variables.
