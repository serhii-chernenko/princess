# Agent Rules

These rules are strict for this repository.

## TypeScript and Drizzle

- Keep TypeScript-facing object keys in `camelCase`.
- When Drizzle needs snake_case names in SQLite/D1, use Drizzle casing helpers instead of duplicating raw column-name strings.
- Keep table definitions split by file under `src/db/schemas/`.

## Arrow Functions

- Use concise implicit-return arrows only when the entire arrow function stays on one line.
- Once an arrow body wraps or the line exceeds the configured width, switch to a block body with an explicit `return`.
- Preferred:

```ts
service.use(currentService => currentService);
```

- Forbidden:

```ts
service.use(currentService => expensiveOperation(currentService));
```

This rule is enforced in linting with the custom `arrow-body/explicit-return-for-wrapped-arrow` rule.

## Cloudflare D1

- Do not assume D1 can handle large bound-parameter batches.
- Keep import and migration writes chunked conservatively.
- Treat `100` bound parameters per statement as the safety ceiling unless verified otherwise.
- Prefer chunk sizes derived from `floor(100 / columnCount)` or smaller.

## Stable and Beta Data

- Stable and beta use separate D1 databases (`princess-production` and `princess-beta`) once the beta database is provisioned.
- Until the beta D1 exists, do not deploy beta against the production database.
- Data is copied production to beta only (`pnpm db:copy:production-to-beta --confirm-overwrite-beta`); never the other direction.
- Beta holds production user data after a copy; restrict access to it.
- Do not add both bots to the same Telegram group.
- Treat beta as safe for real-group testing only when that group is beta-only.

## Releases

- `CHANGELOG.md` is the human-owned release history.
- `.changeset/*.md` files are pre-release inputs.
- `releases.generated.json` is the generated runtime artifact for `/releases`.
- Do not edit `releases.generated.json` by hand.

## Backup Data

- The `princess-db/` directory is local-only backup input.
- You may read from it for validation and migration work.
- Do not add files from `princess-db/` to git.
