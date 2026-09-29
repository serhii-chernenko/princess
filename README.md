# Princess of the Day

Telegram bot for friend groups. The runtime is now:

- `Cloudflare Workers`
- `Hono`
- `Telegraf` via webhooks
- `Cloudflare D1`
- `Drizzle ORM`

The rewrite is the primary repository path, but production traffic and data have
not been cut over yet. Removal of the old Docker/Ansible deployment files is
uncommitted Phase 8 work; the Mongo polling runtime remains temporarily for
comparison and controlled recovery. See
[MIGRATION_STATUS.md](./MIGRATION_STATUS.md) before any production action.

## Requirements

- `Node.js >= 22`
- `pnpm >= 10.33.0`
- a Telegram bot token from `@BotFather`
- a Cloudflare account with Workers + D1 enabled
- Workers Paid for exact parity with the current production data: actor validation
  plus reconciliation of the largest observed 55-member group uses about 56
  Telegram API subrequests, above the Free plan limit of 50. A Free-plan deployment
  requires an approved reconciliation redesign.

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
export MONGO_BACKUP_REF="<reviewed-backup-commit-sha>"
pnpm run db:import:local
```

The command fetches the four allowlisted exports directly from the private backup
repository; no manual clone is needed. The repository-local May 9 backup is useful
only for historical validation and must not be used for production cutover. Follow
the [MongoDB-to-D1 data runbook](./MONGO_TO_D1_RUNBOOK.md) for export format,
authentication, validation, rehearsal, and reconciliation.

## Local Worker checks

Health:

```sh
set -a
source .dev.vars
set +a
curl http://127.0.0.1:8787/health \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}"
```

Webhook smoke test:

```sh
curl -X POST "http://127.0.0.1:8787${TELEGRAM_WEBHOOK_PATH}" \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  -d '{"update_id":42,"message":{"message_id":7,"date":1784098000,"chat":{"id":-100000000001,"type":"supergroup"},"text":"test"}}'
```

## Cloudflare auth for CLI

Keep D1 control-plane credentials separate from bot runtime secrets. Create the
ignored, mode-`0600` D1-only file from the tracked example:

```sh
cp env/.env.d1.example env/.env.d1
chmod 600 env/.env.d1
```

Fill `CLOUDFLARE_ACCOUNT_ID`, the independently reviewed
`CLOUDFLARE_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN` for Drizzle, and
`CLOUDFLARE_API_TOKEN` for Wrangler. Shell values may be used instead and take
precedence:

```sh
export CLOUDFLARE_API_TOKEN=""
export CLOUDFLARE_ACCOUNT_ID=""
export CLOUDFLARE_DATABASE_ID=""
export CLOUDFLARE_D1_TOKEN=""
```

Production migration/import never load `.dev.vars.production`. Their child
processes receive only OS essentials and the exact Cloudflare credentials needed;
GitHub and Telegram bot/webhook secrets are not forwarded.

## Production D1 setup

Create the production database:

```sh
pnpm exec wrangler d1 create princess-production --env production --binding DB
```

Put the printed `database_id` and `preview_database_id` into both Worker environments in [wrangler.jsonc](./wrangler.jsonc):

- `env.production.d1_databases[0]`
- `env.beta.d1_databases[0]`

Stable and beta share the same production D1 database.

The checked-in values are placeholders. Stable deployment must remain blocked
until every `REPLACE_WITH_...` value is replaced and verified. Wrangler
environments create distinct Workers but do not automatically isolate their bound
resources; see the
[Wrangler environments documentation](https://developers.cloudflare.com/workers/wrangler/environments/).

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
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run db:migrate:production
```

The command fails before Drizzle unless the confirmation UUID exactly matches the
single `DB` binding in `env.production`, its `database_name` is
`princess-production`, and the beta binding has the same ID and name.

Query production D1:

```sh
pnpm run db:query:production -- --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Import the migrated Mongo dataset into production D1:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
export MONGO_BACKUP_REF="<reviewed-40-character-backup-commit-sha>"
pnpm run db:import:production
```

There is intentionally no beta import command because beta and stable currently
share this D1 database. For the first production migration, take a fresh Mongo
export, freeze polling writes, create a D1 Time Travel bookmark/export, import
once, and reconcile the data by following
[the data runbook](./MONGO_TO_D1_RUNBOOK.md) and
[the cutover runbook](./MIGRATION_STATUS.md#safe-cutover-sequence). Never rerun
the insert-only import against populated application tables.

## Stable production deploy

Production migration, Worker deployment, and webhook registration are deliberately
separate operations. There is no combined cutover command.

Deploy only the stable Worker code and configured runtime secrets:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run worker:deploy:stable
```

Stable, production, and beta deploy scripts validate the confirmed shared D1
target before Wrangler starts and forward only the Cloudflare account/API token
plus OS essentials. Runtime bot/webhook values are read from the fixed
`--secrets-file`, not inherited by the child process.

Use the following only at their explicit steps in the
[cutover runbook](./MIGRATION_STATUS.md#safe-cutover-sequence):

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run db:migrate:production
pnpm run telegram:webhook:set:stable
pnpm run telegram:webhook:info:stable
pnpm run telegram:webhook:delete:stable
pnpm run worker:tail:stable
```

## Beta production deploy

Beta uses the same D1 DB, but a separate Worker, bot token, webhook secret, webhook path, and domain:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run worker:deploy:beta
```

Beta deployment does not migrate or import the shared database and does not change
its webhook. Test it only in a beta-only Telegram group. Register or inspect the
webhook deliberately when the runbook calls for it:

```sh
pnpm run telegram:webhook:set:beta
pnpm run telegram:webhook:info:beta
pnpm run telegram:webhook:delete:beta
pnpm run worker:tail:beta
```

## GitHub Actions production deploy

Pushes and pull requests validate only. To deploy stable Worker code, manually
dispatch the workflow from `main` after reviewing the intended Worker change.

Required GitHub repository secrets:

- `BOT_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

Required GitHub repository variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_DATABASE_ID`
- `TELEGRAM_WEBHOOK_PATH`

The workflow now lives in [`.github/workflows/main.yml`](./.github/workflows/main.yml).

Create a GitHub Actions environment named `production` before enabling deployment,
then configure its required reviewers and deployment-branch protection for `main`.
The workflow references that environment, but the `environment:` key alone does
not create or enforce repository protection rules.

What it does now:

- validates pushes, pull requests, and manual runs
- installs with `pnpm`
- runs the canonical checks, regenerates i18n, release, Wrangler-binding, and
  Drizzle artifacts, fails on tracked or untracked drift, and performs a production
  deployment dry-run
- only on a manual dispatch from `main`, checks for resource-ID placeholders,
  writes the stable runtime secrets file, and runs the serialized
  `pnpm run worker:deploy:stable` job without cancelling an in-flight deployment

What it does not do:

- it does not deploy beta automatically
- it does not apply remote D1 migrations or import data
- it does not register, change, or delete Telegram webhooks
- it assumes `wrangler.jsonc` already contains the real production D1 IDs

## Telegram webhook notes

- `BotFather` gives you the bot token.
- `setWebhook` is done through the Telegram Bot API, not BotFather.
- `TELEGRAM_WEBHOOK_PATH` is your route path.
- `TELEGRAM_WEBHOOK_SECRET` becomes the expected `X-Telegram-Bot-Api-Secret-Token` header.
- `/health` requires the same timing-safe secret header before it executes its D1
  readiness query
- authenticated webhook bodies are capped at 1 MiB before parsing and must contain
  a nonnegative safe `update_id` plus a minimally valid `message` update
- webhook helpers set `max_connections=1` to reduce cutover concurrency
- helpers intentionally omit `drop_pending_updates`; preserving or discarding the
  pending queue is an operator decision
- the Worker claims each `update_id` in a bot-specific D1 ledger before Telegraf
  handling; terminalized duplicates return success without rerunning the handler,
  and concurrent claims return a retryable error
- once dispatch starts, both success and caught handler errors terminalize the
  matching lease; suppressing automatic replay after a caught error is an explicit
  at-most-once reliability decision, not a general failure-recovery mechanism
- processing leases can be reclaimed after five minutes; stable maintenance prunes
  completed rows after seven days and abandoned processing rows after 24 hours

Telegram retries unsuccessful webhook requests and documents the concurrency,
pending-update, and secret-token controls in
[`setWebhook`](https://core.telegram.org/bots/api#setwebhook).

The ledger materially reduces duplicate handling. A caught dispatch failure that
is terminalized cannot execute again on Telegram's retry. If terminalization is
uncertain, the Worker acknowledges the request instead of deliberately requesting
a replay; this at-most-once choice can lose an unfinished command or reply. For the
v5 cutover, keep `max_connections=1`, do not use `/sudorun` during cutover or data
reconciliation, and stop traffic to inspect any dispatch, terminalization,
lease-loss, or reclaimed-claim warning. This is an explicit operator-accepted
reliability policy, not automatic recovery. D1 mutations, Telegram API sends, and
terminalization still cannot share a transaction, so a crash, timeout, lost
response, or stale-lease reclaim can repeat an earlier side effect.

A future stronger design should use a durable inbox, idempotent mutation-effect
keys, and an outbox. Telegram send methods do not accept an application-provided
idempotency key, so even that design cannot make external replies exactly once.

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

## Release files

- `.changeset/*.md` holds unreleased change notes before a version is cut.
- `CHANGELOG.md` is the human release history produced by Changesets.
- `releases.generated.json` is the generated runtime artifact used by `/releases`.

Use them like this:

- add a pending release note with `pnpm run changeset:add`
- prepare a real release with `pnpm run changeset:version`
- regenerate the runtime manifest with `pnpm run releases:sync`

Do not edit `releases.generated.json` by hand. `changelog.json` is retired and removed.

## Legacy fallback

The following remain only for behavior comparison while beta is being validated:

- `pnpm run legacy:dev`
- `pnpm run legacy:start`

Do not use them as the primary production path.

The legacy runtime reads ignored files under `env/`, not Worker `.dev.vars*`:

- `env/.env.dev` for `pnpm run legacy:dev`
- `env/.env.production` for `pnpm run legacy:start`

Create them from `env/.env.example` and provide `MONGODB_URI` plus the legacy bot
values. Never commit these files. After D1 accepts writes, restarting polling is
not a zero-loss rollback: first export and reconcile D1 deltas as described in
[the rollback rules](./MIGRATION_STATUS.md#rollback-rules).

## Beta safety

Stable and beta currently share the same D1 database.

That is fine only if:

- beta uses its own bot token
- beta uses its own webhook path and domain
- beta is tested in a beta-only Telegram group

Do not add stable and beta to the same Telegram group with the current schema, because both bots will operate on the same `telegram_chat_id` records.

Before the first real beta deploy, verify:

- `wrangler.jsonc` no longer contains placeholder D1 IDs
- the `princess-beta.chernenko.dev` route is attached in Cloudflare
- `.dev.vars.beta` contains the beta bot token and beta webhook secret
- the beta bot is invited only to a beta-only Telegram group
- `pnpm run db:migrate:production` has already been applied to the shared D1 database

Scheduled cleanup defaults to `false` for stable and beta. Keep it disabled until
after cutover, generate a fresh stale-channel/orphan-player review set, take a D1
bookmark/export, and approve the deletion set explicitly.

## Additional runbooks

- [MIGRATION_STATUS.md](./MIGRATION_STATUS.md) — authoritative status, cutover, and rollback
- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)
- [USER_MIGRATION_TODO.md](./USER_MIGRATION_TODO.md)
- [AGENTS.md](./AGENTS.md)
