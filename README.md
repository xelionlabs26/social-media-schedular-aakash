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
2. Wait for setup (installs ffmpeg, dependencies and Postgres, creates `.env` and a login). The
   app then starts by itself and opens in a new browser tab (port 3000).
3. Your login is printed in the terminal and saved in `.data/login.txt`. To choose your own
   password: `pnpm hash-password 'your password'` and replace `OWNER_PASSWORD_HASH` in `.env`.

The app's address looks like `https://<codespace-name>-3000.app.github.dev` and only you
(signed in to GitHub) can open it. Codespaces use your GitHub account's free monthly hours; there
is no separate account to create.

**Connect your accounts (all in the app, nothing to type into files):**

1. Open **Settings → Setup**. Each part has short steps, links and Copy buttons for the
   addresses Google and Meta ask for:
   - **YouTube (Google app):** paste the Client ID and Client secret.
   - **Facebook & Instagram (Meta app):** paste the App ID, App secret and Configuration ID.
   - **Captions (Claude)** and **Speech to text (Deepgram):** paste one key each.
2. Under **Connected accounts**, click **Connect YouTube** and **Connect Facebook & Instagram**,
   sign in on Google's or Facebook's own page and click Allow. Reconnect or Disconnect there any
   time.

Keys are stored encrypted in the app's database and take effect at once (no restart). They stay
with this codespace: a **new** codespace has a new address, so paste the keys again and update
the redirect address in Google and Meta (the Setup steps show the new one).

**What runs while the codespace sleeps:** a codespace stops after about 30 minutes without use
(raise it to 4 hours in GitHub → Settings → Codespaces). YouTube and Facebook posts are handed to
the platform when you click Schedule, so they still go out on time. **Instagram** has no
scheduler of its own, so the app must be running at the post time: open the codespace before
then, or use an always-on server (PLAN.md §6: Railway, ~$10–15/month).

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
- Platform tokens, and keys pasted under Settings → Setup, are encrypted at rest with
  AES-256-GCM (`TOKEN_ENC_KEY`). Saved secrets are never sent back to the browser (only their
  last 4 characters).
- Never commit `.env`; in production put secrets in your host's environment variables.
