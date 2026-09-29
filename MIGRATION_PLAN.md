# Princess Bot Migration Plan

Last updated: 2026-07-15
Repo: `/Users/inevix/dev/main/princess`

## Purpose

This file preserves the architecture decisions and historical phase detail for the
`princess` Telegram bot rewrite. The authoritative current audit, cutover gates,
and rollback policy now live in [MIGRATION_STATUS.md](./MIGRATION_STATUS.md).

Before starting each next phase, reread this file and confirm:

1. The approved architecture decisions still hold.
2. The previous phase is fully complete.
3. Any new tradeoffs or deviations are explicitly documented here first.

## Current State Summary

The migration is **implemented and cut over to production (2026-09-29)**; the
observation window is in progress. See
[MIGRATION_STATUS.md](./MIGRATION_STATUS.md#cutover-record).

- `main` and `origin/main` remain at legacy baseline `243967c`: long-running
  Telegraf polling, MongoDB/Mongoose, and GitHub Actions to Ansible/Docker/VPS.
- Branch `feat/migration-to-v5` has checked-in baseline `be567a8`, a WIP commit
  ("chore: in progress", to be reworded or squashed before the PR) that records
  Phase 8 on top of Phase 7 (`076c2bd`).
- The 2026-09-29 follow-up (review fixes, D1 integration tests, beta isolation,
  webhook helper changes) is an uncommitted worktree on top of `be567a8`.
- The primary repository runtime is Cloudflare Workers + Hono + Telegraf webhooks,
  with Drizzle + D1, strict TypeScript, typed i18n, and Changesets.
- A durable bot-specific webhook `update_id` ledger with leases and deduplication
  is now implemented, with Workers-runtime D1 integration tests. Remote
  provisioning, fresh data migration, traffic cutover, and live validation remain.
- The exact-parity vote path needs Workers Paid (chosen by the owner): for the
  55-member maximum group it makes 56 Telegram subrequests before replies, 58 in
  total, above the Free plan's 50.
- Beta will use its own D1 database (`princess-beta`), refreshed from production
  by an explicit copy command.
- Note 2026-09-29: the beta environment was later retired in favour of Worker
  Previews of the production Worker (own D1 `princess-preview`); the beta
  references below are historical. See
  [MIGRATION_STATUS.md](./MIGRATION_STATUS.md#beta-retirement).

The daily product behavior remains message-triggered and rate-limited to once per
24 hours; the cron trigger is for maintenance, not selection.

## Approved Architecture Decisions

The following decisions are approved by the user and should be treated as baseline unless explicitly changed later:

1. Runtime stack:
   `Telegraf + Hono + Cloudflare Workers`

2. Bot delivery model:
   `Telegram webhooks`, not long-running polling

3. Daily game behavior for first migration:
   Preserve current semantics
   The first relevant message after the 24h window may trigger the next run

4. Persistence model:
   Migrate from `MongoDB + Mongoose` to `Drizzle ORM + Cloudflare D1`

5. Database design direction:
   Use a normalized relational schema, not a Mongo-shaped SQLite schema

6. i18n/tooling:
   Use `typesafe-i18n`

7. Release/changelog workflow:
   Use `Changesets`

## Architecture Rationale

### Why Cloudflare Workers

- The bot does not need a permanent process if it uses Telegram webhooks.
- Cloudflare Workers fits webhook handling and small operational services well.
- Cleanup and release fanout can be moved to Worker scheduled jobs instead of process startup side effects.

### Why Hono

- `Hono` gives lightweight routing for endpoints such as:
    - `/telegram`
    - `/health`
    - optional internal/admin endpoints
- It is a good fit for a Worker-first app.
- `Nitro` is not necessary for this bot's scope and would add overhead without a clear payoff.

### Why keep Telegraf

- It preserves the current bot programming model during migration.
- It already supports webhook-based operation.
- This avoids rewriting bot behavior and framework abstractions at the same time as the hosting migration.

### Why preserve current daily behavior first

- The existing game mechanic is message-driven, not clock-driven.
- Changing infrastructure and game behavior in one step would make regressions harder to isolate.
- A true fixed-time daily schedule can be considered later as an explicit product change.

### Why relational D1 schema

- The current Mongoose model is document-oriented and awkward for D1.
- The current data is effectively relational already:
    - channels
    - players
    - membership/status per channel
    - score per channel member
- A normalized schema will simplify queries, cleanup, migration logic, and typing.

## Proposed Target Data Model

Initial relational direction:

- `channels`
    - `id`
    - `telegram_chat_id`
    - `updated_at`
    - `release_version`
    - timestamps if needed

- `players`
    - `id`
    - `telegram_user_id`
    - `display_name`
    - timestamps if needed

- `channel_members`
    - `id`
    - `channel_id`
    - `player_id`
    - `score`
    - `is_active`
    - `is_auto_joined`
    - timestamps if needed

Likely constraints/indexes:

- unique `channels.telegram_chat_id`
- unique `players.telegram_user_id`
- unique `(channel_id, player_id)` on `channel_members`
- indexes for channel lookups and active members

This model intentionally merges the current `Score` and `Status` concepts into membership state unless implementation details justify separate tables later.

## Phase Plan

Work must proceed phase by phase. Do not start the next phase without user review of the previous one.

### Phase 0: Planning and Decisions

Status: complete

Scope:

- Inspect current codebase.
- Investigate Cloudflare Workers feasibility.
- Investigate D1 + Drizzle migration direction.
- Investigate i18n and changelog modernization.
- Document architecture decisions.

Exit criteria:

- Approved target stack.
- Written migration plan in this file.

### Phase 1: Baseline Safety Net and Tooling

Status: complete

Goals:

- Upgrade dependencies carefully.
- Add a minimal safety net before large code moves.
- Replace ESLint + Prettier with Oxlint + Oxfmt.
- Prepare TypeScript project scaffolding.

Scope:

- Add a lockfile.
- Define supported Node version and local/dev scripts.
- Add minimal smoke checks or tests around core behavior.
- Install and configure TypeScript in strict mode.
- Migrate from legacy `.eslintrc.js` toward Oxlint using the official migration path.
- Replace Prettier formatting with Oxfmt.
- Remove obsolete lint/format dependencies when safe.

Notes:

- `@oxlint/migrate` does not directly migrate legacy ESLint v8 config.
- The expected path is:
    1. migrate legacy ESLint config to flat config
    2. run `@oxlint/migrate`
    3. trim leftover config manually
- Phase 1 implementation result:
    1. Kept runtime upgrades within the current major lines for safety:
       `dotenv 16.x`, `mongoose 6.x`, `telegraf 4.x`
    2. Added `package-lock.json` and switched Docker builds to `npm ci`
    3. Replaced ESLint/Prettier with `oxlint` and `oxfmt`
    4. Added strict `tsconfig.json` scaffolding
    5. Added smoke tests and a top-level `npm run check` validation pipeline
    6. Pinned Docker images away from `node:latest`

Exit criteria:

- Dependency tree updated and installable.
- Lint and format commands work with Oxlint/Oxfmt.
- Strict TypeScript config exists.
- A small validation harness exists for future refactors.

### Phase 2: Worker App Skeleton

Status: complete

Goals:

- Introduce the new Cloudflare Worker structure without porting all logic at once.

Scope:

- Add Wrangler config.
- Add Worker entrypoint.
- Add Hono app routing.
- Add typed environment bindings.
- Add Telegram webhook endpoint.
- Add health endpoint.
- Add scheduled handler skeleton for cleanup/release tasks.

Exit criteria:

- Local Worker app boots with Wrangler.
- Telegram webhook route exists.
- App structure is ready for feature migration.

Phase 2 implementation result:

1. Added `wrangler.jsonc` with Worker entrypoint and compatibility settings
2. Added `hono`-based Worker scaffold under `src/worker/`
3. Added typed Worker env bindings and generated `worker-configuration.d.ts`
4. Added `/health` route
5. Added Telegram webhook scaffold route with secret-header validation
6. Added scheduled handler scaffold for future cleanup/release jobs
7. Added Worker scripts:
    - `worker:dev`
    - `worker:deploy`
    - `cf-typegen`

Verification notes:

- `wrangler dev` booted locally
- `GET /health` returned `200`
- `POST /telegram` returned `202` for a valid scaffold payload

### Phase 3: Database Layer Migration

Status: complete

Goals:

- Replace MongoDB/Mongoose with Drizzle + D1.

Scope:

- Define Drizzle schema.
- Generate SQL migrations.
- Add local D1 setup.
- Implement repository/data-access layer.
- Replace Mongoose model methods with typed services.

Exit criteria:

- D1 schema and migrations are committed.
- Local Worker can read/write bot data through Drizzle.

Phase 3 implementation result:

1. Switched to `drizzle-orm@1.0.0-rc.1` and `drizzle-kit@1.0.0-rc.1`
2. Added `effect@4` to the new DB service layer
3. Added `wrangler.jsonc` D1 binding scaffold with `DB`
4. Added `drizzle.config.ts` and `drizzle.production.config.ts`
5. Split schema files under `src/db/schemas/`
6. Switched schema declarations to camelCase TypeScript keys with `snakeCase.table(...)` so SQLite columns stay snake_case
7. Added typed repositories and DB service under `src/db/`
8. Generated the new RC migration layout under `drizzle/`
9. Replaced the broken local Wrangler flat-SQL migration path with a Drizzle-native local D1 migrator script
10. Added DB scripts:
    - `db:generate`
    - `db:migrate:local`
    - `db:migrate:prod`
    - `db:query:local`
    - `db:query:prod`
11. Moved the new Worker/D1 flow to root-level `.dev.vars` and `.dev.vars.production`
12. Prepared `wrangler.jsonc` with:
    - top-level local development config
    - nested `env.production` for the real production Worker and D1 binding
13. Renamed the production Drizzle config to `drizzle.production.config.ts` to match the official multi-config `--config` workflow more clearly

Verification notes:

- `drizzle-kit generate` produced the RC migration successfully
- `npm run db:migrate:local` created `channels`, `players`, `channel_members`, and `__drizzle_migrations`
- TypeScript-facing schema keys are camelCase while generated SQLite columns are snake_case
- `npm run typecheck` passed after the RC and Effect refactor

### Phase 4: Mongo to D1 Migration Tooling

Status: complete

Goals:

- Provide an explicit migration path for existing Mongo data.

Scope:

- Add script(s) to export/read current Mongo data.
- Transform Mongo entities into the D1 relational shape.
- Import into D1 safely.
- Produce validation output or summary reports.

Expected deliverables:

- migration script(s)
- instructions for dry run
- instructions for production run
- data validation checklist

Exit criteria:

- Existing Mongo data can be migrated into D1 with repeatable steps.

Phase 4 implementation result:

1. Added `scripts/db/prepare-mongo-import.ts`
2. The script reads the real backup format from `princess-db/` as NDJSON, not JSON arrays
3. It generates:
    - `.backups/mongo-to-d1.sql`
    - `.backups/mongo-to-d1.report.json`
4. Added scripts:
    - `db:import:prepare`
    - `db:import:local`
    - `db:import:prod`
5. Import statements are chunked conservatively for D1:
    - players: `20`
    - channels: `20`
    - channel members: `10`
6. Validated the real backup counts:
    - channels: `225`
    - players: `974`
    - scores: `1040`
    - statuses: `1040`
7. Verified the transformation result:
    - channels: `225`
    - players: `974`
    - channel members: `1040`
8. Verified the import locally on a fresh D1 database with matching final row counts

### Phase 5: Feature Port to Strict TypeScript

Status: complete

Goals:

- Port all runtime behavior into the new typed Worker architecture.

Scope:

- Commands
- listeners
- vote flow
- cleanup flow
- release messaging
- admin checks
- scene/proposal flow if retained

Important rule:

- Keep behavior parity first.
- Do not introduce product-level changes unless explicitly approved.

Exit criteria:

- Old bot behavior is reproduced in the new architecture.
- No JavaScript runtime files remain in the primary app path.

Phase 5 implementation result:

1. Added the real Worker-side Telegram runtime under `src/bot/`
2. Ported the runtime behavior to strict TypeScript:
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
3. Ported the message-triggered auto-run listener
4. Replaced the `/telegram` scaffold response with real `Telegraf.handleUpdate(...)`
5. Added a typed content layer for the existing UA messages and changelog rendering
6. Wired scheduled cleanup to the new D1-backed service layer
7. Switched the primary local scripts to the Worker path:
    - `dev`
    - `start`
    - kept `legacy:dev` and `legacy:start` as fallback aliases (removed after the cutover)
8. Removed `MONGODB_URI` from the active Worker env examples
9. Switched tests to `tsx --test` and added TypeScript runtime smoke coverage

Verification notes:

- `npm run format` passes and still enforces the wrapped-arrow explicit-return policy
- `npm run check` passes
- `npm run worker:dev` served:
    - `GET /health -> 200`
    - `POST /telegram` with wrong secret -> `401`
    - `POST /telegram` with the correct secret and a synthetic update payload -> `200`

Phase 5 intentional deferrals:

- The old dead `/propose` scene remains out of the new runtime because it is not registered in the legacy command index either
- Startup release fanout from the old polling bootstrap is still not ported; it remains a later release/deployment concern

### Phase 6: i18n and Release Workflow Modernization

Status: complete

Goals:

- Make content maintainable and typed.

Scope:

- Move message handling to `typesafe-i18n`.
- Replace placeholder-string mutation with typed translation calls.
- Rework Telegram release posts so they do not depend on object key order.
- Introduce `Changesets`.

Exit criteria:

- Messages are typed.
- Release/version flow has one clear source of truth.
- Telegram release post generation is deterministic.

Phase 6 implementation result:

1. Replaced the manual `%placeholder` message layer with `typesafe-i18n`
2. Moved the authored bot copy into `src/i18n/en/index.ts` and generated the typed translator surface under `src/i18n/`
3. Added a Ukrainian runtime locale mirror in `src/i18n/uk/index.ts` and a cached Worker translator wrapper in `src/bot/i18n.ts`
4. Rewired the Worker bot and game service to typed translation calls instead of string mutation
5. Introduced `CHANGELOG.md` as the human-owned release source and `releases.generated.json` as the generated runtime manifest
6. Replaced `changelog.json` object-order semantics with deterministic release-array rendering
7. Added `Changesets` config and validation:
    - `.changeset/config.json`
    - `.changeset/README.md`
    - `scripts/releases/validate-changesets.ts`
8. Added release maintenance scripts:
    - `i18n:generate`
    - `releases:sync`
    - `changeset:add`
    - `changeset:status`
    - `changeset:validate`
    - `changeset:version`
9. Kept the legacy JS `/releases` path compatible by switching it to `releases.generated.json`
10. Added channel-level language persistence with default `ua`
11. Added `/lang` to show or change the current channel language
12. Standardized the user-facing locale codes to `ua` and `en`
13. Kept `uk` only as the internal `typesafe-i18n` locale id to avoid generator/runtime breakage

Verification notes:

- `pnpm run i18n:generate` regenerates the typed i18n surface cleanly
- `pnpm run releases:sync` regenerates the release manifest from `CHANGELOG.md`
- `pnpm run check` passes after the migration

Phase 6 intentional deferrals:

- Startup release fanout is still not scheduled in the Worker runtime yet
- The legacy `/propose` scene remains outside the primary runtime path

### Phase 7: Deployment Migration

Status: complete; production cutover done 2026-09-29 (production and beta are deployed by
Cloudflare Workers Builds)

Goals:

- Replace VPS/Docker/Ansible deployment with Cloudflare-native deployment.

Scope:

- Remove or retire old VPS deployment pipeline.
- Add GitHub Actions for Worker deployment if desired.
- Document webhook registration flow.
- Configure secrets and environment variables.
- Configure D1 bindings.
- Configure scheduled cleanup/release jobs.

Exit criteria:

- Production deploy targets Cloudflare Workers.
- Old deployment path is no longer required.

Phase 7 repository implementation result:

1. Replaced the GitHub Actions VPS/Ansible deploy workflow with a Cloudflare Worker deploy workflow in `.github/workflows/main.yml`
2. Simplified deploy back to direct Wrangler commands with `--secrets-file`
3. Added two production Workers in `wrangler.jsonc`:
    - production Worker: `princess`
    - beta Worker: `princess-beta`
4. Attached distinct production custom domains:
    - production: `princess.chernenko.dev`
    - beta: `princess-beta.chernenko.dev`
5. Kept production and beta on the same D1 binding (superseded 2026-09-29 by a
   separate beta D1)
6. Kept the cron trigger only on production:
    - `0 0 * * *`
7. Added local tunnel-aware dev orchestration in `scripts/cloudflare/dev-with-tunnel.ts`
8. Added local, production, and beta webhook helpers in `scripts/telegram/webhook.ts`
9. Added direct ops scripts for:
    - production deploy/tail/webhook
    - beta deploy/tail/webhook
    - local webhook registration and deletion
10. Switched local public webhook guidance to a stable Cloudflare Tunnel hostname:
    - `princess-dev.chernenko.dev`
11. Replaced the outdated Docker-first README with a Worker/D1 deployment README and Cloudflare Tunnel runbook

Verification notes:

- `pnpm run worker:dev` now goes through the local tunnel/webhook orchestrator
- production deploy is no longer hidden behind custom wrapper scripts
- the GitHub workflow now writes `.dev.vars.production` and uses the same direct Wrangler path as local operators

Phase 7 intentional deferrals:

- Automatic proactive release broadcast is retired for the v5 cutover. If it is
  reintroduced later, use a Queue or Workflow with durable per-channel progress;
  do not fan out inline from a cron invocation.

### Phase 8: Final Repo Operations and Agent Docs

Status: committed in `be567a8` (WIP message); 2026-09-29 follow-up uncommitted

Goals:

- Finish repository maintenance docs and agent workflow support.

Scope:

- Finalize the repo instruction file as `AGENTS.md`.
- Remove obsolete VPS deployment artifacts and dead release files.
- Update README and operating instructions.

Exit criteria:

- Human and agent workflows are documented.
- Only the active Worker/D1 release flow remains in the repo.

Phase 8 implementation:

1. Removed obsolete VPS deployment artifacts:
    - `.ansible/`
    - `.docker/`
    - Docker-related `package.json` scripts
    - `package-lock.json`
2. Promoted the repo instruction file to `AGENTS.md` and retired `AGENT.md`
3. Removed dead legacy release input:
    - `changelog.json`
4. Kept the canonical release flow as:
    - `.changeset/*.md` for unreleased notes
    - `CHANGELOG.md` for human release history
    - `releases.generated.json` for runtime `/releases`
5. Tightened the production GitHub Actions workflow so it now:
    - prepares `.dev.vars.production`
    - validates pushes and pull requests without deploying
    - originally deployed production on manual dispatch; that job was removed after
      cutover in favor of Cloudflare Workers Builds, so the workflow only validates
    - never applies D1 migrations or changes Telegram webhooks
    - no longer carries unused `ADMIN_ID`
6. Updated operator docs for:
    - production workflow behavior
    - release artifact ownership
    - beta safety (later replaced by a separate beta D1)
7. Added a durable Telegram update ledger with:
    - a unique bot-specific key plus `update_id`
    - atomic claim and terminalized-duplicate acknowledgement
    - lease-matched terminalization after success or caught dispatch failure
    - no automatic deletion or release after Telegraf dispatch starts
    - five-minute stale-lease reclamation
    - a production-owned job that prunes processed rows after seven days and abandoned
      processing rows after 24 hours
8. Hardened the Worker boundary with a 1 MiB authenticated body cap, message-update
   validation, authenticated D1 readiness, service-level cleanup authorization,
   and custom-domain-only production/beta Workers.

Verification notes:

- The complete suite reports 122 passing tests, including Workers-runtime D1
  integration tests.
- Generated-binding verification and local/production/beta deployment dry-runs pass;
  rerun these gates after further code or configuration changes.

Important readiness note:

- Superseded 2026-09-29: beta gets a separate D1 (`princess-beta`) filled by `pnpm db:copy:production-to-beta`. Until it is provisioned, beta must not be deployed against production. Beta still uses a separate bot token, webhook path, and domain.

## Risks and Watchpoints

### Behavior Risks

- Polling to webhook migration may subtly change how updates are handled.
- The durable ledger terminalizes caught dispatch failures, so Telegram retries
  cannot rerun known partial execution. D1 mutations, Telegram sends, and ledger
  terminalization are not transactional: crashes, timeouts, lost responses, or
  stale-lease reclaim can still repeat an earlier side effect. When terminalization
  is uncertain, acknowledging the update favors at-most-once execution and can
  lose an unfinished command or reply. This is an explicit cutover reliability
  decision, not general recovery; use `max_connections=1`, avoid `/sudorun` during
  cutover/reconciliation, and stop to inspect dispatch, terminalization, lease-loss,
  or reclaimed-claim events.
- The current message-triggered daily run must not accidentally become cron-driven unless intended.
- Legacy release fanout is retired for the v5 cutover. If restored later, it must
  use a durable Queue or Workflow rather than inline cron fanout.

### Performance Risks

- Current logic does repeated sequential DB and Telegram API calls.
- `getChatMember` calls per player may be expensive in a request-bound Worker environment.
- Actor validation plus reconciliation of the real 55-member maximum group uses
  about 56 Telegram API subrequests, so exact current behavior exceeds the
  Workers Free limit of 50; the corrected formula is 1 actor check + N
  reconciliation checks + 2 replies (`getMe` is cached per isolate), so Paid is
  required and was chosen by the owner.

### Data Risks

- Mongo documents currently spread membership data across `Channel`, `Score`, and `Status`.
- Migration scripts must account for partially inactive users and channels with stale state.

### Tooling Risks

- Large dependency upgrades may surface runtime or ESM/CJS issues.
- Strict TypeScript will force some structural rewrites, which is expected.

## Working Agreement

This migration is being done in guided phases with user approval checkpoints.

Rules:

1. Investigate deeply before making architecture changes.
2. Execute only one approved phase at a time.
3. Report what changed, what was verified, and what remains risky.
4. Before each next phase, reread this file and update it if assumptions changed.

## Changesets: Future Workflow

The user requested explicit future instructions because `Changesets` is new to them.

### What Changesets is for

`Changesets` helps track release-worthy changes in version-controlled Markdown files.

It is useful because:

- release notes are written intentionally
- version bumps are generated consistently
- changelog creation becomes a workflow instead of an ad hoc JSON file edit

### Typical future workflow

When making a user-visible or package-visible change:

1. Run:

```sh
pnpm run changeset:add
```

2. Answer the prompts:
    - which package changed
    - what kind of version bump applies

3. Write Ukrainian tagged bullets in the body:
    - `[added] ...`
    - `[updated] ...`
    - `[fixed] ...`
    - `[removed] ...`
    - `[notes] ...`

4. Commit the generated file under `.changeset/`.

5. Validate the format at any time with:

```sh
pnpm run changeset:validate
```

6. Later, when preparing a release, run:

```sh
pnpm run changeset:version
```

This now does 4 things in one flow:

- validates the tagged changeset format
- runs `changeset version`
- stamps the top changelog entry with the release date
- regenerates `releases.generated.json`

7. To inspect pending changesets, run:

```sh
pnpm run changeset:status
```

### How this project should use it

For this bot, the practical setup is now:

- `CHANGELOG.md` is the human release source of truth
- `releases.generated.json` is the deterministic runtime artifact for Telegram release posts
- Telegram release messages are generated from the release manifest, not JSON object key order

### Repo-specific notes

- edit bot copy in `src/i18n/en/index.ts`
- regenerate i18n files with `pnpm run i18n:generate`
- do not edit `releases.generated.json` by hand
- regenerate the release manifest from `CHANGELOG.md` with `pnpm run releases:sync`

## Next Step

Post-cutover, in this order:

1. Review and commit the worktree, merge to `main`, and switch the `princess-beta`
   Workers Build branch to `main` (obsolete: the beta environment was retired).
2. Observe production; keep MongoDB Atlas untouched as a backup source.
3. Review the deletion set before enabling scheduled cleanup.
4. Decide on Mongo Atlas retirement (legacy code is already removed) after the observation
   window. See [MIGRATION_STATUS.md](./MIGRATION_STATUS.md).

Do not equate a coded phase with a migrated production service. Legacy retirement
comes only after live production validation and D1 delta review.
