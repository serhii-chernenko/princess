# Migration Status and Cutover Runbook

Audit date: 2026-07-15  
Repository: `/Users/inevix/dev/main/princess`

This is the authoritative current-state audit and production cutover runbook. Use
[MIGRATION_PLAN.md](./MIGRATION_PLAN.md) for architectural history,
[USER_MIGRATION_TODO.md](./USER_MIGRATION_TODO.md) for the live checklist, and
[README.md](./README.md) for day-to-day commands.

## Executive Decision

The rewrite is substantial, but the production migration is **not finished**.
Do not switch the stable Telegram webhook yet.

The first production cutover is gated by:

1. Workers-runtime D1 integration coverage, not only mocked D1 contracts.
2. A confirmed Workers Paid plan for exact current behavior, or an approved
   reconciliation redesign.
3. Real Cloudflare resource IDs, secrets, routes, and a fresh Mongo export.
4. A reviewed data reconciliation and beta-only validation.

The current exact-parity design requires Workers Paid. The largest observed group
has 55 members. A vote now performs one actor membership check plus one 55-member
reconciliation, about 56 Telegram API subrequests before replies. That is an
improvement over the earlier actor check plus two full reconciliations, but it
still exceeds the Workers Free limit of 50 subrequests per invocation. See the
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Repository and Branch Evidence

- Current branch: `feat/migration-to-v5`.
- Local `main` and `origin/main`: `243967c`.
- Checked-in rewrite baseline at `HEAD`: `076c2bd`, seven commits ahead of main.
- `076c2bd` records Phase 7. Phase 8 is current, uncommitted worktree work.
- Therefore, staged removals and hardening visible in the worktree are not yet a
  reviewed or committed repository state, and they are not evidence of a live
  production migration.

## Main Compared with the Rewrite

| Concern           | `main` at `243967c`                               | Rewrite worktree                                                        |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Runtime           | Long-running Node.js process on a VPS             | Cloudflare Worker with Hono and strict TypeScript                       |
| Telegram delivery | Telegraf long polling                             | Telegraf webhook behind an exact, secret-checked route                  |
| Data              | MongoDB with Mongoose documents                   | Normalized Cloudflare D1 schema with Drizzle repositories               |
| Maintenance       | Cleanup and release fanout during process startup | Gated cron cleanup; proactive release fanout deliberately absent        |
| Deployment        | GitHub Actions to Ansible, Docker, and VPS        | Validated, serialized Wrangler deployment to stable/beta Workers        |
| Content/releases  | Hand-written JS i18n and `changelog.json`         | `typesafe-i18n`, Changesets, `CHANGELOG.md`, generated runtime manifest |

## Readiness by Layer

| Layer                  | Status                          | Meaning                                                                                                                                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rewrite implementation | In progress, mostly implemented | Commands, D1 repositories, webhook runtime, durable update ledger, migration tooling, and deployment scripts exist; runtime integration coverage remains.       |
| Repository readiness   | In progress                     | Phase 8 hardening and legacy deployment-file removals are uncommitted; Workers-runtime D1 coverage remains.                                                     |
| Remote provisioning    | Operator-blocked                | Stable and beta D1 IDs are still placeholders; account plan, secrets, and deployed routes are not proven by this repo audit.                                    |
| Data migration         | Tooling verified only           | A historical backup transformed and imported locally; production needs a fresh export and reconciliation.                                                       |
| Traffic cutover        | Not started                     | No audit evidence shows that the stable bot token now points at the Worker webhook.                                                                             |
| Legacy retirement      | Deferred                        | Repo deployment artifacts are being removed, but Mongo polling and the VPS must remain recoverable until live validation and delta reconciliation are complete. |

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

A fresh read-only GitHub-source smoke run resolved commit
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

The following implementation is visible now, subject to review, commit, and final
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
  the service itself and rejects beta even if that flag is misconfigured; targeted
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
  reclaimed after five minutes. Stable maintenance prunes processed ledger rows
  after seven days and processing rows abandoned for more than 24 hours with
  separate status-and-time-qualified deletes.
- **Operational gates and observability.** Cleanup is explicitly gated;
  environment-tagged structured logs, Workers Logs, and sampled traces are
  configured. Production and beta are available only on their custom domains;
  `workers.dev` is disabled. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
- **CI, check, format, and deployment hardening.** Oxfmt excludes generated
  binding/release/i18n artifacts, canonical checks run on pull requests and pushes,
  CI regenerates i18n, release, Wrangler-binding, and Drizzle artifacts and rejects
  tracked or untracked drift, and deploy dry-runs are checked before deployment.
  Third-party actions are pinned to full commit SHAs. A manual dispatch from `main`
  can deploy only the stable Worker through the `production` GitHub environment,
  without applying D1 migrations or changing Telegram webhooks. Stable deployment
  is serialized without cancelling an in-flight release. Repository administrators
  must separately configure required reviewers and `main` deployment protection;
  referencing the environment alone does not enforce those rules.
- **Release migration.** A major v5 Changeset exists. `CHANGELOG.md` remains the
  human history and `releases.generated.json` remains generated; it is not edited
  by hand.
- **Legacy recovery loader.** The polling runtime again reads ignored
  `env/.env.dev` or `env/.env.production`, including `MONGODB_URI`, rather than
  Worker `.dev.vars*` files.

Latest validation reports 70 passing tests, fresh generated Wrangler bindings,
and successful local, stable, and beta deployment dry-runs. Rerun these gates
after any further code or configuration change.

## Remaining Code and Design Gaps

### 1. Workers-Runtime D1 Coverage — Required Before Cutover

Current tests cover repository SQL shapes and Worker behavior with test doubles.
Add integration coverage in the Workers runtime against a real local D1 binding,
including schema migration, import, CAS contention, atomic score increments,
cleanup foreign keys, webhook duplicates, and failure recovery. The production
migrator uses Drizzle's D1 HTTP driver; keep it aligned with the
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
stable webhook.

The ledger still cannot put D1 mutations, Telegram API calls, and its terminal
record in one transaction. A Worker crash, timeout, lost response, or lease expiry
before terminalization can leave uncertain work; after the five-minute stale-lease
window a redelivery can repeat an earlier D1 or Telegram side effect. This is an
at-most-once error-path guard, not an exactly-once side-effect guarantee. A future
design should use a durable inbox, idempotent mutation-effect keys, and an outbox;
Telegram send methods still provide no application idempotency key. See
[Telegram `setWebhook`](https://core.telegram.org/bots/api#setwebhook).

### 3. Proactive Release Broadcast — Retired for v5 Cutover

Do not recreate the legacy startup loop as inline cron fanout. `/releases` remains
available, but automatic proactive broadcasting is retired for the v5 cutover.
If it returns later, use a Cloudflare
[Queue](https://developers.cloudflare.com/queues/) or
[Workflow](https://developers.cloudflare.com/workflows/) with per-channel durable
progress, bounded concurrency, retries, and idempotent release markers.

### 4. Workers Free Plan — Redesign Needed if Paid Is Rejected

Exact parity with the real 55-member group performs about 56 Telegram API
subrequests before replies, above Free's 50. The cutover decision is either:

- use Workers Paid for the current implementation; or
- redesign membership reconciliation as a product/architecture change, for
  example durable cached membership from Telegram membership updates or queued,
  resumable reconciliation. A group-size cap would also change product behavior.

Do not silently ship partial reconciliation or assume D1 batching fixes the
external Telegram subrequest count.

### 5. Stable/Beta Isolation — Required for Shared-Group Testing

Stable and beta currently bind the same production D1 database, while game tables
are keyed by Telegram chat/user rather than bot environment. They must not run in
the same Telegram group. For now, beta validation is beta-only. Before shared-group
or independent production use, give beta its own D1 database or namespace all
game data and constraints by bot environment. Wrangler environments create
distinct Workers, not automatically distinct resources; see
[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).

### 6. Cloudflare Edge Rate Limiting — Operator Hardening

Secret authentication and bounded bodies protect Worker code, but repository code
cannot enforce a trustworthy distributed source rate limit. Before cutover, add and
verify Cloudflare edge rate-limiting rules for the custom-domain webhook and
`/health` paths without blocking valid Telegram delivery. See
[Cloudflare rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).

### 7. Final Legacy Removal — Post-Cutover

Remove the polling code, Mongoose dependency, Mongo configuration, and live VPS
only after stable Worker validation, an agreed observation window, and explicit
confirmation that no D1 writes need to be reconciled back to Mongo.

## Safe Cutover Sequence

1. **Confirm capacity.** Confirm Workers Paid, or stop and approve a Free-plan
   reconciliation redesign before any production traffic changes.
2. **Provision Cloudflare.** Replace every production/beta D1 placeholder in
   `wrangler.jsonc`; verify the stable/beta Workers, custom domains, D1 binding,
   disabled `workers.dev` endpoints, account IDs, and API tokens. Store bot tokens
   and webhook secrets as secrets,
   not Wrangler `vars`; follow the
   [Workers secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).
   Create the GitHub `production` environment and configure required reviewers and
   a `main` deployment-branch rule before relying on the manual deploy job.
3. **Take a fresh Mongo export.** Follow
   [the MongoDB-to-D1 data runbook](./MONGO_TO_D1_RUNBOOK.md): export channels,
   players, scores, and statuses from the current source, publish only the four
   required files to the private backup repository, and record its reviewed commit
   SHA, timestamps, hashes, and source counts. Do not reuse the May 9 backup or
   treat the unfrozen GitHub smoke SHA as cutover input.
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
9. **Deploy without switching Telegram.** Deploy the beta and stable Worker code
   and bindings. Package scripts and CI intentionally keep D1 migration, Worker
   deployment, and Telegram webhook registration as separate operations.
10. **Check readiness.** Require a successful authenticated `/health` response with
    the webhook-secret header, configuration and D1 checks, inspect Workers Logs,
    and run read-only smoke checks.
11. **Register beta deliberately.** Set the beta webhook first and use
    `max_connections=1`. Explicitly decide whether `drop_pending_updates` is
    false/omitted (preserve and process the queue) or true (discard it). The helper
    intentionally omits this parameter; do not make the choice accidentally. Low
    concurrency complements the durable ledger but cannot make Telegram sends
    exactly once.
12. **Validate beta only.** Use the separate beta bot in a beta-only group. Verify
    commands, one daily vote, duplicate delivery behavior, scores, membership
    changes, errors, and logs. Never put stable and beta in the same group while
    sharing the current schema.
13. **Switch stable and monitor.** Point the stable bot at the stable Worker, keep
    `max_connections=1` initially, make the stable pending-update choice explicitly,
    verify `getWebhookInfo`, and monitor webhook errors, D1 errors, Telegram
    rate/permission errors, latency, and score changes.
14. **Review cleanup separately.** Generate the fresh deletion set, review channel
    and orphan-player IDs, take another bookmark/export, and only then change
    `ENABLE_SCHEDULED_CLEANUP` from its remote default of `false`.

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

Keep the VPS/Mongo recovery path available until the stable observation window and
delta review are complete. Legacy retirement is the final step, not the rollback
mechanism for the first cutover.
