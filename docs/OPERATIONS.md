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
11. [Why wrangler.jsonc and not the cf CLI](#11-why-wranglerjsonc-and-not-the-cf-cli)

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
| `.dev.vars`            | `ADMIN_ID`, `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `WORKER_BASE_URL`                             |
| `.dev.vars.production` | `ADMIN_ID`, `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `NEW_RELIC_LICENSE_KEY`, `WORKER_BASE_URL`    |
| `.dev.vars.preview`    | `ADMIN_ID`, `BOT_TOKEN` (of the preview bot), `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`                           |
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
4. To test the preview with the debug bot, push the branch and run `pnpm preview:point`. It waits for the Workers Builds check and for the preview to be ready, then points the preview bot webhook at it. Test in the preview-only group (see [section 6](#6-previews-and-the-preview-bot)).
5. If the PR has a migration, the branch build applies it to `princess-preview` before the preview deploys (see [section 4](#4-database-migrations)). Nothing to do by hand.
6. Merge to `main`. Workers Builds applies pending migrations to `princess-production`, deploys production and runs `pnpm releases:broadcast:prod`. When `CHANGELOG.md` changed, the `release` job in `main.yml` also publishes the GitHub Release (see [section 8](#8-releases-and-announcements)).
7. Delete merged branches and their previews, then point the preview bot back at the long-lived preview:

```sh
pnpm exec wrangler preview delete --name <branch-slug> --env production -y
pnpm preview:reset
```

Run all local checks before pushing:

```sh
pnpm run check
```

## 4. Database migrations

Workers Builds applies migrations automatically, before the deploy:

| Build                      | Database migrated     |
| -------------------------- | --------------------- |
| `main` (production)        | `princess-production` |
| any other branch (preview) | `princess-preview`    |

```sh
pnpm db:generate            # after editing src/db/schemas/*, creates files in drizzle/
```

Commit the generated files in `drizzle/`. Do not run `db:migrate:prod` before a merge anymore. `pnpm db:migrate:prod` and `pnpm db:migrate:preview` stay available as manual fallbacks (for example when Workers Builds is down). The migrator is idempotent and reports `applied` and `alreadyApplied` migrations. The first D1 call of a session sometimes fails with D1 error 7403. Just rerun the same command.

### How automatic migration works

`pnpm db:migrate:ci` (`scripts/db/migrate-ci.ts`) runs in the Workers Builds build command, which finishes before the deploy command (production) or the Preview command (other branches) starts:

```sh
pnpm run i18n:generate && pnpm run db:migrate:ci
```

- The target comes from `WORKERS_CI_BRANCH`: exactly `main` (a `refs/heads/` prefix is stripped) migrates production, every other branch migrates preview. A missing or empty branch, a `refs/...` value, or `WORKERS_CI` other than `1`, aborts the build. The script never defaults to a database.
- Both database ids must be pinned as Workers Builds build variables (`CLOUDFLARE_DATABASE_ID`, `CLOUDFLARE_PREVIEW_DATABASE_ID`). They must differ, and the id of the chosen target must equal the `wrangler.jsonc` binding, so an accidental edit of the database ids in a branch fails the build. This protects against mistakes, not against a hostile branch: a branch build runs that branch's own code with the token in its environment, so anyone who can push a branch to this repository can reach production. Keep push access limited to people trusted with production.
- It authenticates in token mode (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_TOKEN`) and applies pending Drizzle migrations through drizzle-kit.
- D1 error 7403 is retried up to 3 attempts with a growing delay. Any other error fails the build, so production is never deployed on top of an unmigrated schema.
- Concurrent branch builds share `princess-preview`. The migrator is idempotent once a migration is recorded, but two builds that start before either has recorded it can race: the second fails on the duplicate DDL and is not retried, so rerun that build. A branch with a migration that is not on `main` leaves preview ahead of production until it merges.

### One-time Cloudflare setup

The build command and secrets live in the Cloudflare dashboard, not in the repo. Do these in order, because changing the build command first makes the next build fail:

1. Create two API tokens limited to this account with `Account > D1 > Edit` only: `princess-builds-d1-production` for production builds and `princess-builds-d1-preview` for preview builds, so either can be revoked on its own. Keep copies in `env/.env.d1` as `CLOUDFLARE_D1_TOKEN` and `CLOUDFLARE_D1_TOKEN_PREVIEW` (gitignored); Cloudflare shows a token only once. Cloudflare scopes D1 permissions to the account, not to one database, so the token is readable by every build. Do not give the token any other permission.
2. Workers > `princess` > Settings > Build > Build variables and secrets: add `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID` (`princess-production` id) and `CLOUDFLARE_PREVIEW_DATABASE_ID` (`princess-preview` id) as variables, and `CLOUDFLARE_D1_TOKEN` as a secret. The ids are in `wrangler.jsonc`; they are not secret. Set them for the production build with the production token and, separately, for Previews (the Previews base config) with the preview token. These are build-only values and are not Worker runtime secrets. From the CLI: `cf builds triggers environment-variables upsert <trigger-uuid> --body ...` for production, `cf builds workers update <script-tag> --body '{"previews_base_config":{"environment_variables":{...}}}'` for Previews.
3. Set the Build command to `pnpm run i18n:generate && pnpm run db:migrate:ci` for both production and Previews (`cf builds workers update <script-tag> --production-settings-build-command ... --previews-base-config-build-command ...`). Switch both only after this script is on `main`: a branch or `main` build without the script fails with `Missing script: db:migrate:ci`, and the Previews build command is shared by every branch. Keep the Deploy command (`pnpm exec wrangler deploy --env production && pnpm releases:broadcast:prod`) and the Preview command as they are.
4. Push a branch with a migration (or any branch) and check the build log for `Applying D1 migrations to the preview database`. Confirm that a failing migration command stops the build before the preview deploys.

### Migration rules

Keep every migration additive (new tables, new nullable or defaulted columns, new indexes). During a deploy the old code runs against the new schema for a short time, and a migration is applied before the code that needs it. Ship destructive changes (drop, rename, new NOT NULL without default) in two releases: first stop using the column, then drop it. Review the generated SQL in `drizzle/` in the PR, because merging now applies it to production without a manual step.

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

`telegram_updates`, `release_announcements` and `channel_snapshots` are not copied.

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
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put ADMIN_ID --env production
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put BOT_TOKEN --env production
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put TELEGRAM_WEBHOOK_SECRET --env production
printf %s "$VALUE" | pnpm exec wrangler preview base-config secret put TELEGRAM_WEBHOOK_PATH --env production
```

Point the preview bot webhook at a branch preview. This needs `.dev.vars.preview`, `gh` logged in, and the branch pushed:

```sh
pnpm preview:url                 # print the preview origin for the current branch
pnpm preview:wait                # wait for the Workers Builds check, then for the preview to answer
pnpm preview:point               # url, wait, then setWebhook with --drop-pending-updates=true
pnpm preview:point --no-wait --drop-pending-updates=false
pnpm preview:reset               # back to https://preview-princess.chernenko.workers.dev
```

`preview:url` needs no env file. `preview:wait`, `preview:point`, `preview:smoke` and `preview:reset` load `.dev.vars.preview` from the current directory, or from the main checkout when you run them in a git worktree, and let it override any `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_PATH` already in your shell. The file must exist in one of those two places. `preview:point` and `preview:reset` call Telegram `getMe` first and refuse to change the webhook unless the token belongs to `@princess_debug_bot`.

Timeouts. `preview:wait` and `preview:point` give the Workers Builds check `--timeout-seconds N` (default 600) and then give the preview its own `--ready-timeout-seconds N` (default 120) to answer on `/` and `/health`. `--interval-seconds N` (default 10) sets the polling interval. A failing `gh` call counts as pending until it fails 5 times in a row.

Output. `preview:url` prints only the bare origin. `preview:wait` prints one-line JSON events. `preview:point` and `preview:reset` print events plus the sanitized webhook info. No command prints the bot token, the webhook secret or the webhook path.

Where the origin comes from. It is computed from the branch, with no network call: `https://<branch-slug>-princess.chernenko.workers.dev`. `preview:url --branch <name>` computes it for another branch. Only when the branch label is too long to compute (see the caveat below) does the CLI read the newest `### Preview URL:` header from a comment by `cloudflare-workers-and-pages[bot]` on the commit's pull request. Only `<name>-princess.chernenko.workers.dev` hosts are accepted, and per-commit hosts (8 hex characters followed by `-princess`) are rejected.

The webhook is shared: one branch at a time. `preview:point` prints `previousOrigin` (origin only) when the bot currently points at a different `workers.dev` preview, so you can see which branch you are taking it from. Pending updates are dropped by default.

If the preview does not respond before the timeout, check the URL in the Workers Builds comment on the pull request and point the webhook at it manually with `pnpm telegram:webhook:set:preview --url <url> --drop-pending-updates=true`.

Opt-in smoke test. This sends a synthetic `/start` update to the preview webhook, so the preview bot may reply in that chat. Use a preview-only chat id, there is no default:

```sh
pnpm preview:smoke --chat-id <id> [--user-id <id>] [--url https://<name>-princess.chernenko.workers.dev]
```

A negative chat id is sent as a supergroup message, any other id as a private chat. `--url` must be a `<name>-princess.chernenko.workers.dev` host. The command prints the target origin and chat id before it sends. `--user-id` sets the sender; without it a synthetic sender is used, which in a group is not a member and may take the bot's error path, so pass a real member id for group tests. `preview_smoke_accepted` only proves that the Worker answered HTTP 200 to the update. It does not prove that the bot replied or replied correctly, so check the chat.

Lower-level commands. `--url` is always explicit and must not be the production origin `https://princess.chernenko.workers.dev`:

```sh
pnpm telegram:webhook:set:preview --url https://preview-princess.chernenko.workers.dev --drop-pending-updates=true
pnpm telegram:webhook:info:preview --url https://preview-princess.chernenko.workers.dev
pnpm telegram:webhook:delete:preview --drop-pending-updates=true
```

`--url` must be a bare `https://<name>.<account>.workers.dev` origin. `--drop-pending-updates=true|false` is mandatory for set and delete.

The raw `preview` commands load `.dev.vars.preview` the same way as `preview:point` (a shell `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_PATH` is ignored, and the file must exist). `set` and `delete` call Telegram `getMe` first and refuse to run unless the token belongs to `@princess_debug_bot`; `info` does not.

Branch name caveat. The computed slug is the lowercased branch name with every character outside `a-z0-9` replaced by `-`, and it must start with a letter. It has been verified only for simple names (letters, digits, and single `/` or `-`). The Workers docs state that the name defaults to the git branch and that the name and Worker name combined must not exceed 63 characters; they do not spell out the replacement rules. For names of 64 characters or more, Cloudflare shortens the branch name and adds a hash derived from the full branch name ([changelog](https://developers.cloudflare.com/changelog/post/2025-08-08-support-long-branch-names-preview-aliases/)). The exact result cannot be computed here, so the CLI fails for a `<slug>-princess` label over 63 characters unless the bot comment fallback finds the URL. Prefer short branch names.

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

`/propose` forwards the user's suggestion to the Telegram user whose numeric id is in the `ADMIN_ID` secret. That user must have started a chat with the bot once, or Telegram refuses the delivery. `ADMIN_ID` is a required production secret, so set it before the deploy:

```sh
printf %s "$ADMIN_ID" | pnpm exec wrangler secret put ADMIN_ID --env production
```

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

Group requirement: keep the bot an administrator in every group. Non-admin bots can only resolve recently seen members, which makes draws unfair, and Telegram only guarantees `getChatMember` for other users when the bot is an administrator. Admin status also lifts privacy mode (bot admins receive every group message), which the automatic vote relies on. The bot only calls `sendMessage`, `getChatMember` and `replyWithSticker`, so no individual admin permission (delete messages, ban, pin, change info, ...) is used; the status alone is enough. Humans who post as an anonymous admin arrive as `sender_chat` with a fake bot sender, and admin-only commands refuse them.

### The /debug command

`/debug` is a read-only support command available to every user, without admin rights and without the `@botname` suffix. When a user reports a problem, ask them to run it in the affected group and paste the reply.

It prints, all values in `<code>`:

- Chat: Telegram chat id, chat type, the caller's Telegram user id, and the live `getChatMember` status of the caller and of the bot (`unavailable` if Telegram refuses).
- Bot: `BOT_ENVIRONMENT` and the current release version.
- Game: whether the chat is registered, the `channels.id`, language, stored release version, `stopped_at`, `created_at`, `last_vote_at`, and the stored bot admin status with its `bot_admin_checked_at` (refreshed only daily, so compare it with the live status).
- Players: total, active and auto-joined counts, plus the caller's own player id, state and score.
- Last winner: `won_at`, mode and eligible count of the newest `vote_wins` row.
- Backup: reason, creation and expiry of the latest unexpired snapshot, which can exist even when the chat is no longer registered.

Privacy boundary: it never prints the snapshot payload, other players' ids or names, tokens or any secret. Dates are ISO-8601 UTC and `-` means empty.

Finding a chat or user: take the chat id from the reply and query `channels` by `telegram_chat_id` and `channel_snapshots` by `telegram_chat_id`, for example `pnpm db:query:prod --command "select * from channels where telegram_chat_id = -1001234567890"`. In a private chat the bot prints only the ids, so the same command is the way to read your own Telegram user id when a setting needs one.

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

### GitHub releases

The same `CHANGELOG.md` entries are also published as GitHub Releases, which appear in the repository's release feed. The body is the English text of each bullet (falling back to Ukrainian where there is no `en:` line), grouped like the Telegram announcement.

Nothing manual is needed. the `release` job in `.github/workflows/main.yml` runs after `validate` passes on every push to `main` (a merged PR or a direct push), so a failing build never gets a release. It runs `pnpm releases:github`, which creates a release for every version from 5.0.0 on that has none yet, oldest first, so the first run after merging also backfills 5.0.0 and 5.1.0. Each release is tagged on the commit that added its heading to `CHANGELOG.md` (found in git history), and the tag is named like the version (for example `5.1.0`). Versions that already have a release are skipped, so reruns are harmless.

The workflow only publishes release notes: it does not deploy and does not touch the Worker or the database. Its `contents: write` permission is scoped to that one job.

Optional local tools:

```sh
pnpm releases:github --print --version 5.0.0
pnpm releases:github --version 4.0.1 --target <sha>
```

The first prints a release body without publishing. The second publishes an older version by hand (needs `gh auth login`); versions before 5.0.0 are never published automatically because their history is not tracked reliably.

## 9. Data and analytics

Workers keeps Cloudflare Logs and traces enabled. The Worker emits one safe evlog
wide event for each HTTP request, Telegram webhook outcome, scheduled run,
release broadcast, and release-announcement queue batch. Production events are
sent by evlog's OTLP drain to the New Relic EU endpoint in account `8569908`.
The `NEW_RELIC_LICENSE_KEY` secret exists only on the production Worker and in
the ignored `.dev.vars.production` file. Local development and previews do not
ingest into New Relic. Delivery is registered with `waitUntil`, and drain
failure only produces a local warning; it does not change bot behavior.

Use the enabled `Log_princess` data partition in account `8569908` (standard
30-day retention). Its partition rule is
`` `service.name` = 'princess' AND botEnvironment = 'production' ``. Filter by
those same attributes when querying logs. The `eventName`,
`outcome`, `durationMs`, `commandCategory`, `errorType`, counts and other safe
dimensions are top-level attributes for NRQL. Events contain normalized route
names and aggregate counts; they do not contain webhook paths, headers,
message text, bot tokens, Telegram IDs, or display names.

The [Princess production observability dashboard](https://one.eu.newrelic.com/dashboards/detail/ODU2OTkwOHxWSVp8REFTSEJPQVJEfGRhOjI3NjEzODE?account=8569908)
has 16 widgets for ingest freshness, webhook outcomes and latency, processing
and queue errors, scheduled run health, vote completions, command mix, and
release broadcast coverage. Its import template is in
`docs/newrelic-dashboard.json`. Queries read `Log_princess`, not the default
`Log` event type. The OTLP ingest path was verified with a single production
partition probe before deployment; operational event charts will populate after
the code reaches `main`. A zero error count does not prove the drain works.
Check ingest freshness and the most recent scheduled run together when
investigating missing data.

The separate [Princess game and audience dashboard](https://one.eu.newrelic.com/dashboards/detail/ODU2OTkwOHxWSVp8REFTSEJPQVJEfGRhOjI3NjEzODQ?account=8569908)
has two pages and 24 widgets. `Game & audience` shows active users and chats,
chats with a vote in the preceding seven days, the highest active player score,
memberships, wins per hour and by mode, eligible player counts, and the share of
registered chats where the bot has administrator rights. The admin pie also
shows `unknown` for unchecked or stale groups; it must not be read as
`nonAdmin`. Administrator rights matter because Telegram only guarantees
`getChatMember` for arbitrary members when the bot is an administrator, which
affects the eligible vote pool. `Commands &
lifecycle` shows completed joins, leaves, resets, pauses, forgets, restores, join outcomes, and
command request volume and categories. Its import template is
`docs/newrelic-behavior-dashboard.json`.

Both dashboard imports currently have New Relic's `Edit – everyone in account`
permission. The Settings control for changing it is disabled in this account,
and a JSON permission edit did not persist. Limit account membership to trusted
operators until the account permits `Read-only – everyone in account`.

Each production scheduled invocation refreshes administrator status for up to
10 unchecked or day-old groups, then emits a `bot_state_snapshot` after reading
aggregate counts from D1. An _active user_ has at least one active channel
membership; an _active chat_ has at least one active member. `registeredChats`
includes channels with no active members. `recentlyVotingChats` counts channels
whose most recent completed vote was in the preceding seven days. `topScore` is
the highest score of an active membership across chats; it is a score, not a
Telegram identity. Snapshot failure emits `bot_state_snapshot_failed` and does
not fail the release or maintenance task. The existing `*/10` cron is expected
to update snapshots every ten minutes, with a daily snapshot from the `0 0`
cron; use the `Snapshots in last hour` widget to catch missing cron activity.
Cloudflare Cron Events showed successful `*/10` production runs through
2026-09-30 19:50 UTC, confirming the trigger is active before this release.
The admin status check uses Telegram `getChatMember` for the bot itself and
stores only `admin`, `nonAdmin`, or `unavailable` plus check time in D1. It
emits three aggregate `bot_admin_status_count` events per snapshot, including
the `unknown` count for groups without a successful check in the last 48 hours.
At ten checks per ten-minute run, an initial scan of 217 registered groups
requires roughly four hours if the cron fires consistently. The pie uses the
latest count in each status category from the preceding two days.
The additive admin-status migration `20260930194648_messy_jetstream` was
applied to both production and preview D1 on 2026-09-30 before the Worker
release; preview still does not send New Relic data.

`bot_action_completed` is emitted after the game service mutation, before its
Telegram reply. A `join` result is `joined`, `reactivated`, or `already-active`;
the dashboard counts the first two as joins and exposes the last separately.
`leave`, `reset`, `stop` (a pause), `resume` (an admin `/start` on a paused
group), `forget`, and `restore` count only completed service calls. `vote_completed`
counts recorded wins for auto, manual, and sudo runs. `telegram_webhook_completed`
command categories count accepted command requests, not successful command
effects. None of these events include Telegram IDs, chat IDs, names, message
text, or per-chat membership lists. Behavior history starts when this PR is
deployed; earlier commands cannot be reconstructed from current D1 tables.

The official New Relic `apm` and `newrelic-mcp`, Cloudflare `cloudflare`,
`wrangler`, and `workers-best-practices`, and evlog `analyze-logs` and
`review-logging-patterns` skills are copied into `.agents/skills/` through
`npx skills` and tracked by `skills-lock.json`. Codex uses
`.codex/config.toml` for this project's New Relic MCP server. `.mcp.json` and
`.pi/mcp.json` provide the same EU endpoint to compatible clients. The URL is
`https://mcp.eu.newrelic.com/mcp/`. OAuth cannot complete until an account
administrator enables MCP Server and Local Clients in New Relic Feature
Control; the current account denies that feature. The ingestion key is not an
MCP credential. No Telegraf-specific or general Telegram Bot API engineering
skill with a relevant, maintained source was found in `npx skills`; use the
installed Telegraf types and the official Telegram Bot API documentation.

| Table                   | Purpose                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `players`               | Telegram users (`telegram_user_id`, `display_name`)                                                                                         |
| `channels`              | Telegram groups (`telegram_chat_id`, `language`, `release_version`, `last_vote_at`, `stopped_at`)                                           |
| `channel_members`       | Player in a channel (`score`, `is_active`, `is_auto_joined`)                                                                                |
| `vote_wins`             | One row per daily vote win (history, see below)                                                                                             |
| `release_announcements` | Announcement status per release version and channel                                                                                         |
| `channel_snapshots`     | Automatic backups taken before `/reset`, `/forget` and `/restore` (`reason`, JSON `payload`, `expires_at` after 7 days, at most 5 per chat) |
| `telegram_updates`      | Webhook idempotency ledger, pruned by the daily cron                                                                                        |

`vote_wins` columns: `channel_id`, `player_id`, `won_at` (ms timestamp), `mode` (`auto`, `manual`, `sudo`), `eligible_count` (number of eligible players at draw time, at least 2).

A group with a non-null `channels.stopped_at` is paused: `/stop` sets it, an admin `/start` clears it. While paused, `/run`, `/sudorun` and the automatic vote are refused and players and scores are kept. The release broadcast does not enqueue a paused group, and the queue consumer marks an already queued announcement for a group that was paused meanwhile as `skipped` without sending it. Inactive-group cleanup never deletes a paused group. Resuming sets `release_version` to the current release, so notes for releases shipped during the pause are never announced afterwards.

In group chats (`group` and `supergroup`) the destructive commands `/stop`, `/reset`, `/forget` and `/restore` only run when they address this bot (`/stop@<bot username>`, compared case-insensitively). A bare `/stop` reaches every bot in the group, so a middleware registered before the command handlers refuses it: it does not call the handler, changes no data, takes no snapshot and replies once with a hint that shows the explicit form. A command addressed to another bot (`/stop@otherbot`) is ignored exactly as before, without a reply. Private chats and all other commands (`/join`, `/run`, `/top` and the rest) are unaffected. The webhook `commandCategory` still counts a refused bare command as an accepted request, because it is recorded before the bot runs; there is no separate telemetry event for the refusal itself; only a failed hint send is reported, as the `group_command_hint_failed` internal failure (error type only). A failure while reading the group language falls back to the default language and the hint is still sent. `/start` in a group lists the explicit form with the real bot username, and the `/reset` and `/forget` confirmations tell admins to run `/restore@<bot username>`.

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

### Restoring a group's data

`/reset` and `/forget` first save a snapshot of the group in `channel_snapshots`: the channel row, every member with score and flags, and the full vote history, keyed by Telegram user id. A snapshot expires after 7 days. Expired rows are pruned on every snapshot insert and by the daily cron (not gated by `ENABLE_SCHEDULED_CLEANUP`), and `/restore` ignores them even before they are pruned. A group whose snapshot would exceed about 1.9 MB or need more than 900 restore statements is refused for `/reset` and `/forget` and logs `channel_snapshot_too_large`.

The preferred recovery is the group itself: an administrator runs `/restore` in the group. It restores the latest unexpired snapshot. If the group still has data, the current state is saved first as a `restore` snapshot, so a second `/restore` undoes the first. The group does not need a channel row, so it also works after `/forget`.

At most 5 snapshots are kept per Telegram chat. Every snapshot insert (`/reset`, `/forget` and the safety snapshot of `/restore`) deletes the chat's older rows beyond the newest 5 by `created_at` and `id` in the same D1 batch, so the cap holds even if the daily cron never runs. Other chats are not affected.

`/restore` is never blocked by the size of the current state. If the current data of the group would exceed the snapshot limits (about 1.9 MB or more than 900 restore statements), the safety `restore` snapshot is skipped, the restore still runs and `channel_restore_safety_snapshot_skipped` is logged with `bytes` and `estimatedStatements` only. In that case the post-incident state cannot be undone with a second `/restore`.

`/restore` always resumes a paused group: `stopped_at` is not restored and the restored channel starts unpaused. It also sets `release_version` to the current release, so notes for releases shipped while the group was paused or deleted are not announced after the restore or after a `/start` resume. Players that are in the group now but not in the snapshot are removed from the group, and their player rows are deleted when no other group uses them.

Inspect snapshots of a group:

```sh
pnpm db:query:prod --command "select id, reason, created_at, expires_at, length(payload) from channel_snapshots where telegram_chat_id = <id> order by created_at desc"
```

Extend the retention of a snapshot (milliseconds timestamp), then ask an admin to run `/restore`:

```sh
pnpm db:query:prod --command "update channel_snapshots set expires_at = <ms> where id = <id>"
```

Export a payload locally with `--json` for inspection. A payload holds Telegram user ids and display names: never commit it.

Erasure request for a group:

```sh
pnpm db:query:prod --command "delete from channel_snapshots where telegram_chat_id = <id>"
```

Last resort when no usable snapshot exists: D1 Time Travel. It restores the whole database, so every write made after the chosen time is lost for all groups. Never automate it.

1. `pnpm exec wrangler d1 time-travel info princess-production --env production` and record the current bookmark.
2. `pnpm exec wrangler d1 time-travel info princess-production --env production --timestamp <unix seconds>` to check the target point.
3. `pnpm exec wrangler d1 time-travel restore princess-production --env production --timestamp <unix seconds>`.
4. Export the rows of the affected group.
5. `pnpm exec wrangler d1 time-travel restore princess-production --env production --bookmark <bookmark from step 1>` to return to the present.
6. Re-insert the exported rows.

## 10. Known issues and open follow-ups

- The daily `telegram_updates` ledger prune depends on the cron.
- D1 error 7403 on the first call of a session: rerun.
- `ENABLE_SCHEDULED_CLEANUP` stays `"false"` on production until the deletion set is reviewed. Paused groups (`stopped_at` set) are never deleted by it.
- Decide when to retire MongoDB Atlas (currently backup and re-import source only).
- Rotate the bot tokens and webhook secrets.
- Add edge rate limiting.
- Create the GitHub `preview` environment for the copy workflow (see [section 5](#github-workflow-alternative)).

## 11. Why wrangler.jsonc and not the cf CLI

Evaluated on 2026-09-30 by running `cf migrate` on a throwaway branch (`chore/evaluate-cf-migrate`) and reading the Cloudflare docs. Decision: stay on `wrangler.jsonc` and Wrangler.

What `cf` is: an open beta (`cf@1.0.0-beta.x`, announced 2026-09-28) that exposes the whole Cloudflare API (about 2,900 commands against about 280 in Wrangler), defaults to JSON output for agents, and reads a typed `cloudflare.config.ts` (`defineConfig((ctx) => ...)` with `ctx.mode` and `ctx.isPreview`). Sources: [blog](https://blog.cloudflare.com/cloudflare-cf-cli-launch/), [changelog](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/), [cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/).

Wrangler is not deprecated. When the beta ends Cloudflare ships a final Wrangler major that points to `cf`, then maintains it for 18 months. No beta end date is announced. Wrangler does not read `cloudflare.config.ts`, and `cf` reads `wrangler.jsonc` only through `cf migrate`.

Why not now:

- `cf migrate` output is not usable as generated: it inserts a `throw`, drops D1 `migrations_dir` and `preview_database_id`, and turns `env.production` into a `switch (ctx.mode)` selected with `--mode` instead of `--env`.
- `cf deploy` delegates the build to Wrangler, so Wrangler stays a dependency either way.
- `cf workers types` writes `.cloudflare/types/index.d.ts` (ignored) instead of the committed `worker-configuration.d.ts`, which breaks the CI drift gate and `tsconfig.json`.
- Commands this repo relies on have no `cf` equivalent: `wrangler tail`, `wrangler preview base-config secret put` (preview bot secrets) and `wrangler queues pause-delivery` (the emergency stop).
- `cf d1` commands take database IDs, while the scripts use the `DB` binding and the `princess-preview` name.
- `cf` needs `"type": "module"` and Node 22.18 or later. Workers Builds documentation does not mention `cf` or `cloudflare.config.ts`, and the dashboard deploy command is wired to Wrangler.
- `cf deploy --dry-run` is reported to print secret values ([cf#103](https://github.com/cloudflare/cf/issues/103)) and to skip the required-secrets check ([cf#104](https://github.com/cloudflare/cf/issues/104)).

Revisit when `cf` is GA, Workers Builds documents `cloudflare.config.ts`, and `tail`, preview base-config secrets and queue delivery pause exist in `cf`.

The `wrangler deploy --env production --dry-run` step in `main.yml` stays. A Workers Build on a PR branch produces a preview, so only this step checks the `production` environment shape before merge, and it needs no credentials.
