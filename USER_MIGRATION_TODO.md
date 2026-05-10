# User Migration Todo

Last updated: 2026-05-10

This file is the user-facing companion to `MIGRATION_PLAN.md`.

Use it to answer 3 questions at every phase:

1. What is already migrated?
2. How can it be tested locally right now?
3. What will need to be done in production once that part is finished?

This file should be updated after every significant migration phase.

## Current Status

There are currently 2 runnable paths:

1. Worker runtime
    - Real Telegram bot behavior
    - Cloudflare Worker + Hono + Telegraf webhook handling
    - Uses `.dev.vars` locally and `.dev.vars.production` for production-oriented CLI flows
    - This is now the primary path

2. Legacy bot runtime
    - Old Node.js + polling path
    - Kept only as a fallback while migration continues
    - Use `legacy:dev` or `legacy:start` if you need to compare old behavior

## Route Status

Current Worker routes:

- `GET /`
    - service metadata response
- `GET /health`
    - readiness/health response
- `POST /telegram`
    - Telegram webhook endpoint
    - validates path and optional secret
    - now dispatches the real Telegraf bot runtime

## Phase 5

### What changed

- The Worker runtime is now the real bot runtime
- The new TypeScript bot path lives under `src/bot/`
- The webhook route now calls the actual Telegraf bot instead of returning a scaffold note
- The D1-backed runtime now handles:
    - `/start`
    - `/help`
    - `/join`
    - `/leave`
    - `/run`
    - `/sudorun`
    - `/list`
    - `/top`
    - `/reset`
    - `/stop`
    - `/stats`
    - `/releases`
    - `/lang`
    - the message-triggered automatic daily run flow
- Channel language is now stored in D1 in `channels.language`
- Default language for every channel is `ua`
- User-facing locale codes are now:
    - `ua`
    - `en`
- Internal `typesafe-i18n` still uses `uk` behind the scenes only
- Scheduled cleanup now uses the new D1 service layer
- `dev` and `start` now point to the Worker path
- `legacy:dev` and `legacy:start` keep the old polling path available for comparison
- Active env examples no longer include `MONGODB_URI`

### Primary local commands now

Worker-first local dev:

```sh
npm run dev
```

Equivalent explicit command:

```sh
npm run worker:dev
```

Old polling fallback:

```sh
npm run legacy:dev
```

### Local setup

Create `.dev.vars` from the example if you have not done that yet:

```sh
cp .dev.vars.example .dev.vars
```

Required values for the Worker path:

```dotenv
BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET="replace-with-a-secret-token"
TELEGRAM_WEBHOOK_PATH="/telegram"
AUTHOR_TWITTER_LINK="https://twitter.com/giraffender"
WISHLIST_TG_URL="https://t.me/wishlist_ua_bot"
CHATGPT_GITHUB_REPO_URL="https://github.com/serhii-chernenko/chatgpt-telegram-bot"
TG_CHANNEL="https://t.me/serhii_chernenko"
TG_GROUP="https://t.me/serhii_chernenko_chat"
YT_CHANNEL="https://youtube.com/@serhii.chernenko"
MAIL="contact@chernenko.digital"
```

### Local smoke tests that do not require Telegram delivery

Health:

```sh
curl http://127.0.0.1:8787/health
```

Expected:

```json
{ "service": "princess", "runtime": "cloudflare-workers", "ready": true }
```

Invalid secret:

```sh
curl -X POST http://127.0.0.1:8787/telegram \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: wrong-secret' \
  -d '{"update_id":42}'
```

Expected:

- HTTP `401`

Synthetic accepted update with your local secret:

```sh
set -a
source .dev.vars
curl -X POST "http://127.0.0.1:8787${TELEGRAM_WEBHOOK_PATH}" \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  -d '{"update_id":42}'
```

Expected:

```json
{ "accepted": true, "updateId": 42 }
```

### Important limit of local webhook testing

The bot now performs real Telegram API calls for:

- `getChatMember`
- replies and messages

That means a full end-to-end command test requires:

1. a real bot token
2. a real Telegram group/chat and user ids
3. a public HTTPS webhook URL reachable by Telegram

So:

- local `curl` smoke tests prove the Worker route and secret handling
- real bot behavior should be verified through a deployed temporary or production Worker URL with `setWebhook`

### Real Telegram verification flow

1. Deploy a temporary or production Worker:

```sh
npm run worker:deploy:production
```

2. Register the webhook:

```sh
set -a
source .dev.vars.production
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://<your-worker-domain>${TELEGRAM_WEBHOOK_PATH}" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

3. Verify webhook status:

```sh
set -a
source .dev.vars.production
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

4. In the Telegram group:
    - add the bot
    - run `/start`
    - run `/lang`
    - run `/lang en`
    - run `/lang ua`
    - run `/join` from several users
    - run `/run`
    - wait until the next 24h window and send a normal text message to verify the auto-run path

### Channel language behavior

- New channels default to `ua`
- `/lang` shows the available languages list:

```text
Available languages: en, ua
Доступні мови: en, ua
```

- `/lang en` switches the current group to English
- `/lang ua` switches the current group back to Ukrainian
- `uk` is accepted as an alias in the command parser, but it is normalized and stored as `ua`
- Only `ua` and `en` should be shown to users or stored in DB docs

### Production implications later

- Production is now expected to use the Worker webhook path, not polling
- `setWebhook` is now a real deployment step, not a future placeholder
- The old Node polling path is now fallback-only
- Startup release fanout from the legacy polling bootstrap is still not moved yet

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
{ "service": "princess", "runtime": "cloudflare-workers", "ready": true }
```

Root endpoint:

```sh
curl http://127.0.0.1:8787/
```

Expected:

```json
{
    "service": "princess",
    "runtime": "cloudflare-workers",
    "phase": 2,
    "status": "bootstrapped"
}
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
{
    "accepted": true,
    "updateId": 42,
    "note": "Webhook scaffold only. Telegram bot logic will be wired in Phase 5."
}
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

- `.dev.vars`

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

## Phase 3

### What changed

- Drizzle upgraded to `1.0.0-rc.1`
- Effect integrated into the new DB service layer
- Table definitions split into `src/db/schemas/`
- Drizzle schema keys are now `camelCase` in TypeScript
- Database columns remain `snake_case` through `snakeCase.table(...)`
- Local D1 migrations now use Drizzle's own D1 migrator
- Remote D1 migrations now use Drizzle Kit with a dedicated D1 HTTP config
- Repo rule added in `AGENT.md` and enforced in Oxlint:
  no implicit-return arrow bodies

### Important architecture note

Do not use `wrangler d1 migrations apply DB --local` for the Drizzle RC schema migrations in this repo.

Reason:

- Drizzle RC writes migrations in the nested folder format under `drizzle/<timestamp_name>/migration.sql`
- Wrangler's flat SQL migration flow did not apply that format correctly in local validation
- The working local flow here is `npm run db:migrate:local`

### Wrangler environment layout

`wrangler.jsonc` is intentionally split into 2 layers:

- top-level config
  local-only Worker development
  local placeholder D1 binding
  Worker name: `princess-local`
- `env.production`
  real production Worker deployment
  real production D1 binding
  Worker name: `princess`

Use:

- `npm run worker:dev`
  for local root config
- `npm run worker:dev:production`
  if you need to emulate the production Worker config locally
- `npm run worker:deploy:production`
  for the real deploy target

### Local schema workflow

Generate schema migrations:

```sh
npm run db:generate
```

Apply schema migrations to local D1:

```sh
npm run db:migrate:local
```

Inspect local schema:

```sh
npm run db:query:local -- --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected tables:

- `__drizzle_migrations`
- `channels`
- `players`
- `channel_members`

### Remote schema workflow

Create the production vars file:

```sh
cp .dev.vars.production.example .dev.vars.production
```

Fill:

```dotenv
CLOUDFLARE_ACCOUNT_ID=""
CLOUDFLARE_DATABASE_ID=""
CLOUDFLARE_D1_TOKEN=""
```

`BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_WEBHOOK_PATH` should also be set in `.dev.vars.production` for production-oriented local commands.

### Why `drizzle.production.config.ts` exists

`drizzle.production.config.ts` is not a special Drizzle filename.

It works because Drizzle Kit supports multiple config files and lets you choose one explicitly with `--config`.

This repo uses:

```sh
drizzle-kit migrate --config drizzle.production.config.ts
```

That file is only the production D1 HTTP config for Drizzle Kit commands.

It is separate from:

- `drizzle.config.ts`
  local schema generation config
- `wrangler.jsonc`
  Worker runtime and D1 binding config

### How to get production D1 credentials for a newly created DB

1. Create the production database:

```sh
npx wrangler d1 create princess-production --env production --binding DB
```

This prints the production D1 binding block and the new database UUID.

Optional:

```sh
npx wrangler d1 create princess-production --env production --binding DB --update-config
```

This lets Wrangler update the `env.production` D1 binding block in `wrangler.jsonc` automatically.

2. Put the printed UUID into `wrangler.jsonc` under `env.production.d1_databases[0]`:

- `database_id`
- `preview_database_id`

3. Get the Cloudflare Account ID.

Official Cloudflare locations:

- Workers & Pages -> Account details -> Account ID
- or Account home -> Copy account ID

4. Create an API token with D1 write access.

For Drizzle D1 HTTP writes, use a token with `D1 Write` / `D1:Edit` permission.

5. Fill `.dev.vars.production`:

```dotenv
CLOUDFLARE_ACCOUNT_ID="<your-account-id>"
CLOUDFLARE_DATABASE_ID="<your-production-d1-uuid>"
CLOUDFLARE_D1_TOKEN="<your-api-token>"
```

6. Run the production Drizzle migration:

```sh
npm run db:migrate:production
```

Why this needs `.dev.vars.production`:

- Wrangler environments configure the Worker runtime and D1 bindings
- Drizzle Kit is a separate CLI
- Drizzle Kit does not read Wrangler environment bindings directly
- so the production Drizzle command needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and `CLOUDFLARE_D1_TOKEN` loaded from `.dev.vars.production`

Create the real D1 database if needed:

```sh
npx wrangler d1 create princess-production --env production --binding DB
```

Then replace the placeholder `database_id` and `preview_database_id` in `wrangler.jsonc` under `env.production`.

Apply schema migrations remotely:

```sh
npm run db:migrate:production
```

Inspect remote schema:

```sh
npm run db:query:production -- --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

## Phase 4

### What changed

- Real Mongo backup validation added
- Backup reader supports the actual `princess-db/` export format:
  line-delimited JSON, not arrays
- Import preparation script added:
  `scripts/db/prepare-mongo-import.ts`
- Import apply scripts added:
  `db:import:local`
  `db:import:production`
- Import output files are generated under `.backups/`
  `mongo-to-d1.sql`
  `mongo-to-d1.report.json`

### D1 safety rule used here

Cloudflare D1 has a practical bound-parameter ceiling around `100` per statement.

This repo avoids large import statements by:

- generating chunked SQL batches
- using conservative chunk sizes
- validating the real backup before import

Current chunk sizes:

- players: `20`
- channels: `20`
- channel members: `10`

### Real backup validation result

Validated against local backup directory:

- `princess-db/channels.json`: `225`
- `princess-db/players.json`: `974`
- `princess-db/scores.json`: `1040`
- `princess-db/status.json`: `1040`

Transform result:

- channels: `225`
- players: `974`
- channel members: `1040`

Validation report:

- duplicate channels: `0`
- duplicate players: `0`
- duplicate channel members: `0`
- missing player refs: `0`
- missing score refs: `0`
- missing status refs: `0`

### Prepare import SQL from old Mongo backup

The default input directory is the local-only `princess-db/` folder.

Generate the import SQL and report:

```sh
npm run db:import:prepare
```

Generated outputs:

- `.backups/mongo-to-d1.sql`
- `.backups/mongo-to-d1.report.json`

### Apply import locally

Recommended clean local validation flow:

```sh
rm -rf .wrangler/state/v3/d1
npm run db:migrate:local
npm run db:import:local
npm run db:query:local -- --command="SELECT (SELECT count(*) FROM channels) AS channels, (SELECT count(*) FROM players) AS players, (SELECT count(*) FROM channel_members) AS channel_members;"
```

Expected result after importing the current backup:

- channels: `225`
- players: `974`
- channel_members: `1040`

### Apply import in production

Only after production schema migration is complete:

```sh
npm run db:import:production
```

Then verify:

```sh
npm run db:query:production -- --command="SELECT (SELECT count(*) FROM channels) AS channels, (SELECT count(*) FROM players) AS players, (SELECT count(*) FROM channel_members) AS channel_members;"
```

### Backup source rule

`princess-db/` is local validation input only.

- read from it
- validate against it
- generate import SQL from it
- do not commit it

### Phase 5

- local end-to-end bot testing through Worker webhook
- command behavior verification
- how to test actual Telegram updates against local or remote webhook

### Phase 6

### What changed

- Manual `%placeholder` message mutation is replaced with `typesafe-i18n`
- Authored bot copy now lives in:
    - `src/i18n/en/index.ts`
- Generated i18n files live in:
    - `src/i18n/i18n-types.ts`
    - `src/i18n/i18n-util.ts`
    - `src/i18n/i18n-util.sync.ts`
    - `src/i18n/i18n-util.async.ts`
- Runtime Ukrainian locale mirror lives in:
    - `src/i18n/uk/index.ts`
- `CHANGELOG.md` is now the human release source of truth
- `releases.generated.json` is now the generated runtime release manifest for:
    - Worker `/releases`
    - legacy `/releases`
- `changelog.json` is retired from the runtime path
- `Changesets` is configured for future version/changelog maintenance

### Important editing rule for translations

Edit:

- `src/i18n/en/index.ts`

Do not hand-edit:

- generated files in `src/i18n/`
- `src/i18n/uk/index.ts`

Then regenerate:

```sh
pnpm run i18n:generate
```

### Local validation for i18n changes

After editing translation copy:

```sh
pnpm run i18n:generate
pnpm run check
```

Expected:

- i18n generated files stay in sync
- typecheck passes
- `/releases` tests still pass
- Worker runtime tests still pass

### Release data flow now

The new release pipeline is:

1. You add or update release notes through Changesets
2. `changeset version` updates `package.json` and `CHANGELOG.md`
3. The repo stamps the top changelog entry with the release date
4. The repo regenerates `releases.generated.json`
5. The bot renders Telegram `/releases` output from `releases.generated.json`

### How to add a changeset

Run:

```sh
pnpm run changeset:add
```

In the body of the generated Markdown file, use Ukrainian tagged bullets only:

```md
- [added] ...
- [updated] ...
- [fixed] ...
- [removed] ...
- [notes] ...
```

Validate the format:

```sh
pnpm run changeset:validate
```

### How to prepare a release

Run:

```sh
pnpm run changeset:version
```

This will:

- validate the pending changesets
- update `package.json` version
- update `CHANGELOG.md`
- stamp the newest changelog entry with today’s date
- regenerate `releases.generated.json`
- refresh the lockfile metadata

After that, review and commit:

- `package.json`
- `CHANGELOG.md`
- `releases.generated.json`
- lockfiles if changed

### How to test Telegram release rendering locally

Regenerate the release manifest:

```sh
pnpm run releases:sync
```

Then run the repo tests:

```sh
pnpm test
```

What this proves:

- the generated manifest is readable by both runtimes
- the latest release is still exposed consistently
- the Worker `/releases` renderer still includes the expected headings

### Production implications later

- Before a production deploy that should expose a new version, run:

```sh
pnpm run changeset:version
```

- Commit the updated release files before deploying the Worker
- After deployment, `/releases` will reflect the new release immediately because it reads `releases.generated.json`
- Automatic proactive release broadcast to all groups is still not scheduled yet
- Manual `/releases` already works against the new source of truth

### Phase 7

- production Worker deployment flow
- final webhook registration flow
- production rollback steps

### Phase 8

- final maintenance checklist
- operator docs
- agent docs references
