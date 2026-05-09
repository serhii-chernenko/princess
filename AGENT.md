# Agent Rules

These rules are strict for this repository.

## TypeScript and Drizzle

- Keep TypeScript-facing object keys in `camelCase`.
- When Drizzle needs snake_case names in SQLite/D1, use Drizzle casing helpers instead of duplicating raw column-name strings.
- Keep table definitions split by file under `src/db/schemas/`.

## Arrow Functions

- Do not use implicit-return arrow bodies.
- Always write block bodies with explicit `return` when a value is returned.
- Preferred:

```ts
service.use(currentService => {
    return currentService;
});
```

- Forbidden:

```ts
service.use(currentService => currentService);
```

This rule is enforced in linting with `arrow-body-style: ["error", "always"]`.

## Cloudflare D1

- Do not assume D1 can handle large bound-parameter batches.
- Keep import and migration writes chunked conservatively.
- Treat `100` bound parameters per statement as the safety ceiling unless verified otherwise.
- Prefer chunk sizes derived from `floor(100 / columnCount)` or smaller.

## Backup Data

- The `princess-db/` directory is local-only backup input.
- You may read from it for validation and migration work.
- Do not add files from `princess-db/` to git.
