# Princess of the Day

> Operators: read [docs/OPERATIONS.md](./docs/OPERATIONS.md) first. It is the runbook for deploys, migrations, previews, data copies and releases.

Telegram bot for friend groups. The runtime is now:

- `Cloudflare Workers`
- `Hono`
- `Telegraf` via webhooks
- `Cloudflare D1`
- `Drizzle ORM`
- `evlog` telemetry sent to New Relic EU in production

Production observability, the separate game and audience dashboard, and the New
Relic project MCP and installed skills are documented in the
[operations runbook](./docs/OPERATIONS.md#9-data-and-analytics). Preview and
local development retain Cloudflare observability without New Relic ingestion.

The rewrite serves production: the cutover to Workers and D1 happened on 2026-09-29
(see the [cutover record](./MIGRATION_STATUS.md#cutover-record)). The old
Docker/Ansible deployment files, the VPS bot, and the legacy Mongo polling code are
removed (the legacy implementation stays available only in git history), and
MongoDB Atlas is kept as a backup and re-import source. See
[MIGRATION_STATUS.md](./MIGRATION_STATUS.md) before any production action.

## Requirements

- `Node.js >= 22`
- `pnpm >= 10.33.0`
- a Telegram bot token from `@BotFather`
- a Cloudflare account with Workers + D1 enabled
- Workers Paid (required, decided): a vote in a group of N members makes 1 actor
  check, N reconciliation checks, and 2 replies, so the largest observed 55-member
  group uses 56 Telegram API subrequests before replies, above the Free plan limit
  of 50.

## Local setup

1. Install dependencies:

```sh
pnpm install
```

2. Create local env files:

```sh
cp .dev.vars.example .dev.vars
cp .dev.vars.production.example .dev.vars.production
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

Every daily-vote win is recorded in `vote_wins` (channel, player, `won_at`, mode
`auto`, `manual` or `sudo`, and `eligible_count`) so fairness questions can be
answered with data. `eligible_count` is the number of active players in the draw
pool after member reconciliation, i.e. the pool the winner was drawn from. A
failed history insert is logged as `vote_win_record_failed` and never affects the
vote. Wins are not imported from Mongo, which has no such history.

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

Webhook check:

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

The real `database_id` values are committed in [wrangler.jsonc](./wrangler.jsonc)
under `env.production.d1_databases[0]`. The production environment does not define
`preview_database_id`, so `wrangler dev --remote` cannot reach a remote database by
accident. Worker Previews use a separate D1 database, `princess-preview` (see
[Testing with Worker Previews](#testing-with-worker-previews)).

Local operators without an API token can run the D1 and deploy scripts through
`wrangler login` by setting `CLOUDFLARE_AUTH_MODE=wrangler-login` (plus
`CLOUDFLARE_ACCOUNT_ID`). The mode is rejected when `CI` or `GITHUB_ACTIONS` is set;
CI keeps using API tokens. `pnpm db:import:preview` accepts a local backup via
`MONGO_BACKUP_DIR` or `--input-dir <absolute-path>` (`princess-db/` by default).

Only production owns cron triggers and queue consumers. Previews have neither.

Fill `.dev.vars.production` for the production bot:

```dotenv
BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET="replace-with-a-secret-token"
TELEGRAM_WEBHOOK_PATH="/telegram/princess"
WORKER_BASE_URL="https://princess.chernenko.dev"
```

Apply production migrations:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run db:migrate:prod
```

The command fails before Drizzle unless the confirmation UUID exactly matches the
single `DB` binding in `env.production`, its `database_name` is
`princess-production`.

Query production D1:

```sh
pnpm run db:query:prod -- --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Import the migrated Mongo dataset into production D1:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
export MONGO_BACKUP_REF="<reviewed-40-character-backup-commit-sha>"
pnpm run db:import:prod
```

The preview database can be filled from production or from a local backup (see
[Testing with Worker Previews](#testing-with-worker-previews)). For the first production migration, take a fresh Mongo
export, freeze polling writes, create a D1 Time Travel bookmark/export, import
once, and reconcile the data by following
[the data runbook](./MONGO_TO_D1_RUNBOOK.md) and
[the cutover runbook](./MIGRATION_STATUS.md#safe-cutover-sequence). Never rerun
the insert-only import against populated application tables.

## Production deploy

Production is deployed by Cloudflare Workers Builds (see
[Cloudflare deployment](#cloudflare-deployment)). Production migration, manual Worker
deployment, and webhook registration are deliberately separate operations.

For a manual production deploy of the Worker code and configured runtime secrets:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run worker:deploy:prod
```

The production deploy script validates the confirmed D1 target
(`CLOUDFLARE_DATABASE_ID`) before Wrangler starts and forwards only the Cloudflare account/API token
plus OS essentials. Runtime bot/webhook values are read from the fixed
`--secrets-file`, not inherited by the child process.

Use the following only at their explicit steps in the
[cutover runbook](./MIGRATION_STATUS.md#safe-cutover-sequence):

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run db:migrate:prod
pnpm run telegram:webhook:set:prod --drop-pending-updates=false
pnpm run telegram:webhook:info:prod
pnpm run telegram:webhook:delete:prod --drop-pending-updates=false
pnpm run worker:tail:prod
```

`set` and `delete` for production and preview require an explicit
`--drop-pending-updates=true|false`; local may omit it.

## Cloudflare deployment

Cloudflare Workers Builds is connected to `serhii-chernenko/princess`:

- `princess` builds from `main` (build command `pnpm run i18n:generate && pnpm run db:migrate:ci`, deploy
  command `pnpm exec wrangler deploy --env production && pnpm releases:broadcast:prod`)
- Pull requests and non-production branches get automatic Worker Previews of `princess` when preview builds are enabled (see [Testing with Worker Previews](#testing-with-worker-previews))

Runtime secrets (`BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`) are
set on the Worker (and in the Preview base config for previews), not in GitHub. The build command applies pending D1 migrations
(`main` to `princess-production`, other branches to `princess-preview`, see
[docs/OPERATIONS.md](./docs/OPERATIONS.md#4-database-migrations)); builds never change Telegram webhooks.

## GitHub Actions

[`.github/workflows/main.yml`](./.github/workflows/main.yml) only validates pushes and
pull requests to `main`. It installs with `pnpm`, runs the canonical checks,
regenerates i18n, release, Wrangler-binding, and Drizzle artifacts, fails on tracked
or untracked drift, and performs a production deployment dry-run. It never
deploys and holds no deployment secrets.

[`copy-production-to-preview.yml`](./.github/workflows/copy-production-to-preview.yml) is
the only workflow that uses secrets; see
[Testing with Worker Previews](#testing-with-worker-previews).

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
- `set` and `delete` for production and preview require
  `--drop-pending-updates=true|false`; preserving or discarding the pending queue
  is an operator decision (local may omit the flag)
- the Worker claims each `update_id` in a bot-specific D1 ledger before Telegraf
  handling; terminalized duplicates return success without rerunning the handler,
  and concurrent claims return a retryable error
- once dispatch starts, both success and caught handler errors terminalize the
  matching lease; suppressing automatic replay after a caught error is an explicit
  at-most-once reliability decision, not a general failure-recovery mechanism
- processing leases can be reclaimed after five minutes; production maintenance prunes
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

Production example:

```sh
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://princess.chernenko.dev/telegram/princess" \
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

After a merge or push to `main` and a passing `validate` job, the `release` job in `.github/workflows/main.yml` publishes every missing version (from 5.0.0 on) as a GitHub Release using the English bullets. No manual step is needed.

Do not edit `releases.generated.json` by hand. `changelog.json` is retired and removed.

### Bilingual release notes

Changeset bullets are written in Ukrainian and may carry an optional nested English line:

```md
- [added] Нова команда /lang.
    - en: New /lang command.
```

`pnpm run changeset:validate` requires the Ukrainian text and accepts at most one nested `en:` line per bullet. The generated manifest stores each item as `{ "uk": "...", "en": "..." }`; `en` is optional and falls back to the Ukrainian text, so older Ukrainian-only history keeps working. `/releases` and the announcement pick the text from the community language (`ua` or `en`). `pnpm run changeset:version` prefixes bullets with the commit hash in `CHANGELOG.md`; the manifest parser understands both that shape and plain `- [group]` bullets.

### Release announcements

Every new release is announced to each community once, through Cloudflare Queues:

- A `*/10 * * * *` cron (production only) compares the newest manifest version with every channel's `release_version`. Channels on a lower version get one `release_announcements` row (unique per version and channel) and one queue job.
- The queue consumer sends the announcement in the community language and then stores the version on the channel. `/start` also stores the current version, so new communities never receive old announcements.
- Delivery is at-most-once on ambiguity: a duplicate announcement is worse than a missed one. The consumer first moves the row `queued` to `sending` (compare-and-set), then calls Telegram. A network error or timeout with no Telegram response, or a redelivery of a row still in `sending`, is marked `skipped` (no error code) and never resent. If the post-send state write still fails after three tries, the message is acknowledged and logged (`release_announcement_state_write_failed`), never resent.
- Chats that block or remove the bot (403, or 400 with a permanent description such as `chat not found`) are marked `skipped` and the channel is kept; channels are never deleted. A 400 with `migrate_to_chat_id` updates the channel's chat id and sends once more, or is skipped (`release_announcement_chat_migrated_conflict`) when another channel already has that id. Any other 400 marks the row `failed` without bumping the channel version. 429 re-enqueues a fresh job after `retry_after + 1` seconds, so it never counts toward `max_retries`. Any 5xx is treated as ambiguous (Telegram may have delivered before the error): the row is marked `skipped` with the status code, the channel version is bumped, and the message is never resent (`release_announcement_ambiguous`).
- Kill switch: setting the `ENABLE_RELEASE_BROADCAST` variable to anything but `"true"` requires a redeploy. While off, the consumer sends nothing and changes no state, retries every message after 600 seconds, and jobs land in the dead-letter queue after about 50 minutes while rows stay `queued`. The fast emergency stop is `pnpm exec wrangler queues pause-delivery princess-release-announcements` (resume with `resume-delivery`). Jobs with a malformed body or a version that is not the latest release are acknowledged and logged.
- Stale recovery: each cron run re-enqueues `queued` rows for the current version untouched for over 3 hours (longer than the retry chain) and marks `sending` rows stuck over 3 hours as `skipped` (ambiguous).
- Queues: production `princess-release-announcements` with DLQ `princess-release-announcements-dlq`; previews use the producer-only `princess-preview-release-announcements` (no consumer). Local development uses `princess-local-release-announcements` with the broadcast switched off.
- `ENABLE_RELEASE_BROADCAST` (`"true"` on production, `"false"` locally and in previews) gates the producer.
- Manual trigger: Cloudflare cannot run a cron on demand, so `POST /admin/release-broadcast` runs the same producer as the cron. It requires the `X-Telegram-Bot-Api-Secret-Token` header (the webhook secret) and answers 401 on a wrong secret and 409 while `ENABLE_RELEASE_BROADCAST` is off. Use `pnpm run releases:broadcast:prod`; it reads `WORKER_BASE_URL` and `TELEGRAM_WEBHOOK_SECRET` from `.dev.vars.production` and prints the JSON summary. When `WORKER_BASE_URL` and `TELEGRAM_WEBHOOK_SECRET` are already set in the environment (for example as Cloudflare Workers Builds build variables, where the script runs right after `wrangler deploy`), they take precedence and no `.dev.vars` file is needed. The script retries (12 attempts, 5s apart) until the Worker reports the `package.json` version, exits 0 with a notice on 409 (broadcast disabled), and fails immediately on 401/503.

## Legacy removal

The legacy Telegraf polling and Mongoose implementation is removed from the
repository; the VPS is gone, so there is no supported rollback to it. MongoDB Atlas
data is kept as a backup source for re-importing with the Mongo to D1 tooling in
`scripts/db`. See [the rollback rules](./MIGRATION_STATUS.md#rollback-rules).

## Testing with Worker Previews

All testing uses Worker Previews of the production Worker `princess`
(Cloudflare Worker Previews, Wrangler 4.143 or newer). `env.production.previews` in
`wrangler.jsonc` defines what a preview gets, and `env.production.preview_urls`
enables the URLs (`workers_dev` stays `false`). A preview is created per name, by
default from the git branch.

Infrastructure: Worker `princess` with previews; D1 `princess-production` and
`princess-preview`; queues `princess-release-announcements` (+ `-dlq`) and
`princess-preview-release-announcements` (producer only). Workers Builds deploys `main`
to production and creates a preview per non-main branch, named after the branch. The
long-lived preview used by the preview bot (@princess_debug_bot) is named `preview`
(https://preview-princess.chernenko.workers.dev), and its webhook points there.
Redeploy it with `pnpm worker:preview --name preview`.

What a preview gets:

- Its own D1 database, `princess-preview`, migrated automatically by the branch build
  (manual fallback: `pnpm run db:migrate:preview` after setting `CLOUDFLARE_PREVIEW_DATABASE_ID` or `CLOUDFLARE_AUTH_MODE=wrangler-login`).
  The tooling refuses an id or name shared with production.
- Its own producer-only queue, `princess-preview-release-announcements`.
- `BOT_ENVIRONMENT="preview"`, `ENABLE_RELEASE_BROADCAST="false"`,
  `ENABLE_SCHEDULED_CLEANUP="false"`: global cleanup and ledger pruning are refused,
  and `POST /admin/release-broadcast` answers 409.
- Secrets from the Preview base config, never from the production Worker.

Flow:

1. Create a preview, either manually or through automatic PR previews from Workers
   Builds:

    ```sh
    pnpm run worker:preview --name <name>
    ```

2. Set the base-config secrets once. `BOT_TOKEN` is the real preview bot token (@princess_debug_bot), so keep
   that bot out of production groups:

    ```sh
    pnpm exec wrangler preview base-config secret put BOT_TOKEN --env production
    pnpm exec wrangler preview base-config secret put TELEGRAM_WEBHOOK_SECRET --env production
    pnpm exec wrangler preview base-config secret put TELEGRAM_WEBHOOK_PATH --env production
    ```

3. Migrate the preview database (the branch build already does this; run it by hand only as a fallback):

    ```sh
    pnpm run db:migrate:preview
    ```

4. Optionally fill it, from a local backup (the target must be empty) or from
   production:

    ```sh
    pnpm run db:import:preview
    pnpm run db:copy:production-to-preview --confirm-overwrite-preview
    ```

    The copy is also available as the manual workflow
    [`copy-production-to-preview.yml`](./.github/workflows/copy-production-to-preview.yml)
    (`main` only, `preview` environment, typed confirmation `OVERWRITE PREVIEW`). It
    needs the `CLOUDFLARE_API_TOKEN` secret with D1 edit on both databases and the
    `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and
    `CLOUDFLARE_PREVIEW_DATABASE_ID` variables. Locally, `CLOUDFLARE_PREVIEW_DATABASE_ID`
    lives in `env/.env.d1`.

5. Point the preview bot webhook at the preview. Fill `.dev.vars.preview` from
   `.dev.vars.preview.example` (`BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `TELEGRAM_WEBHOOK_PATH`), then:

    ```sh
    pnpm run telegram:webhook:set:preview -- --url https://<name>.<account>.workers.dev --drop-pending-updates=true
    pnpm run telegram:webhook:info:preview -- --url https://<name>.<account>.workers.dev
    pnpm run telegram:webhook:delete:preview -- --drop-pending-updates=true
    ```

    `--url` must be `https` with a host ending in `.workers.dev`; the script never
    derives it from the branch. `set` and `delete` require an explicit
    `--drop-pending-updates=true|false`.

6. Test only in preview-only Telegram groups. Never add both bots to the same group.
   Preview logs are in the Cloudflare dashboard observability; Wrangler 4.143.1
   cannot tail a preview.

Copy safety (production to preview only, hard-coded direction):

- It copies `players`, `channels`, `channel_members`, and `vote_wins` only (not
  `__drizzle_migrations` or `telegram_updates`), requires distinct database ids and
  matching migrations, wipes preview in foreign-key-safe chunks, and verifies counts.
- The remote export makes production D1 unavailable to queries while it runs; use a
  low-traffic window. Production writes after the export are not copied and may
  cause a count mismatch, so rerun. A mid-way failure leaves preview partly wiped;
  rerunning is safe.
- After a copy the preview D1 holds production PII (Telegram IDs, names, usernames,
  group titles). Restrict access to it and to preview logs, and define retention.
  Erasure on production does not reach preview until the next copy.
- Restrict the `preview` GitHub environment to `main` with required reviewers, scope
  the token to D1 only (ideally a production-read token for export and a
  preview-edit token for wipe/import), and consider CODEOWNERS or branch protection
  on `.github/workflows/`, `scripts/db/`, and `wrangler.jsonc`.

Limitations:

- Previews never run cron triggers or queue consumers: the queue is producer-only and
  there is no release broadcast. Only production owns cron triggers and queue
  consumers.
- All previews share the single `princess-preview` D1 and the preview bot's single
  webhook, so only one preview can receive Telegram traffic at a time.
- `preview_urls: true` also exposes production version URLs on `workers.dev`. They are
  protected only by the same secret gating (webhook secret header and path), so keep
  those secrets strong.

Scheduled cleanup defaults to `false` for production and previews. Keep it disabled until
the deletion set is reviewed: generate a fresh stale-channel/orphan-player review set, take a D1
bookmark/export, and approve the deletion set explicitly.

## Operator note

Keep the bot an administrator in every group. Winners are drawn from members the bot
can resolve via `getChatMember`; a non-admin bot only resolves recently seen users
(legacy swallowed those errors, so many members never won). The rewrite treats
`400 PARTICIPANT_ID_INVALID` as "not a member".

## Additional runbooks

- [MIGRATION_STATUS.md](./MIGRATION_STATUS.md) — authoritative status, cutover, and rollback
- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)
- [USER_MIGRATION_TODO.md](./USER_MIGRATION_TODO.md)
- [AGENTS.md](./AGENTS.md)
