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

## Production and Preview Data

- Production and preview use separate D1 databases (`princess-production` and `princess-preview`).
- Never point a preview at the production database.
- Data is copied production to preview only (`pnpm db:copy:production-to-preview --confirm-overwrite-preview`); never the other direction.
- The preview D1 may hold a production copy after the copy command; restrict access to it.
- The preview bot (@princess_debug_bot) is for preview-only Telegram groups.
- Never add both bots to the same Telegram group.

## Deployment

- Cloudflare Workers Builds deploys production (`princess`, from `main`) and creates Worker Previews for other branches.
- GitHub Actions only validate; do not add a deploy job.

## Worker Previews

- Worker Previews (`env.production.previews`) of the production Worker use their own D1 database, `princess-preview`.
- Previews get the preview bot token as a Preview base-config secret, never the production bot token.
- Point the preview bot webhook at a preview only with `pnpm telegram:webhook:set:preview --url <preview url> --drop-pending-updates=true|false`.
- Previews run with `BOT_ENVIRONMENT="preview"`: no cron, no cleanup, no release broadcast.

## Releases

- `CHANGELOG.md` is the human-owned release history.
- `.changeset/*.md` files are pre-release inputs.
- `releases.generated.json` is the generated runtime artifact for `/releases`.
- Do not edit `releases.generated.json` by hand.

## Backup Data

- The `princess-db/` directory is local-only backup input.
- You may read from it for validation and migration work.
- Do not add files from `princess-db/` to git.

## Operations

- Operators and agents must read `docs/OPERATIONS.md` before any deploy, migration, data copy or release work.

## Observability

- Production Worker telemetry goes to New Relic EU account `8569908` through evlog's OTLP drain. Local and preview environments do not ingest into New Relic.
- New Relic, Cloudflare Workers, Wrangler, and evlog skills in `.agents/skills/` are installed through `npx skills` and tracked by `skills-lock.json`. Their generic US examples do not override this project's EU endpoint: `https://mcp.eu.newrelic.com/mcp/`.
- Codex reads the project MCP server in `.codex/config.toml`; `.mcp.json` and `.pi/mcp.json` configure compatible local clients. MCP OAuth still requires the New Relic account's MCP Server and Local Clients features to be enabled.
- Never include Telegram identifiers, message text, webhook paths, headers, or secrets in telemetry attributes.
