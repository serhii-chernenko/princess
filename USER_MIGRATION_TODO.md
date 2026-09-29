# User Migration Todo

Last updated: 2026-07-15

This is the concise progress checklist. Read
[MIGRATION_STATUS.md](./MIGRATION_STATUS.md) before any production action; it is
the authoritative audit, cutover sequence, and rollback policy. Use
[README.md](./README.md) for development and operator commands.

## Done in the Rewrite

- [x] Add the Cloudflare Workers, Hono, Telegraf webhook, strict TypeScript, D1,
      and Drizzle architecture.
- [x] Normalize channels, players, and memberships in split Drizzle schema files.
- [x] Port active commands, message-triggered daily voting, language selection,
      cleanup services, and `/releases` to the Worker path.
- [x] Add `typesafe-i18n`, Changesets, `CHANGELOG.md`, and the generated runtime
      release manifest.
- [x] Add local and D1 HTTP migration flows plus an insert-only, conservatively
      chunked Mongo-to-D1 import generator.
- [x] Add the direct private-GitHub backup pipeline, immutable-SHA production gate,
      runtime field/reference/ownership validation, source hash/count report,
      empty-target D1 preflight, and one-shot local/production wrappers that remove
      transient SQL.
- [x] Validate the 2026-05-09 local backup transformation: 225 channels, 974
      players, and 1,040 memberships with zero skips. This backup is stale and is not
      cutover input.
- [x] Smoke-test the direct GitHub pipeline at pinned SHA
      `4b9ebd56e45a52547258886866cfb943da03f620`: 223 channels, 979 players,
      and 1,045 memberships with zero skips. This read-only run was not made under a
      source freeze and is not cutover input.
- [x] Replace the checked-in VPS deploy workflow with validation on pushes/PRs and
      manual-only, serialized, Worker-only Wrangler deployment for stable. Keep D1
      migration and Telegram webhook changes as separate operator actions.
- [x] Add compare-and-set daily-run claiming, atomic score increments, a single
      membership reconciliation, set-based cleanup, D1-safe orphan chunks, a
      fail-closed webhook boundary, readiness checks, cleanup gating, and structured
      observability in the current worktree.
- [x] Restore the legacy polling loader for ignored `env/.env.dev` and
      `env/.env.production` recovery files.
- [x] Add a bot-specific D1 `update_id` ledger with atomic claims, terminalized
      update deduplication, matching-lease terminalization, no automatic release after
      dispatch starts, five-minute stale-claim recovery, and a stable-owned pruning
      job after seven days. Caught failures that terminalize cannot replay; this is
      an explicit at-most-once reliability decision rather than general recovery.
- [x] Bound authenticated webhook JSON to 1 MiB, validate message-update shape,
      authenticate `/health` before D1, prune 24-hour abandoned claims, reject
      beta/disabled global cleanup, and disable production/beta `workers.dev`.
- [x] Retire proactive release broadcast for the v5 cutover; keep `/releases`.

## In Progress — Code and Repository Gates

- [ ] Add Workers-runtime integration tests against a real local D1 binding for
      migrations, imports, concurrent vote claims, atomic score updates, cleanup,
      duplicate updates, and failure recovery.
- [x] Run `pnpm run check`, generated-binding verification, and local/stable/beta
      deployment dry-runs. The latest suite reports 70/70 passing tests; rerun all
      gates after further code or configuration changes.
- [ ] Review and commit the current Phase 8 worktree; do not describe uncommitted
      file removals as completed repository history.
- [ ] Decide the stable/beta data-isolation design. Until then, keep beta in a
      beta-only Telegram group and never test both bots in the same group.

## Operator-Blocked — Before and During Cutover

- [ ] Confirm Workers Paid for exact parity with the real 55-member group. If Paid
      is rejected, stop and approve a reconciliation redesign; the current vote uses
      about 56 Telegram API subrequests before replies, above Free's limit of 50.
- [ ] Create/verify the production D1 database, replace all D1 placeholders in
      `wrangler.jsonc`, and verify stable/beta custom domains and bindings.
- [ ] Configure Cloudflare control-plane credentials, per-bot runtime secrets, and
      GitHub deployment secrets/variables without committing secret files.
- [ ] Create the GitHub `production` environment and configure required reviewers
      plus a `main` deployment-branch rule. The workflow reference does not create
      those protections.
- [ ] Configure and validate Cloudflare edge rate-limiting rules for the webhook and
      authenticated `/health` paths without blocking Telegram delivery.
- [ ] Follow [MONGO_TO_D1_RUNBOOK.md](./MONGO_TO_D1_RUNBOOK.md): take a fresh
      frozen Mongo export, publish the four expected root files to the private
      backup repository, and record its reviewed full SHA, timestamp, hashes, and
      counts.
- [ ] Stop/freeze every Mongo-writing polling process and record the freeze time.
- [ ] Record a D1 Time Travel bookmark and export the target before changes.
- [ ] Apply the reviewed production schema migration.
- [ ] Set `MONGO_BACKUP_REF` to the reviewed SHA, run the one-shot production
      import, inspect its retained report, and confirm the transient SQL was
      removed and all D1 application tables were empty before import.
- [ ] Reconcile source/target counts, foreign keys, score totals/distribution,
      active/auto statuses, releases/languages, timestamps, and sample groups.
- [ ] Deploy the Worker without switching the stable webhook and require an
      authenticated healthy configuration/D1 response plus clean logs.
- [ ] Set the beta webhook with `max_connections=1` and a deliberate
      `drop_pending_updates` choice; validate only in a beta-only group.
- [ ] Set the stable webhook with the same deliberate choices, verify
      `getWebhookInfo`, and monitor errors, latency, membership, and score changes.
- [ ] Explicitly accept the webhook at-most-once error policy: keep
      `max_connections=1`, do not use `/sudorun` during cutover/reconciliation,
      stop and inspect dispatch/terminalization/lease-loss/reclaimed-claim events,
      and accept that a command or reply may be lost.
- [ ] Generate and manually review the fresh stale-channel/orphan-player deletion
      set before enabling scheduled cleanup. Remote cleanup defaults to `false`.

## Post-Cutover

- [ ] Keep Mongo/VPS recoverable through the agreed stable observation window.
- [ ] If rollback is required after D1 writes, stop webhook traffic and reconcile
      exported D1 deltas into Mongo before restarting polling. There is no automatic
      zero-loss rollback.
- [ ] Separate stable and beta into different D1 databases, or namespace every
      game table and constraint by bot environment, before shared-group testing.
- [ ] Reintroduce proactive release broadcast only through a Queue or Workflow
      with durable progress, bounded concurrency, retries, and idempotency.
- [ ] Replace the webhook lease ledger with a durable Queue-backed inbox before
      promising stronger retry or exactly-once behavior.
- [ ] Make D1 effects deterministic and keyed by Telegram update ID, especially
      privileged `/sudorun` mutations, before allowing automatic replay.
- [ ] Add an ordered Telegram outbox that retains ambiguous sends for explicit
      operator inspection and resolution instead of automatically resending them.
- [ ] After live validation and delta review, remove legacy polling code, Mongoose,
      Mongo env support, and the actual VPS deployment.
- [ ] Review the v5 Changeset, version the release, regenerate
      `releases.generated.json`, and never edit the generated file by hand.
