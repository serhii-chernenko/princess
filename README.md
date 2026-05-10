# Princess of the Day

Telegram bot for friend groups. The runtime is now:

- `Cloudflare Workers`
- `Hono`
- `Telegraf` via webhooks
- `Cloudflare D1`
- `Drizzle ORM`

The old `Docker + Mongo + Ansible + VPS` path is kept in the repo only as a temporary migration fallback. It is no longer the primary operating model.

## Requirements

- `Node.js >= 22`
- `pnpm >= 10.33.0`
- a Telegram bot token from `@BotFather`
- a Cloudflare account with Workers + D1 enabled

## Local setup

1. Install dependencies:

```sh
pnpm install
```

2. Create local env files:

```sh
cp .dev.vars.example .dev.vars
cp .dev.vars.production.example .dev.vars.production
cp .dev.vars.beta.example .dev.vars.beta
```

3. Fill at least these local values:

```dotenv
BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET="replace-with-a-secret-token"
TELEGRAM_WEBHOOK_PATH="/telegram/princess-dev"
WORKER_BASE_URL="https://princess-dev.chernenko.dev"
```

4. If you want real Telegram delivery into local `wrangler dev`, copy and configure the tunnel file:

```sh
cp cloudflared.example.yml cloudflared.yml
```

5. Start the Worker locally:

```sh
pnpm run dev
```

This now starts:

- `wrangler dev`
- `cloudflared` if `cloudflared.yml` exists
- automatic local `setWebhook` once `wrangler dev` is ready
- automatic local `deleteWebhook` on shutdown

If you want plain local Worker dev without tunnel/webhook automation:

```sh
pnpm run worker:dev:raw
```

6. Run repo validation:

```sh
pnpm run check
```

## Local D1 workflow

Generate migrations:

```sh
pnpm run db:generate
```

Apply local migrations:

```sh
pnpm run db:migrate:local
```

Query local D1:

```sh
pnpm run db:query:local -- --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Import the old Mongo backup into local D1:

```sh
pnpm run db:import:local
```

## Local Worker checks

Health:

```sh
curl http://127.0.0.1:8787/health
```

Webhook smoke test:

```sh
set -a
source .dev.vars
curl -X POST "http://127.0.0.1:8787${TELEGRAM_WEBHOOK_PATH}" \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  -d '{"update_id":42}'
```

## Cloudflare auth for CLI

Keep Cloudflare control-plane credentials in your shell or CI, not in `.dev.vars.*`:

```sh
export CLOUDFLARE_API_TOKEN=""
export CLOUDFLARE_ACCOUNT_ID=""
export CLOUDFLARE_DATABASE_ID=""
export CLOUDFLARE_D1_TOKEN=""
```

## Production D1 setup

Create the production database:

```sh
pnpm exec wrangler d1 create princess-production --env production --binding DB
```

Put the printed `database_id` and `preview_database_id` into both Worker environments in [wrangler.jsonc](./wrangler.jsonc):

- `env.production.d1_databases[0]`
- `env.beta.d1_databases[0]`

Stable and beta share the same production D1 database.

Only stable owns the cron trigger. Beta does not.

Fill `.dev.vars.production` for the stable bot:

```dotenv
BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET="replace-with-a-secret-token"
TELEGRAM_WEBHOOK_PATH="/telegram/princess-stable"
WORKER_BASE_URL="https://princess.chernenko.dev"
```

Fill `.dev.vars.beta` for the beta bot:

```dotenv
BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET="replace-with-a-secret-token"
TELEGRAM_WEBHOOK_PATH="/telegram/princess-beta"
WORKER_BASE_URL="https://princess-beta.chernenko.dev"
```

Apply production migrations:

```sh
pnpm run db:migrate:production
```

Query production D1:

```sh
pnpm run db:query:production -- --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Import the migrated Mongo dataset into production D1:

```sh
pnpm run db:import:production
```

## Stable production deploy

One-step stable deploy:

```sh
pnpm run deploy:stable
```

That command runs:

1. repo validation
2. Drizzle production migrations
3. stable Worker deploy to Cloudflare
4. Telegram `setWebhook`

If you need the stable pieces separately:

```sh
pnpm run worker:deploy:stable
pnpm run telegram:webhook:set:stable
pnpm run telegram:webhook:info:stable
pnpm run telegram:webhook:delete:stable
pnpm run worker:tail:stable
```

## Beta production deploy

Beta uses the same D1 DB, but a separate Worker, bot token, webhook secret, webhook path, and domain:

```sh
pnpm run deploy:beta
```

If you need the beta pieces separately:

```sh
pnpm run worker:deploy:beta
pnpm run telegram:webhook:set:beta
pnpm run telegram:webhook:info:beta
pnpm run telegram:webhook:delete:beta
pnpm run worker:tail:beta
```

## GitHub Actions production deploy

Push to `main` for the stable deploy.

Required GitHub repository secrets:

- `BOT_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_D1_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

Required GitHub repository variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_DATABASE_ID`
- `TELEGRAM_WEBHOOK_PATH`
- `WORKER_BASE_URL`

The workflow now lives in [`.github/workflows/main.yml`](./.github/workflows/main.yml).

## Telegram webhook notes

- `BotFather` gives you the bot token.
- `setWebhook` is done through the Telegram Bot API, not BotFather.
- `TELEGRAM_WEBHOOK_PATH` is your route path.
- `TELEGRAM_WEBHOOK_SECRET` becomes the expected `X-Telegram-Bot-Api-Secret-Token` header.

Stable example:

```sh
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://princess.chernenko.dev/telegram/princess-stable" \
  -d "secret_token=replace-with-a-secret-token"
```

Local tunnel helpers:

```sh
pnpm run telegram:webhook:set:local
pnpm run telegram:webhook:info:local
pnpm run telegram:webhook:delete:local
```

## Legacy fallback

The following remain only for comparison or rollback during migration:

- `pnpm run legacy:dev`
- `pnpm run legacy:start`
- `pnpm run docker:dev`
- `pnpm run docker:start`

Do not use them as the primary production path anymore.

## Additional runbooks

- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)
- [USER_MIGRATION_TODO.md](./USER_MIGRATION_TODO.md)
- [AGENT.md](./AGENT.md)
