# User Migration Todo

Last updated: 2026-09-29

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
- [x] Replace the checked-in VPS deploy workflow with validation-only GitHub
      Actions; production and beta are deployed by Cloudflare Workers Builds. Keep D1
      migration and Telegram webhook changes as separate operator actions.
- [x] Add compare-and-set daily-run claiming, atomic score increments, a single
      membership reconciliation, set-based cleanup, D1-safe orphan chunks, a
      fail-closed webhook boundary, readiness checks, cleanup gating, and structured
      observability in the current worktree.
- [x] Restore then remove the legacy polling loader for `env/.env.dev` and
      `env/.env.production` (legacy code deleted after the cutover).
- [x] Add a bot-specific D1 `update_id` ledger with atomic claims, terminalized
      update deduplication, matching-lease terminalization, no automatic release after
      dispatch starts, five-minute stale-claim recovery, and a production-owned pruning
      job after seven days. Caught failures that terminalize cannot replay; this is
      an explicit at-most-once reliability decision rather than general recovery.
- [x] Bound authenticated webhook JSON to 1 MiB, validate message-update shape,
      authenticate `/health` before D1, prune 24-hour abandoned claims, reject
      beta/disabled global cleanup, and disable production/beta `workers.dev`.
- [x] Implement proactive release announcements through Cloudflare Queues (at-most-once, bilingual notes, kill switch); keep `/releases`.

## In Progress — Code and Repository Gates

- [x] Add Workers-runtime integration tests (`test/integration/`) against a real
      local D1 via wrangler `getPlatformProxy`: migrations, update-ledger
      concurrency and stale reclaim, compare-and-set daily claim, atomic score
      increments, cleanup chunking and cascades, Mongo import SQL and rerun
      rejection, and webhook dispatch with duplicate and concurrent delivery.
- [x] Run `pnpm run check`, generated-binding verification, and local/production/beta
      deployment dry-runs. The latest `pnpm test` reports 211/211 passing tests;
      rerun all gates after further code or configuration changes.
- [x] Apply the 2026-09-29 review fixes for legacy parity (see
      [MIGRATION_STATUS.md](./MIGRATION_STATUS.md#2026-09-29-review)).
- [x] Decide production/beta isolation: separate beta D1 `princess-beta`, with a
      production-to-beta copy command and manual workflow.
- [ ] Review and commit the current worktree. Phase 8 is already committed in
      `be567a8`, a WIP commit ("chore: in progress"); give it a proper message or
      squash before the PR (owner's call). Today's follow-up is uncommitted on top.

## Cutover — Done 2026-09-29

Details are in the [Cutover record](./MIGRATION_STATUS.md#cutover-record).

- [x] Enable Workers Paid (verified).
- [x] Create the production D1 and the separate beta D1 `princess-beta`, replace all
      D1 placeholders in `wrangler.jsonc`, and attach production/beta custom domains.
- [x] Configure per-bot runtime secrets on both Workers; local copies in ignored
      `.dev.vars.production` / `.dev.vars.beta`; `env/.env.d1` in
      `wrangler-login` mode.
- [x] Take a fresh post-freeze export (`princess-db` commit `d97cd8e`), stop and
      freeze the legacy bot (17:48:52Z), and record the times.
- [x] Apply the production schema migrations (rerun after a transient D1 7403).
- [x] Run the one-shot production import from the pinned SHA and reconcile: 217
      channels, 886 players, 939 memberships, score sum 21192, 0 FK violations.
- [x] Deploy production and beta; set the beta webhook, then the production webhook
      (17:52:44Z, `max_connections=1`, `allowed_updates` `message`).
- [x] Fix the non-message update stall (`200 {ignored:true}`); queue drained.
- [x] Connect Cloudflare Workers Builds to the repo; remove the old VPS deploy
      secrets/variables from GitHub.
- [x] Remove the legacy VPS container, image, and app directory.

## Open Follow-ups

- [x] Apply migration `20260929183002_mysterious_freak` to `princess-production`
      before merging (Workers Builds deploys code but does not run migrations).
- [x] Merge to `main` (PR #1), announce 5.0.0 (90 sent, 127 skipped, 0 failed),
      and move the `princess-beta` Workers Build to the `beta` branch.
- [ ] Investigate why registered Cron Triggers are not invoked (no `scheduled`
      events in Workers Observability); the daily ledger prune depends on them.
- [ ] Rotate the production and beta bot tokens if desired (shared in chat).
- [ ] Configure the GitHub `beta` environment secrets/variables and protections
      (required reviewers, `main` deployment-branch rule, D1-scoped token) for the
      copy workflow; consider CODEOWNERS on `.github/workflows/`, `scripts/db/`,
      and `wrangler.jsonc`.
- [ ] Restrict access to the beta D1 and logs, define retention, and consider lower
      beta log sampling: beta holds production PII.
- [ ] Decide how to handle secret exposure: invocation logs at 100% may record the
      secret webhook path URL, and `/health` reuses `TELEGRAM_WEBHOOK_SECRET`.
- [ ] Configure and validate Cloudflare edge rate-limiting rules for the webhook and
      authenticated `/health` paths without blocking Telegram delivery.
- [ ] Keep the bot an administrator in every group (fair draws; see the finding in
      MIGRATION_STATUS.md).
- [ ] Keep `max_connections=1`, avoid `/sudorun` during the observation window, and
      stop and inspect dispatch/terminalization/lease-loss/reclaimed-claim events.
- [ ] Generate and manually review the fresh stale-channel/orphan-player deletion
      set before enabling scheduled cleanup. Remote cleanup defaults to `false`.

## Post-Cutover

- [ ] Keep Mongo Atlas (backup and re-import source) untouched through the observation window, then decide on retirement; `backup-dbs` princess step works while Atlas exists.
- [ ] If recovery is required after D1 writes, use a Worker version rollback, D1 Time
      Travel, or a re-import from Atlas backups. The legacy bot is not redeployable.
- [ ] Replace the webhook lease ledger with a durable Queue-backed inbox before
      promising stronger retry or exactly-once behavior.
- [ ] Make D1 effects deterministic and keyed by Telegram update ID, especially
      privileged `/sudorun` mutations, before allowing automatic replay.
- [ ] Add an ordered Telegram outbox that retains ambiguous sends for explicit
      operator inspection and resolution instead of automatically resending them.
- [x] Remove legacy polling code, Mongoose, and Mongo env support (the VPS deployment
      is already removed).
- [ ] Review the v5 Changeset, version the release, regenerate
      `releases.generated.json`, and never edit the generated file by hand.
