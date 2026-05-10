# Princess Bot Migration Plan

Last updated: 2026-05-10
Repo: `/Users/inevix/dev/main/princess`

## Purpose

This file is the source of truth for the modernization plan of the `princess` Telegram bot.

Before starting each next phase, reread this file and confirm:

1. The approved architecture decisions still hold.
2. The previous phase is fully complete.
3. Any new tradeoffs or deviations are explicitly documented here first.

## Current State Summary

The current bot is:

- A long-running polling `Telegraf` app started from `bot/index.js`.
- Using `MongoDB + Mongoose`.
- Deployed through `GitHub Actions -> Ansible -> Docker -> VPS`.
- Written in JavaScript without a test suite.
- Using hand-rolled i18n and changelog broadcasting.

Important behavioral note:

- The "daily" run is not a real scheduled job today.
- It is triggered by regular group messages and rate-limited to once per 24 hours.

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
    - `db:migrate:production`
    - `db:query:local`
    - `db:query:production`
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
    - `db:import:production`
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
    - kept `legacy:dev` and `legacy:start` as fallback aliases
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

Status: pending

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

### Phase 8: Final Repo Operations and Agent Docs

Status: pending

Goals:

- Finish repository maintenance docs and agent workflow support.

Scope:

- Add `AGENTS.md`.
- Install needed skills via `npx skills add`.
- Update README and operating instructions.

Exit criteria:

- Human and agent workflows are documented.

## Risks and Watchpoints

### Behavior Risks

- Polling to webhook migration may subtly change how updates are handled.
- The current message-triggered daily run must not accidentally become cron-driven unless intended.
- Release fanout currently happens on process startup; that has to be redesigned explicitly.

### Performance Risks

- Current logic does repeated sequential DB and Telegram API calls.
- `getChatMember` calls per player may be expensive in a request-bound Worker environment.

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

The next executable step is:

`Phase 7: Deployment Migration`

Do not begin Phase 8 until Phase 7 is implemented, reviewed, and accepted.
