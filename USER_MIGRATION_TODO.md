# User Migration Todo

Last updated: 2026-05-09

This file is the user-facing companion to `MIGRATION_PLAN.md`.

Use it to answer 3 questions at every phase:

1. What is already migrated?
2. How can it be tested locally right now?
3. What will need to be done in production once that part is finished?

This file should be updated after every significant migration phase.

## Current Status

There are currently 2 runnable paths:

1. Legacy bot runtime
   - Real Telegram bot behavior
   - Node.js + polling
   - Uses `env/.env.dev`

2. Worker scaffold runtime
   - Cloudflare Worker + Hono skeleton
   - Has route scaffolding only
   - Does not yet execute the actual bot game logic

## Route Status

Current Worker routes:

- `GET /`
  - simple service metadata response
- `GET /health`
  - readiness/health response
- `POST /telegram`
  - Telegram webhook scaffold
  - validates path and optional secret
  - currently accepts the payload but does not yet run bot logic

Why only `/health` as a "real" endpoint right now:

- This phase was intentionally only the Worker scaffold phase.
- `/telegram` exists already, but it is still a stub.
- The actual bot behavior behind `/telegram` will be wired in later phases when the data layer and command flow are migrated.
- So this was not forgotten. It is intentionally staged.

## Phase 1

### What changed

- Dependency baseline refreshed safely within current runtime majors
- Lockfile added
- Docker builds switched to `npm ci`
- ESLint + Prettier replaced with Oxlint + Oxfmt
- TypeScript strict scaffold added
- Smoke tests added

### Local validation

Run:

```sh
npm run check
```

Expected:

- lint passes
- format check passes
- typecheck passes
- smoke tests pass

### Production implications later

- Production Docker builds are more deterministic now because they use `package-lock.json` and `npm ci`
- No production action required yet beyond normal deploys

## Phase 2

### What changed

- Cloudflare Worker project skeleton added
- Hono app added
- Worker entrypoint added
- Worker env scaffolding added
- `wrangler.jsonc` added
- Worker type generation added
- `GET /health` route added
- `POST /telegram` scaffold added
- scheduled handler scaffold added

### Local setup

Create `.dev.vars` from the example:

```sh
cp .dev.vars.example .dev.vars
```

Suggested values:

```dotenv
BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET="replace-with-a-secret-token"
TELEGRAM_WEBHOOK_PATH="/telegram"
```

### Local run

Start the Worker:

```sh
npm run worker:dev
```

### Local tests

Health endpoint:

```sh
curl http://127.0.0.1:8787/health
```

Expected:

```json
{"service":"princess","runtime":"cloudflare-workers","ready":true}
```

Root endpoint:

```sh
curl http://127.0.0.1:8787/
```

Expected:

```json
{"service":"princess","runtime":"cloudflare-workers","phase":2,"status":"bootstrapped"}
```

Webhook scaffold:

```sh
curl -X POST http://127.0.0.1:8787/telegram \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: replace-with-a-secret-token' \
  -d '{"update_id":42}'
```

Expected:

```json
{"accepted":true,"updateId":42,"note":"Webhook scaffold only. Telegram bot logic will be wired in Phase 5."}
```

Invalid secret test:

```sh
curl -X POST http://127.0.0.1:8787/telegram \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: wrong-secret' \
  -d '{"update_id":42}'
```

Expected:

- HTTP `401`

### Production implications later

When the Worker path becomes the real production bot path, production will need:

1. deployed Worker URL
2. production bot token
3. production webhook path
4. production webhook secret
5. Telegram webhook registration

## Webhook Basics

### What comes from BotFather

BotFather gives:

- bot creation
- bot username
- bot token

BotFather does not manage:

- webhook path
- webhook secret
- Cloudflare deploy URL

### What is custom and chosen by us

These values are ours to define:

- `TELEGRAM_WEBHOOK_PATH`
  - for example: `/telegram`
  - or `/telegram/princess-prod`

- `TELEGRAM_WEBHOOK_SECRET`
  - any secret token string we generate
  - Telegram will send it back in the header:
    `X-Telegram-Bot-Api-Secret-Token`

### Recommended production shape

Example production values:

```dotenv
BOT_TOKEN="123456:ABCDEF_REAL_TOKEN"
TELEGRAM_WEBHOOK_PATH="/telegram/princess-prod"
TELEGRAM_WEBHOOK_SECRET="princess-prod-secret-2026"
```

### How Telegram webhook registration works

Webhook registration is done using the Telegram Bot API, not BotFather.

General form:

```sh
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_WORKER_DOMAIN><YOUR_WEBHOOK_PATH>" \
  -d "secret_token=<YOUR_WEBHOOK_SECRET>"
```

Example:

```sh
curl -X POST "https://api.telegram.org/bot123456:ABCDEF_REAL_TOKEN/setWebhook" \
  -d "url=https://princess.example.workers.dev/telegram/princess-prod" \
  -d "secret_token=princess-prod-secret-2026"
```

### Check webhook status

```sh
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

Example:

```sh
curl "https://api.telegram.org/bot123456:ABCDEF_REAL_TOKEN/getWebhookInfo"
```

### Remove webhook

Useful when switching back to polling or resetting webhook config:

```sh
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook"
```

Example:

```sh
curl -X POST "https://api.telegram.org/bot123456:ABCDEF_REAL_TOKEN/deleteWebhook"
```

## Current Real Bot Testing

Until the Worker bot logic is fully migrated, the real game flow still runs through the old Node app.

### Local setup

Use:

- `env/.env.dev`

### Local run

```sh
npm run dev
```

### What this currently tests

- actual Telegraf bot logic
- commands
- listeners
- Mongo/Mongoose path
- polling-based update flow

### Production implications later

This path is temporary.

Once the Worker migration is complete:

- polling should be removed
- webhook delivery should become primary
- VPS/Docker/Ansible production flow should be retired

## Future Production Checklist

This checklist is not fully actionable yet, but it is the intended end state.

### Deploy Worker

```sh
npm run worker:deploy
```

### Configure Cloudflare secrets and vars

Examples:

```sh
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Non-secret variable example through config or dashboard:

- `TELEGRAM_WEBHOOK_PATH`

### Register Telegram webhook

```sh
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_WORKER_DOMAIN><YOUR_WEBHOOK_PATH>" \
  -d "secret_token=<YOUR_WEBHOOK_SECRET>"
```

### Verify webhook

```sh
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

### Test production health

```sh
curl https://<YOUR_WORKER_DOMAIN>/health
```

### Test production webhook carefully

Only after the bot logic is migrated:

```sh
curl -X POST "https://<YOUR_WORKER_DOMAIN><YOUR_WEBHOOK_PATH>" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <YOUR_WEBHOOK_SECRET>" \
  -d '{"update_id":42}'
```

## Upcoming Phases To Document Here

The following must be added here as they are implemented:

### Phase 3

- D1 setup
- local database creation
- local migration commands
- schema verification commands

### Phase 4

- Mongo export/import workflow
- migration dry-run steps
- production migration checklist

### Phase 5

- local end-to-end bot testing through Worker webhook
- command behavior verification
- how to test actual Telegram updates against local or remote webhook

### Phase 6

- i18n workflow
- Changesets usage for this repo
- how release notes become Telegram release posts

### Phase 7

- production Worker deployment flow
- final webhook registration flow
- production rollback steps

### Phase 8

- final maintenance checklist
- operator docs
- agent docs references
