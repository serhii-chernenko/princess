# Princess Operations Runbook

The single operator runbook for the Princess bot. It assumes no prior context.
No secret values appear here, only names and file locations.

## Contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Local setup](#2-local-setup)
3. [Everyday flow](#3-everyday-flow)
4. [Database migrations](#4-database-migrations)
5. [Copy production data into preview](#5-copy-production-data-into-preview)
6. [Previews and the preview bot](#6-previews-and-the-preview-bot)
7. [Production operations](#7-production-operations)
8. [Releases and announcements](#8-releases-and-announcements)
9. [Data and analytics](#9-data-and-analytics)
10. [Known issues and open follow-ups](#10-known-issues-and-open-follow-ups)

## 1. Architecture at a glance

| Piece             | Value                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Cloudflare Worker `princess` (wrangler env `production`), Hono + Telegraf                                                                                                                                                                   |
| Domain            | `princess.chernenko.dev` (custom domain)                                                                                                                                                                                                    |
| Telegram webhook  | Secret header (`X-Telegram-Bot-Api-Secret-Token`) plus secret path (`TELEGRAM_WEBHOOK_PATH`)                                                                                                                                                |
| Production D1     | `princess-production` (`19c5b5dd-ac9e-43ff-9a0a-40c77c39d1d1`)                                                                                                                                                                              |
| Preview D1        | `princess-preview` (`b9a13fb8-8745-4d33-a5a2-f067b7b35220`)                                                                                                                                                                                 |
| Production queues | `princess-release-announcements` (producer and consumer) with dead-letter queue `princess-release-announcements-dlq`                                                                                                                        |
| Preview queue     | `princess-preview-release-announcements` (producer only, nothing consumes it)                                                                                                                                                               |
| Production crons  | `0 0 * * *` (daily maintenance), `*/10 * * * *` (release broadcast)                                                                                                                                                                         |
| Account           | Cloudflare account `5396970bbe7f97f2d01c5b759444cd40`, Workers Paid plan (required: a vote in a large group exceeds the 50 subrequest limit of the Free plan)                                                                               |
| Bots              | Production bot (the main princess bot) and the preview bot, Telegram handle `@princess_debug_bot`                                                                                                                                           |
| Legacy data       | MongoDB Atlas is kept only as a backup source. Daily backups stopped on 2026-09-30: princess was removed from the `backup-dbs` workflow and the `princess-db` repo is archived (read-only; last snapshot `d97cd8e`, the post-freeze export) |

Config lives in `wrangler.jsonc`. The preview Worker shape is under `env.production.previews`.

## 2. Local setup

```sh
pnpm install
```

Three git-ignored files are required. They, together with Cloudflare, hold the only copy of the secrets. Back them up in a password manager.
Examples with placeholder values are committed next to them (`*.example`).

| File                   | Variable names                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `.dev.vars`            | `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `AXIOM_TOKEN`, `WORKER_BASE_URL`                          |
| `.dev.vars.production` | `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `AXIOM_TOKEN`, `WORKER_BASE_URL`                          |
| `.dev.vars.preview`    | `BOT_TOKEN` (of the preview bot), `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `AXIOM_TOKEN`                        |
| `env/.env.d1`          | `CLOUDFLARE_AUTH_MODE=wrangler-login`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, `CLOUDFLARE_PREVIEW_DATABASE_ID` |

Examples: `.dev.vars.production.example`, `.dev.vars.preview.example`, `env/.env.d1.example`.
`env/.env.d1.example` also lists `CLOUDFLARE_D1_TOKEN` and `CLOUDFLARE_API_TOKEN`; these are only needed for token auth mode and drizzle tooling, not with `wrangler-login`.

Authentication:

```sh
pnpm exec wrangler login   # OAuth; can expire
cf auth login              # only for the cf CLI
```

An expired login shows up as `Invalid access token`. Run `pnpm exec wrangler login` again.
`CLOUDFLARE_AUTH_MODE=wrangler-login` is rejected in CI, it is for local operators only.

## 3. Everyday flow

1. Create a branch and open a PR to `main`.
2. GitHub CI job `validate` runs `pnpm run check`, checks generated artifacts for drift and does a `wrangler deploy --dry-run`.
3. Workers Builds deploys a preview automatically at `https://<branch>-princess.chernenko.workers.dev`. Check the "Workers Builds: princess" status on the PR.
4. If the PR has a migration, apply it first (see [section 4](#4-database-migrations)).
5. Merge to `main`. Workers Builds deploys production and runs `pnpm releases:broadcast:prod`.
6. Delete merged branches and their previews:

```sh
pnpm exec wrangler preview delete --name <branch-slug> --env production -y
```

Run all local checks before pushing:

```sh
pnpm run check
```

## 4. Database migrations

Workers Builds does NOT run migrations. Apply them to both databases BEFORE merging.

```sh
pnpm db:generate            # after editing src/db/schemas/*, creates files in drizzle/
pnpm db:migrate:prod
pnpm db:migrate:preview
```

The migrator is idempotent and reports `applied` and `alreadyApplied` migrations. The first D1 call of a session sometimes fails with D1 error 7403. Just rerun the same command.

## 5. Copy production data into preview

Use this to test with realistic data. Direction is hard-coded: production to preview, never the reverse.

### What it does

1. Refuses to run if production and preview resolve to the same database.
2. Verifies the migrations applied in both databases match (otherwise run `pnpm db:migrate:preview`).
3. Exports each table from production. Production D1 is briefly unavailable during the export, so run it in a quiet moment.
4. Checks that the exported row counts equal production counts.
5. Wipes the preview tables.
6. Imports parent-first: `players`, `channels`, `channel_members`, `vote_wins`.
7. Verifies preview row counts equal production counts.

`telegram_updates` and `release_announcements` are not copied.

### Prerequisites

- `pnpm exec wrangler login` is fresh (see [section 2](#2-local-setup)).
- `env/.env.d1` exists with the account and both database IDs.
- Preview migrations match production.

### Run

```sh
pnpm db:copy:production-to-preview --confirm-overwrite-preview
```

Without the flag the script refuses to run.

### Verify

```sh
pnpm db:query:preview --command "select count(*) as channels from channels"
pnpm db:query:preview --command "select count(*) as players from players"
pnpm db:query:prod --command "select count(*) as channels from channels"
```

Counts must match between preview and production (the script also checks this itself).

### If it fails

- The error message says whether preview was modified. Errors before the wipe end with `Preview was not modified`.
- After the wipe started, the message ends with a notice that preview is empty or partially filled. Rerunning the same command is safe and restores it.
- D1 error 7403 is transient: rerun.
- `Row counts differ after copy` means production changed during the copy: rerun.
- `Preview migrations ... do not match production`: run `pnpm db:migrate:preview` first.

### GitHub workflow alternative

Workflow `Copy Production Data to Preview` (`.github/workflows/copy-production-to-preview.yml`) runs from the Actions tab on `main`. It asks for the confirmation text `OVERWRITE PREVIEW`.

It needs a GitHub environment named `preview`, which is NOT configured yet:

| Kind     | Name                             |
| -------- | -------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`           |
| Variable | `CLOUDFLARE_ACCOUNT_ID`          |
| Variable | `CLOUDFLARE_DATABASE_ID`         |
| Variable | `CLOUDFLARE_PREVIEW_DATABASE_ID` |

The token needs D1 edit access on the account. Until this is set up, use the local command.

### Privacy

After a copy, preview holds production user data. Restrict access and use the preview bot only in preview-only groups.

## 6. Previews and the preview bot

- Long-lived preview named `preview`: `https://preview-princess.chernenko.workers.dev`. It serves the preview bot.
- Every preview (including per-branch previews) shares the `princess-preview` database and the single preview-bot webhook.
- Previews never run cron triggers or queue consumers.

Redeploy the long-lived preview. Do not put `--` before `--name`, pnpm would pass it through and wrangler would drop the name:

```sh
pnpm worker:preview --name preview
```

Set preview secrets (names only; feed values from your password manager or `.dev.vars.preview`):

```sh
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put BOT_TOKEN --env production
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put TELEGRAM_WEBHOOK_SECRET --env production
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put TELEGRAM_WEBHOOK_PATH --env production
```

Point the preview bot webhook at a preview (needs `.dev.vars.preview`):

```sh
pnpm telegram:webhook:set:preview --url https://preview-princess.chernenko.workers.dev --drop-pending-updates=true
pnpm telegram:webhook:info:preview
pnpm telegram:webhook:delete:preview --drop-pending-updates=true
```

`--url` must be a bare `https://<name>.<account>.workers.dev` origin. `--drop-pending-updates=true|false` is mandatory for set and delete.

Rules:

- Keep the preview bot only in preview-only groups, and make it an administrator there.
- Never add both bots to the same Telegram group.

## 7. Production operations

Webhook (reads `.dev.vars.production`):

```sh
pnpm telegram:webhook:info:prod
pnpm telegram:webhook:set:prod --drop-pending-updates=false
```

Set requires an explicit `--drop-pending-updates=true|false`.

Health check (returns 200 only with the correct secret, 401 without):

```sh
curl -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" https://princess.chernenko.dev/health
```

Logs:

```sh
pnpm worker:tail:prod
```

Or open Workers Observability in the Cloudflare dashboard (logs are on, traces sampled at 5%).

Manual deploy fallback if Workers Builds is down (uses `.dev.vars.production` as the secrets file):

```sh
pnpm worker:deploy:prod
```

Group requirement: keep the bot an administrator in every group. Non-admin bots can only resolve recently seen members, which makes draws unfair. No extra admin rights are needed.

## 8. Releases and announcements

Add a changeset (`pnpm changeset:add`) with Ukrainian tagged bullets, each followed by a nested English line:

```md
---
'princess': patch
---

- [fixed] Український текст.
    - en: English text.
```

Tags: `added`, `updated`, `fixed`, `removed`, `notes`. Validate with `pnpm changeset:validate`.

Cut a release:

```sh
pnpm changeset:version
```

If it fails locally because the worktree sits inside a checkout with a parent `.prettierrc`, edit `CHANGELOG.md` by hand in the same format and run:

```sh
pnpm run releases:sync
```

`releases.generated.json` is generated: never edit it by hand. `CHANGELOG.md` is the human-owned history.

Announcements go out automatically after the production deploy: the deploy step triggers a broadcast, which enqueues one message per group on `princess-release-announcements`. Delivery is at-most-once. Per-group results are in the `release_announcements` table (`queued`, `sending`, `sent`, `skipped`, `failed`).

Manual trigger (needs `WORKER_BASE_URL` and `TELEGRAM_WEBHOOK_SECRET` in `.dev.vars.production`):

```sh
pnpm releases:broadcast:prod
```

Emergency stop:

```sh
pnpm exec wrangler queues pause-delivery princess-release-announcements
pnpm exec wrangler queues resume-delivery princess-release-announcements
```

The kill switch var `ENABLE_RELEASE_BROADCAST` (in `wrangler.jsonc`, `"true"` on production) needs a redeploy to take effect.

## 9. Data and analytics

Workers keeps Cloudflare Logs and traces enabled. It also emits one safe evlog
wide event for each HTTP request, Telegram webhook outcome, scheduled run,
release broadcast, and release-announcement queue batch. Axiom delivery uses
`AXIOM_TOKEN` and is registered with the Worker execution context, so a failed
or slow drain never changes bot behavior.

Dataset creation is temporarily unavailable on the Axiom organization. All
Princess environments therefore write to the existing `besidka-prod` dataset.
Filter Princess telemetry with `service = 'princess'` and `environment`.
Princess-specific fields live only under the declared map path
`attributes.princess` to avoid exceeding Axiom's field limit. These events
contain normalized route names, status, durations, bounded outcome categories,
and aggregate counts; they do not contain webhook paths, headers, message text,
bot tokens, Telegram IDs, or display names.

The [Princess Bot operations dashboard](https://app.axiom.co/besidka-tnqd/dashboards/uid/princess-bot-operations)
shows production update outcomes and latency, processing and queue errors,
scheduled Worker heartbeats, vote completions, command mix, and release
broadcast coverage. Its final chart compares ingest across production, preview,
and local development. Production charts remain empty until this change is
deployed from `main`; a zero error count before the first production event is
not evidence that delivery is healthy. Check the ingest chart and the most
recent scheduled run together when investigating missing data.

| Table                   | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `players`               | Telegram users (`telegram_user_id`, `display_name`)                                 |
| `channels`              | Telegram groups (`telegram_chat_id`, `language`, `release_version`, `last_vote_at`) |
| `channel_members`       | Player in a channel (`score`, `is_active`, `is_auto_joined`)                        |
| `vote_wins`             | One row per daily vote win (history, see below)                                     |
| `release_announcements` | Announcement status per release version and channel                                 |
| `telegram_updates`      | Webhook idempotency ledger, pruned by the daily cron                                |

`vote_wins` columns: `channel_id`, `player_id`, `won_at` (ms timestamp), `mode` (`auto`, `manual`, `sudo`), `eligible_count` (number of eligible players at draw time, at least 2).

Fairness example: wins per player against the expected share (sum of `1 / eligible_count`):

```sh
pnpm db:query:prod --command "select player_id, count(*) as wins, round(sum(1.0 / eligible_count), 2) as expected from vote_wins where channel_id = 1 group by player_id order by wins desc"
```

Running queries:

```sh
pnpm db:query:prod --command "select count(*) from channels"
pnpm db:query:preview --command "select count(*) from channels"
```

Production queries are live: prefer `select`.

## 10. Known issues and open follow-ups

- The production `*/10` cron has not been observed firing. Single-cron configs fired, production has two crons. Check Workers Observability for `scheduled` events and investigate.
- The daily `telegram_updates` ledger prune depends on the cron.
- D1 error 7403 on the first call of a session: rerun.
- `ENABLE_SCHEDULED_CLEANUP` stays `"false"` on production until the deletion set is reviewed.
- Decide when to retire MongoDB Atlas (currently backup and re-import source only).
- Rotate the bot tokens and webhook secrets.
- Add edge rate limiting.
- Create the GitHub `preview` environment for the copy workflow (see [section 5](#github-workflow-alternative)).
