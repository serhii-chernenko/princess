# MongoDB to D1 Data Runbook

This is the data-transfer procedure for the first production cutover. The broader
traffic sequence and rollback policy remain in
[MIGRATION_STATUS.md](./MIGRATION_STATUS.md#safe-cutover-sequence).

The import is deliberately one-shot and fail-closed. It validates the complete
source in memory, proves the D1 application tables are empty, executes insert-only
SQL, and deletes the transient SQL file in `finally`. It never clones or persists
the four source exports in this repository.

## 1. Freeze and export the live source

Stop every legacy polling process before exporting. Confirm no other process can
write to MongoDB and record the UTC freeze time. The empty-target preflight is not
atomic with the remote import, so keep both the legacy writer and every
D1-writing webhook/Worker stopped until reconciliation is complete.

Use MongoDB Database Tools `mongoexport`, with its relaxed Extended JSON output.
The Mongoose model `Status` uses the Mongo collection `statuses`, but the required
export filename is singular:

```sh
mkdir -m 700 fresh-princess-export
cd fresh-princess-export

mongoexport --uri "$MONGODB_URI" --collection channels --jsonFormat=relaxed --out channels.json
mongoexport --uri "$MONGODB_URI" --collection players --jsonFormat=relaxed --out players.json
mongoexport --uri "$MONGODB_URI" --collection scores --jsonFormat=relaxed --out scores.json
mongoexport --uri "$MONGODB_URI" --collection statuses --jsonFormat=relaxed --out status.json
```

The four required root filenames are exactly:

- `channels.json`
- `players.json`
- `scores.json`
- `status.json`

Normal `mongoexport` output is one JSON object per line (NDJSON). JSON arrays are
also accepted. Object IDs must use Extended JSON `$oid`; dates may use a relaxed
ISO `$date` or canonical `$numberLong`; Telegram IDs, scores, and booleans must be
normal JSON scalars. Do not pass a BSON `mongodump` archive to this importer. If
the only source is BSON, restore it into an isolated MongoDB instance and run the
four `mongoexport` commands above.

Record the source collection counts after the freeze. Publish only these four
files at the repository root of the private
`serhii-chernenko/princess-db` repository, review the commit, and record its full
40-character commit SHA. Never put these exports in the application repository.

## 2. Authentication and immutable input

The importer reads the private backup directly through GitHub's Contents API. It
resolves the requested ref once and then reads allowlisted metadata and raw files
at that resolved commit. It does not require a manual clone.

Use a fine-grained GitHub token limited to the private backup repository with
repository **Contents: read-only** permission. The importer prefers `GH_TOKEN`,
then `GITHUB_TOKEN`, and otherwise uses the token from an existing `gh auth login`
session through `gh auth token`:

```sh
gh auth login
export MONGO_BACKUP_REF="<reviewed-40-character-commit-sha>"
```

The fallback `gh auth token` process receives only OS essentials and GitHub CLI
configuration/keyring locations. Cloudflare credentials, Telegram secrets, and
`GH_TOKEN`/`GITHUB_TOKEN` are not inherited by that child process.

Do not echo tokens or place them in `.dev.vars*`, command arguments, reports, or
shell history. Production refuses branches, tags, and abbreviated SHAs.
`MONGO_BACKUP_REPOSITORY` may override the default repository for testing, but the
cutover must use `serhii-chernenko/princess-db`.

## 3. Conversion and validation

Before any D1 call, the importer checks all four UTF-8 exports and aborts on:

- malformed JSON, invalid ObjectIds/dates/booleans, unsafe or non-integer IDs and
  scores, or empty required strings;
- duplicate Mongo IDs, Telegram IDs, or channel memberships;
- missing player, score, or status references;
- score/status ownership that differs from the referencing channel and player;
- multiply referenced or unreferenced score/status documents, which would imply
  duplicate or skipped data;
- per-file or total download size limits, GitHub metadata/content size mismatch,
  or an unexpected GitHub host/redirect.

Successful preparation writes
`.backups/mongo-to-d1.report.json` with repository, requested ref, resolved commit
SHA, Git blob SHA, declared/actual bytes, SHA-256, JSON format, source counts,
transformed counts, and zero-error validation status. The generated statements
are insert-only, conservatively chunked, contain no conflict overwrite behavior,
and contain no explicit transaction wrapper.

## 4. Local rehearsal

Use a fresh local D1 state with the reviewed schema migration applied:

```sh
pnpm run db:migrate:local
export MONGO_BACKUP_REF="<reviewed-40-character-commit-sha>"
pnpm run db:import:local
```

The command fetches from GitHub, validates and converts in memory, queries only
the four application tables (`channels`, `players`, `channel_members`, and
`telegram_updates`) to prove they are empty, imports, and deletes
`.backups/mongo-to-d1.sql` even on failure. Migration metadata is intentionally
not part of the empty-target check. Inspect the retained JSON report and complete
the reconciliation below. Repeat rehearsal only with a fresh local D1 state.

## 5. Production import

Keep all writers frozen. Create/record the D1 Time Travel recovery point or export,
apply the reviewed production schema migration, and inspect its migration log.
Then run:

```sh
export CLOUDFLARE_DATABASE_ID="<exact-production-database-uuid>"
pnpm run db:migrate:production

export MONGO_BACKUP_REF="<reviewed-40-character-commit-sha>"
pnpm run db:import:production
```

The production wrapper explicitly selects `wrangler.jsonc`, environment
`production`, binding `DB`, and remote D1. It refuses a non-SHA source ref and
aborts unless all four application tables have zero rows. It also requires the
independent database-ID confirmation to match the production binding, requires
the binding name `princess-production`, and proves beta uses the same shared ID
and name. Put D1-only credentials in ignored `env/.env.d1` (copied from
`env/.env.d1.example`) or the shell, never in `.dev.vars.production`.

For remote file execution, Cloudflare documents that a failed import restores the
database to its original state and can be safely retried. Keep traffic stopped,
inspect the failure, and rerun the empty application-table counts plus recovery
and reconciliation checks before retrying; do not infer target state from the CLI
exit alone. See the
[D1 import/export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

## 6. Reconcile before enabling traffic

Compare the report's source/transformed counts with the frozen Mongo counts and
the remote D1 results:

```sh
pnpm run db:query:production -- --command='SELECT (SELECT COUNT(*) FROM channels) AS channels, (SELECT COUNT(*) FROM players) AS players, (SELECT COUNT(*) FROM channel_members) AS channel_members, (SELECT COUNT(*) FROM telegram_updates) AS telegram_updates;'

pnpm run db:query:production -- --command='PRAGMA foreign_key_check;'

pnpm run db:query:production -- --command='SELECT COUNT(*) AS memberships, SUM(score) AS score_total, SUM(is_active) AS active_total, SUM(is_auto_joined) AS auto_joined_total FROM channel_members;'

pnpm run db:query:production -- --command='SELECT language, release_version, COUNT(*) AS channels FROM channels GROUP BY language, release_version ORDER BY language, release_version;'
```

Require all of the following before deploying or registering webhooks:

- D1 channel/player/member counts equal the report's transformed counts;
- source score and status counts equal transformed membership count;
- `telegram_updates` is still empty and `PRAGMA foreign_key_check` returns no rows;
- score totals/distribution, active and auto-joined totals, release versions,
  languages, and last-vote timestamps match the frozen source semantics;
- several known empty/small/large groups and known players match by Telegram ID.

Archive the report and reconciliation evidence with the recorded freeze time,
backup commit SHA, D1 recovery point, and operator identity. Only then continue
with Worker deployment and the beta/stable webhook sequence in the main cutover
runbook.
