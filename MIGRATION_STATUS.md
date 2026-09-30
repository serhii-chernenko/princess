# Migration Status and Cutover Runbook

Audit date: 2026-09-29  
Repository: `/Users/inevix/dev/main/princess`

This is the authoritative current-state audit, cutover record, and (historical)
cutover runbook. The cutover is done; the sequence below is kept for reference and
any re-run. Use
[MIGRATION_PLAN.md](./MIGRATION_PLAN.md) for architectural history,
[USER_MIGRATION_TODO.md](./USER_MIGRATION_TODO.md) for the live checklist, and
[README.md](./README.md) for day-to-day commands.

## Executive Decision

The production cutover **happened on 2026-09-29**. The production Worker `princess`
serves the production bot on D1 and the legacy VPS bot is stopped and removed. The
observation window is now in progress; Mongo Atlas stays untouched as a backup and
re-import source. See the [Cutover record](#cutover-record).

`BOT_ENVIRONMENT` for the production Worker changed from `stable` to `production`.
The update-ledger bot key is `sha256(BOT_ENVIRONMENT:BOT_TOKEN)`, so processed-update
deduplication restarts at the deploy that carries this change; older ledger rows are
pruned by the normal seven-day maintenance.

Remaining follow-ups (none block traffic):

1. Rotate the production and preview bot tokens if desired (they were shared in chat).
2. Decide on Mongo Atlas retirement after the observation window.
3. Enable scheduled cleanup only after reviewing the deletion set.
4. Configure the GitHub `preview` environment secrets/variables for the copy workflow
   (used by the manual production-to-preview copy).
5. Investigate Cron Triggers: the schedules are registered (the dashboard shows
   `*/10 * * * *` with a next run) but Cloudflare has not invoked them; Workers
   Observability shows no `scheduled` events. Release announcements do not depend
   on the cron, but the daily ledger prune does.
6. Add Cloudflare edge rate limiting for the webhook and `/health` paths.
7. Keep the Preview base-config secrets (preview bot token) and the `princess-preview`
   D1 and queue current (see [Worker Previews](#worker-previews)).

Workers Paid is enabled (verified). The exact-parity design requires it: for a vote
in a group of N members the Worker makes 1 actor `getChatMember`, N reconciliation
`getChatMember` calls, and 2 replies; `getMe` is cached per isolate. For the largest
observed group (N=55) that is 58 subrequests, above the Workers Free limit of 50.
D1 queries also count toward per-invocation limits: about 8 in the base path, up to
about 8+2N with membership drift. See the
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Cutover Record

All times UTC, 2026-09-29.

- **Legacy freeze.** VPS container `princess_bot` restart policy set to `no` and
  stopped at 17:48:52Z. It was later removed together with image
  `princess_bot_image` and `/home/inevix/apps/princess`; other containers on the
  VPS were untouched. Legacy Mongo lives in MongoDB Atlas (not on the VPS) and is
  the rollback source; nothing was deleted there.
- **Post-freeze export.** The `backup-dbs` workflow (now has `workflow_dispatch`)
  produced `princess-db` commit `d97cd8e7e072d6c13ab750238f4075f1da42de6c` at
  17:49:43Z, the pinned import source.
- **D1.** `princess-production` `19c5b5dd-ac9e-43ff-9a0a-40c77c39d1d1` and
  `princess-preview` `b9a13fb8-8745-4d33-a5a2-f067b7b35220`, created with the `cf` CLI
  (location hint `eeur`). Migrations were applied in `wrangler-login` mode; the first
  production attempt returned a transient D1 7403 and the rerun found all three
  migrations applied. Production was imported from the pinned SHA. Reconciliation
  matched Mongo exactly: 217 channels, 886 players, 939 memberships, score sum
  21192, 648 active, 920 auto, 44 channels with a vote, 0 foreign-key violations.
  The preview D1 was imported from the local backup.
- **Workers.** Production Worker renamed to `princess` (briefly `princess-stable`,
  deleted) on custom domain `princess.chernenko.dev` with the daily cron; cleanup
  is still disabled. Secrets `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and
  `TELEGRAM_WEBHOOK_PATH` were set via `cf workers secrets update`; local copies live
  in git-ignored `.dev.vars.production` and `.dev.vars.preview`. `env/.env.d1` holds account and
  database IDs plus `CLOUDFLARE_AUTH_MODE=wrangler-login` (no tokens).
- **Webhooks.** Production was set at
  17:52:44Z with `drop_pending_updates=false`, `max_connections=1`, and
  `allowed_updates` `message`.
- **Incident.** Queued non-message updates from the polling era (legacy received
  all update types) got 400 from the Worker and stalled the queue (pending grew to
  about 35). The hotfix makes updates without `message` return
  `200 {ignored:true}`; the queue drained to 0 by 17:56:43Z with no further errors.
  The 404s seen are internet scanners.
- **CD.** Cloudflare Workers Builds is connected to `serhii-chernenko/princess`.
  `princess` builds from `main` (build `pnpm run i18n:generate`, deploy
  `pnpm exec wrangler deploy --env production && pnpm releases:broadcast:prod`,
  with build variables `WORKER_BASE_URL` and secret `TELEGRAM_WEBHOOK_SECRET`).
  Workers Builds also creates a preview for every other branch. The build token is the account's
  generic "Workers Builds" token. The GitHub repo secrets/variables of the old VPS
  deploy were deleted; GitHub CI only validates.
- **Go-live of 5.0.0.** Migration `20260929183002_mysterious_freak` was applied to
  `princess-production` before the merge. The production queue was paused, PR #1
  merged into `main` at 19:45:50Z as `24a17c6`, and the Workers Build deployed and
  enqueued 217 announcements. Delivery was resumed at 19:47:30Z and drained by
  19:51:38Z: 90 sent, 125 skipped with 400 (chat gone), 2 skipped with 403, 0
  ambiguous, 0 failed. `feat/migration-to-v5` was deleted.
- **Vote history migration.** Migration `20260930070822_thankful_magma` adds `vote_wins`.
  Apply it to `princess-production` (`pnpm run db:migrate:prod`) and `princess-preview`
  (`pnpm run db:migrate:preview`) BEFORE merging, because Workers Builds deploys code but
  does not run migrations.
- **Former beta retired.** On 2026-09-29 the former beta Worker, D1, queues, and
  branch were retired in favour of previews and deleted.

### Finding: legacy winners were limited to resolvable members

Legacy winners were effectively limited to members the bot could resolve via
`getChatMember`. A non-admin bot only resolves recently seen users, and legacy
swallowed lookup errors. Evidence: the legacy `/top` showed 6 of 14 point-holders,
and statistically 15 of 29 active members never won in 166 votes. The rewrite with
an administrator bot resolves all members.

Operator note: keep the bot an administrator in groups for fair draws. The rewrite
treats `400 PARTICIPANT_ID_INVALID` as "not a member".

## Repository and Branch Evidence

- The rewrite was merged into `main` by PR #1 as merge commit `24a17c6`, keeping
  the per-phase history (including the WIP commit `be567a8`).
- `main` deploys production; testing uses Worker Previews.
- The cutover itself is recorded in the [Cutover record](#cutover-record).

## Main Compared with the Rewrite

| Concern           | `main` at `243967c`                               | Rewrite worktree                                                        |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Runtime           | Long-running Node.js process on a VPS             | Cloudflare Worker with Hono and strict TypeScript                       |
| Telegram delivery | Telegraf long polling                             | Telegraf webhook behind an exact, secret-checked route                  |
| Data              | MongoDB with Mongoose documents                   | Normalized Cloudflare D1 schema with Drizzle repositories               |
| Maintenance       | Cleanup and release fanout during process startup | Gated cron cleanup; release announcements via Cloudflare Queues         |
| Deployment        | GitHub Actions to Ansible, Docker, and VPS        | GitHub Actions validate; Cloudflare Workers Builds deploy production    |
| Content/releases  | Hand-written JS i18n and `changelog.json`         | `typesafe-i18n`, Changesets, `CHANGELOG.md`, generated runtime manifest |

## Readiness by Layer

| Layer                  | Status                    | Meaning                                                                                                                                            |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rewrite implementation | Live                      | Commands, D1 repositories, webhook runtime, update ledger, migration tooling, and Workers-runtime D1 integration tests exist and serve production. |
| Repository readiness   | Pending review and commit | The follow-up worktree (hotfix, workflow and docs changes) needs review, a proper commit, and the merge to `main`.                                 |
| Remote provisioning    | Done                      | Real D1 IDs, Workers on custom domains, secrets, and Workers Paid are in place; Workers Builds deploys both Workers.                               |
| Data migration         | Done                      | Frozen export imported into production D1 and reconciled exactly against Mongo.                                                                    |
| Traffic cutover        | Done                      | Production webhook points at `princess` since 17:52:44Z; queue drained, no further errors.                                                         |
| Legacy retirement      | Partly done               | VPS container, image, and app directory removed. Legacy code removed from the repository. Mongo Atlas retained as a backup and re-import source.   |

## Verified Historical Backup Evidence

The ignored local `princess-db/` backup files are timestamped 2026-05-09. The
generated, also ignored `.backups/mongo-to-d1.report.json` records:

- source: 225 channels, 974 players, 1,040 scores, and 1,040 statuses;
- transformed: 225 channels, 974 players, and 1,040 channel memberships;
- skipped: zero duplicate channels, players, or memberships, and zero missing
  player, score, or status references.

This proves the transformation against that snapshot only. The backup is stale
and is **not valid cutover input**. Never add `princess-db/`, generated SQL, or
backup reports to git.

A fresh read-only GitHub-source test run resolved commit
`4b9ebd56e45a52547258886866cfb943da03f620` and validated 223 channels, 979
players, 1,045 scores, and 1,045 statuses, transforming them into 223 channels,
979 players, and 1,045 memberships with no skipped records. This is evidence that
the direct GitHub fetch and validation pipeline works at that pinned SHA. The run
was not taken under the documented source freeze and is **not frozen cutover
input**.

A local deletion review against the imported snapshot, using the current
`now - 30 days` cutoff, selected 54 stale channels, 796 distinct candidate
players, and 767 players that would become orphans. These are review estimates,
not authorization to delete production data. Inspect the actual fresh-cutover
set before enabling cleanup.

## Implemented in the Current Worktree

The following implementation is visible now (Phase 8 in `be567a8` plus the
uncommitted 2026-09-29 follow-up), subject to review, commit, and final
verification:

- **D1-compatible import.** Generated SQL is insert-only and fail-closed. It does
  not use `ON CONFLICT` to overwrite state and leaves transaction management to
  `wrangler d1 execute --file`. Inserts remain conservatively chunked below D1's
  100-bound-parameter ceiling. See Cloudflare's
  [D1 import/export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
  and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- **Set-based cleanup.** Candidate players are selected once, stale channels are
  deleted as a set, and now-orphaned players are deleted with `NOT EXISTS` in
  chunks of 90 IDs. Global cleanup requires `ENABLE_SCHEDULED_CLEANUP="true"` in
  the service itself and rejects preview even if that flag is misconfigured; targeted
  `/stop` remains available. Remote cleanup defaults to false.
- **Safer daily vote.** The channel run timestamp is claimed with compare-and-set,
  the winner score uses an atomic SQL increment, a failed score update restores
  the claim when still owned, and the vote reuses a single membership
  reconciliation.
- **Fail-closed Worker boundary.** The Worker requires the configured exact path,
  required bindings, a valid timing-safe secret, JSON content type, an authenticated
  1 MiB body cap, parseable JSON, a nonnegative safe-integer `update_id`, and a
  minimally valid `message` update. `/health` requires the same secret before its
  D1 readiness query. Generated bindings and required-secret declarations are
  present.
- **Durable Telegram update claim and deduplication.** A D1 ledger is uniquely
  keyed by a bot-specific derived key plus `update_id`. New updates are claimed
  atomically; terminalized duplicates are acknowledged without rerunning Telegraf;
  concurrent processing returns a retryable error. Once Telegraf dispatch starts,
  both success and a caught dispatch failure attempt to terminalize the matching
  lease; the failure path never deletes the claim. Successful terminalization
  makes the next delivery a duplicate. An abandoned processing claim can be
  reclaimed after five minutes. Production maintenance prunes processed ledger rows
  after seven days and processing rows abandoned for more than 24 hours with
  separate status-and-time-qualified deletes.
- **Operational gates and observability.** Cleanup is explicitly gated;
  environment-tagged structured logs, Workers Logs, and sampled traces are
  configured. Production is available only on its custom domain; `workers.dev` is
  disabled (previews use `preview_urls`). See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
- **CI, check, format, and deployment hardening.** Oxfmt excludes generated
  binding/release/i18n artifacts, canonical checks run on pull requests and pushes,
  CI regenerates i18n, release, Wrangler-binding, and Drizzle artifacts and rejects
  tracked or untracked drift, and deploy dry-runs run in CI.
  Third-party actions are pinned to full commit SHAs. The workflow only validates:
  the manual GitHub deploy job was removed because Cloudflare Workers Builds now
  deploys production. D1 migrations and Telegram webhook changes remain
  separate operator actions.
- **Release migration.** The v5.0.0 release is cut with bilingual (Ukrainian and
  English) notes. `CHANGELOG.md` remains the human history and
  `releases.generated.json` remains generated; it is not edited by hand.
- **Legacy removal.** The legacy polling code (`bot/`), its Mongoose dependency,
  its env loader, and its tests are deleted; git history keeps them.

The full `pnpm test` suite passes (221 tests, including the integration tests), with
fresh generated Wrangler bindings and successful local and production
deployment dry-runs. The test script quotes its globs so nested test directories
run. Rerun these gates after any further code or configuration change.

## 2026-09-29 Review

Runtime parity fixes made against the legacy behavior:

- Auto-run with fewer than two active players no longer clears the schedule.
- A `getChatMember` failure other than Telegram 400 aborts the vote before the
  claim instead of silently shrinking the pool: silent in auto, a generic error
  reply in manual. `/list` and `/top` are affected the same way.
- Listener errors are always silent; the generic "Ой лишенько" reply is restored
  for unexpected command errors.
- `/join` and `/leave` reject bots; `/lang` requires an existing channel and an
  admin.
- Tie order is deterministic; sticker replies target the trigger message.
- A `vote_announcement_failed` event is logged when the announcement fails after
  the claim; the claim is kept (at-most-once).
- The route returns 200 after a terminalized dispatch failure; `botInfo` is cached
  per isolate.
- Post-cutover hotfix: updates without `message` return `200 {ignored:true}`
  instead of 400 (see the incident in the Cutover record).

Intentional remaining differences from legacy:

- `/run` answers a lost compare-and-set race with its own reply.
- Cron cleanup stays off on production until the deletion set is reviewed.
- Release broadcast is restored through Cloudflare Queues; `/lang` is new; names are
  HTML-escaped.
- Chats that block or remove the bot are marked `skipped` on the announcement row
  and are not deleted (legacy deleted the channel on 403).
- A crashed dispatch can be re-run after the five-minute stale reclaim:
  at-least-once for crashes. The vote is guarded by compare-and-set; `/stop` and
  `/reset` are not.
- Concurrent `/sudorun` is not compare-and-set guarded (admin override).

## Remaining Code and Design Gaps

### 1. Workers-Runtime D1 Coverage — Done

`test/integration/*.test.ts` run against a real local D1 through wrangler
`getPlatformProxy`: migrations, update-ledger concurrency and stale reclaim,
compare-and-set daily claim under 15 racers, atomic score increments, cleanup
chunking over 100 IDs with cascades, Mongo import SQL execution and rerun
rejection, and end-to-end webhook dispatch with duplicate and concurrent
delivery. The production migrator uses Drizzle's D1 HTTP driver; keep it aligned
with the
[Drizzle D1 HTTP migration guide](https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit).

### 2. At-Most-Once Error Path — Explicit Reliability Decision

The ledger prevents concurrent handling and suppresses later retries after D1
records a terminal state. A caught Telegraf error is terminalized instead of
released, so an automatic retry is acknowledged as a duplicate and cannot rerun a
partially completed `/sudorun`. If terminalization itself cannot be confirmed, the
Worker returns success to avoid deliberately requesting a replay; this favors
at-most-once execution and may lose an unfinished command or reply. It is an
explicit reliability decision for cutover, not a general failure-recovery path.

Cutover acceptance requires `max_connections=1`, no `/sudorun` during cutover or
data reconciliation, and a stop-and-inspect response to
`telegram_update_dispatch_failed`, `telegram_update_terminalization_failed`,
`telegram_update_lease_lost`, or `telegram_update_claim_reclaimed`. Operators must
accept the remaining possibility of a lost command or reply before switching the
production webhook.

The ledger still cannot put D1 mutations, Telegram API calls, and its terminal
record in one transaction. A Worker crash, timeout, lost response, or lease expiry
before terminalization can leave uncertain work; after the five-minute stale-lease
window a redelivery can repeat an earlier D1 or Telegram side effect. This is an
at-most-once error-path guard, not an exactly-once side-effect guarantee. A future
design should use a durable inbox, idempotent mutation-effect keys, and an outbox;
Telegram send methods still provide no application idempotency key. See
[Telegram `setWebhook`](https://core.telegram.org/bots/api#setwebhook).

### 3. Release Broadcast — Restored with Cloudflare Queues

The legacy startup loop is replaced by a queue-based announcement pipeline.

- **Producer.** A `*/10 * * * *` cron on production runs when
  `ENABLE_RELEASE_BROADCAST` is `"true"` (`"false"` locally). It selects channels
  whose `release_version` is semver-lower than the newest manifest version and that
  have no `release_announcements` row for it, inserts rows with insert-or-ignore
  (chunked at 16 rows, 96 bound parameters), and enqueues only the rows that run
  inserted, in batches of at most 100.
- **Consumer.** Sequential, at least 50 ms between sends. Delivery is at-most-once
  on ambiguity: the row moves `queued` to `sending` by compare-and-set before the
  Telegram call. Success marks it `sent` (state write retried three times, never
  resent) and stores the version on the channel. No Telegram response, any 5xx
  (Telegram may have delivered before erroring), or a redelivery of a `sending` row
  marks it `skipped` with the status code or no code (`release_announcement_ambiguous`). 403 and permanent 400 mark it `skipped` with
  the code. 400 with `migrate_to_chat_id` updates the chat id and sends once more,
  or skips on a chat id conflict. Other 400 marks it `failed` without bumping the
  version. 429 re-enqueues a fresh job after `retry_after + 1` seconds (never
  counts toward `max_retries`). Handler errors retry with 30 s doubling backoff
  capped at one hour (`max_retries` 5). Kill switch: the `ENABLE_RELEASE_BROADCAST`
  variable requires a redeploy; while off the consumer retries every message after
  600 s without sending, jobs land in the DLQ after about 50 min, and rows stay
  `queued`. The fast emergency stop is
  `pnpm exec wrangler queues pause-delivery princess-release-announcements`
  (resume with `resume-delivery`). Invalid or non-latest-version jobs are
  acknowledged.
- **Stale recovery.** The cron re-enqueues `queued` rows older than 3 hours and marks
  `sending` rows older than 3 hours `skipped`.
- **Queues.** Production: `princess-release-announcements`, DLQ
  `princess-release-announcements-dlq`. Previews: producer-only
  `princess-preview-release-announcements` (no consumer). Local:
  `princess-local-release-announcements`. Consumers use batch size 10, batch timeout
  5 s, `max_concurrency` 1.
- **Deviation from legacy.** Channels are never deleted on 403 or 400; the row is
  marked `skipped` so members and scores survive a bot re-add.
- **Not copied to preview.** `release_announcements` is excluded from
  `db:copy:production-to-preview`, like `telegram_updates`.

### 4. Workers Paid — Enabled

Workers Paid is enabled (verified). Exact parity needs it: a 55-member group makes 56
Telegram subrequests before replies (58 total), above Free's 50, and D1 queries
count toward the same per-invocation limits. Do not silently ship partial reconciliation or assume D1 batching fixes
the external Telegram subrequest count.

### 5. Production/Preview Isolation — Provisioned

Worker Previews of the production Worker use their own D1 database,
`princess-preview` (`b9a13fb8-8745-4d33-a5a2-f067b7b35220`), configured in
`env.production.previews` in `wrangler.jsonc`. Its ID is
`CLOUDFLARE_PREVIEW_DATABASE_ID` (`env/.env.d1` locally, the GitHub `preview`
environment in CI). Migrate it with `pnpm db:migrate:preview`.

`pnpm db:copy:production-to-preview --confirm-overwrite-preview`, or the manual
workflow `.github/workflows/copy-production-to-preview.yml` (`main` only, `preview`
environment, typed confirmation `OVERWRITE PREVIEW`), copies production to preview.
It needs `CLOUDFLARE_API_TOKEN` (secret) with D1 edit on both databases plus
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and `CLOUDFLARE_PREVIEW_DATABASE_ID`
(variables). A local backup can be imported instead with `pnpm db:import:preview`
(the target must be empty). The copy:

- has a hard-coded production-to-preview direction and requires distinct database ids;
- copies `players`, `channels`, and `channel_members` only, not
  `__drizzle_migrations` or `telegram_updates`;
- requires matching migrations, wipes preview in foreign-key-safe chunks, and
  verifies counts.

Caveats:

- A remote `d1 export` makes production D1 unavailable to queries while it runs;
  run it only in a low-traffic window.
- Production writes after the export are not copied and can cause a count
  mismatch; rerun.
- A mid-way failure leaves preview partly wiped; rerunning is safe.
- Preview then holds production PII (Telegram IDs, names, usernames, group titles):
  restrict access to the preview D1 and logs, and define retention. Erasure on
  production does not reach preview until the next copy.

The GitHub `preview` environment secrets/variables are not configured yet. Restrict
the environment to deployment branch `main` with required reviewers; the workflow's
`if` guard alone does not stop a branch-edited workflow from using preview secrets.
Consider CODEOWNERS or branch protection on `.github/workflows/`, `scripts/db/`,
and `wrangler.jsonc`. Store the copy's `CLOUDFLARE_API_TOKEN` as a `preview`
environment secret scoped to D1 only, ideally split into a production-D1 read token
(export) and a preview-D1 edit token (wipe/import); with one shared token, code
guards are the only thing preventing production writes.

Never point a preview at the production database. The copy direction is production
to preview only. Wrangler environments create distinct Workers, not distinct
resources; see
[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).

### 6. Cloudflare Edge Rate Limiting — Operator Hardening (open)

Secret authentication and bounded bodies protect Worker code, but repository code
cannot enforce a trustworthy distributed source rate limit. Add and verify Cloudflare edge rate-limiting rules for the custom-domain webhook and
`/health` paths without blocking valid Telegram delivery. See
[Cloudflare rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).

Related security notes: invocation logs at 100% may record the secret webhook path
URL, so disable `invocation_logs` or treat the path as non-secret; `/health` reuses
`TELEGRAM_WEBHOOK_SECRET`, so consider a separate token.

### 7. Final Legacy Removal — Done

The VPS deployment and the legacy polling code, Mongoose dependency, and legacy
Mongo env loader are removed. Only the Mongo to D1 import tooling in `scripts/db`
remains. Retiring Mongo Atlas itself is a separate decision after the observation
window.

## Safe Cutover Sequence (executed 2026-09-29)

This is the sequence that was followed; see the Cutover record for what actually
happened. Reuse it for any re-run.

1. **Enable capacity.** Enable Workers Paid (decided) before any production
   traffic changes.
2. **Provision Cloudflare.** Create the preview D1 `princess-preview` and replace every
   production/preview D1 placeholder in `wrangler.jsonc`; set
   `CLOUDFLARE_PREVIEW_DATABASE_ID` and run `pnpm db:migrate:preview`; verify the production Worker, custom domain, D1 binding,
   disabled `workers.dev` endpoints, account IDs, and API tokens. Store bot tokens
   and webhook secrets as secrets,
   not Wrangler `vars`; follow the
   [Workers secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).
   Create the GitHub `preview` environment and configure required reviewers and a
   `main` deployment-branch rule before relying on the copy workflow. Runtime
   secrets live on the Workers, not in GitHub.
3. **Take a fresh Mongo export.** Follow
   [the MongoDB-to-D1 data runbook](./MONGO_TO_D1_RUNBOOK.md): export channels,
   players, scores, and statuses from the current source, publish only the four
   required files to the private backup repository, and record its reviewed commit
   SHA, timestamps, hashes, and source counts. Do not reuse the May 9 backup or
   treat the unfrozen GitHub test SHA as cutover input.
4. **Freeze the source.** Stop the legacy polling process and confirm that no
   Mongo-writing bot instance remains. Record the freeze time. Do not let polling
   and webhook runtimes write concurrently.
5. **Protect the D1 target.** Record the current D1 Time Travel bookmark and make
   an export before schema/data changes. Time Travel is point-in-time recovery for
   D1, not cross-database rollback; see
   [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
6. **Apply schema migrations.** Run the reviewed Drizzle production migrations
   against the intended D1 database exactly once and inspect the migration log.
7. **Generate and import once.** Set `MONGO_BACKUP_REF` to the reviewed full commit
   SHA and run the production import wrapper. It fetches and validates in memory,
   proves the application tables are empty, executes insert-only SQL once, retains
   its JSON report, and removes the transient SQL file. A rerun must fail rather
   than overwrite live rows.
8. **Reconcile before traffic.** Compare source and target channel, player, score,
   status/membership, and inactive counts. Check foreign-key violations, unique
   constraints, score totals/distribution, active/auto flags, timestamps, release
   versions, languages, and several known large/small/sample groups.
9. **Deploy without switching Telegram.** Cloudflare Workers Builds deploys the
   production Worker code and bindings. D1 migration and Telegram webhook
   registration remain separate operator actions.
10. **Check readiness.** Require a successful authenticated `/health` response with
    the webhook-secret header, configuration and D1 checks, inspect Workers Logs,
    and run read-only checks.
11. **Register the preview webhook deliberately.** Optionally refresh preview from
    production with `pnpm db:copy:production-to-preview --confirm-overwrite-preview`.
    Set the preview bot webhook to a preview first with `--url`, and use
    `max_connections=1`. Decide whether pending updates are
    preserved or discarded: the helper requires
    `--drop-pending-updates=true|false` for production and preview (for example
    `pnpm telegram:webhook:set:preview -- --url <preview url> --drop-pending-updates=false`). Low
    concurrency complements the durable ledger but cannot make Telegram sends
    exactly once.
12. **Validate in a preview only.** Use the preview bot (@princess_debug_bot) with the preview D1. Verify
    commands, one daily vote, duplicate delivery behavior, scores, membership
    changes, errors, and logs. Never put the production and preview bots in the same group; the
    databases are separate but the bots would still both answer.
13. **Switch production and monitor.** Point the production bot at the production Worker, keep
    `max_connections=1` initially, pass the explicit production
    `--drop-pending-updates=true|false` choice (for example
    `pnpm telegram:webhook:set:prod --drop-pending-updates=false`), verify `getWebhookInfo`, and monitor webhook errors, D1 errors, Telegram
    rate/permission errors, latency, and score changes.
14. **Review cleanup separately.** Generate the fresh deletion set, review channel
    and orphan-player IDs, take another bookmark/export, and only then change
    `ENABLE_SCHEDULED_CLEANUP` from its remote default of `false`.

## Worker Previews

Wrangler is pinned to 4.143.1. All testing uses Worker Previews of the production
Worker `princess`: `env.production.previews` in `wrangler.jsonc` and
`env.production.preview_urls: true` (`workers_dev` stays `false`). A preview gets
the separate `princess-preview` D1, the producer-only
`princess-preview-release-announcements` queue, `BOT_ENVIRONMENT="preview"`, broadcast
and cleanup off, and no crons, consumers, or routes. Secrets come from the Preview
base config (the real preview bot token, @princess_debug_bot), and the preview bot's
webhook is pointed at a preview URL with `pnpm telegram:webhook:set:preview -- --url <preview url>
--drop-pending-updates=true|false`. See the README "Testing with Worker Previews"
section.

Infrastructure:

- Worker `princess` (production) with Worker Previews; Workers Builds deploys `main`
  and creates a preview per non-main branch, named after the branch.
- D1: `princess-production` and `princess-preview`.
- Queues: `princess-release-announcements` (+ `-dlq`) and
  `princess-preview-release-announcements` (producer only).
- The long-lived preview used by the preview bot is named `preview`
  (https://preview-princess.chernenko.workers.dev); the preview bot webhook points
  there. Redeploy it with `pnpm worker:preview --name preview`.

Notes:

- Previews never run cron triggers or queue consumers; only production owns them.
- All previews share the single `princess-preview` D1 and the preview bot's single
  webhook, so only one preview receives Telegram traffic at a time.
- `preview_urls: true` also exposes production version URLs on `workers.dev`,
  protected only by the webhook secret gating.
- Wrangler 4.143.1 cannot tail a preview; use Cloudflare dashboard observability.
- Open investigation: the production `*/10` cron has not fired on Builds-deployed
  versions. Production has two crons, `"0 0 * * *"` and `"*/10 * * * *"`.
  The cause is unknown.

## Rollback Rules

- **Before the webhook switch:** the source is frozen but authoritative. Roll back
  the Worker if needed and restart Mongo polling only after confirming no Worker
  writes occurred.
- **After the webhook switch but before any D1 write:** remove the webhook, confirm
  delivery has stopped, and restart polling with an explicit pending-update choice.
- **After D1 accepts writes:** there is no zero-loss automatic rollback. Stop new
  webhook traffic, export D1, identify all post-freeze deltas, and reconcile those
  changes into Mongo (or consciously accept documented loss) before restarting the
  polling bot. Simply restarting Mongo would discard D1-only joins, leaves, votes,
  scores, and channel changes.
- A Worker version rollback does not reverse D1 schema/data changes. D1 Time Travel
  can restore D1 itself and is destructive; it cannot copy accepted D1 writes back
  into Mongo or reconstruct Telegram side effects.

The VPS is deleted and the legacy code is removed from the repository, so
redeploying the legacy bot is no longer a supported rollback. Recovery means a
Worker version rollback plus D1 Time Travel, or re-importing from Mongo Atlas backups
with the import tooling (Atlas is retained, untouched, as a backup source).
