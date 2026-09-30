import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
    applyDrizzleMigrations,
    type MigrationSqlExecutor
} from '../../scripts/db/wrangler-login-migration';
import { createD1Harness, type D1Harness } from './d1-harness';

const migrationsFolder = path.resolve(process.cwd(), 'drizzle');
const bookkeepingSql =
    'SELECT "hash", "created_at", "name" FROM "__drizzle_migrations" ORDER BY "id"';
const schemaSql =
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name";

const createHarnessExecutor = (harness: D1Harness): MigrationSqlExecutor => {
    const database = harness.env.DB;

    return {
        async query(sql) {
            const { results } = await database
                .prepare(sql)
                .all<Record<string, unknown>>();

            return results;
        },
        async execute(statements) {
            await database.batch(
                statements.map(statement => database.prepare(statement))
            );
        }
    };
};

const readRows = async (harness: D1Harness, sql: string) => {
    const { results } = await harness.env.DB.prepare(sql).all();

    return results;
};

describe('wrangler-login migration bookkeeping', () => {
    let drizzleHarness: D1Harness;
    let loginHarness: D1Harness;

    before(async () => {
        drizzleHarness = await createD1Harness();
        loginHarness = await createD1Harness();
    });

    after(async () => {
        await drizzleHarness.dispose();
        await loginHarness.dispose();
    });

    it('produces the same schema and bookkeeping rows as the drizzle migrator', async () => {
        await drizzleHarness.applyMigrations();

        const result = await applyDrizzleMigrations(
            createHarnessExecutor(loginHarness),
            migrationsFolder
        );

        assert.equal(result.applied.length, 7);
        assert.deepEqual(result.alreadyApplied, []);
        assert.deepEqual(
            await readRows(loginHarness, bookkeepingSql),
            await readRows(drizzleHarness, bookkeepingSql)
        );
        assert.deepEqual(
            await readRows(loginHarness, schemaSql),
            await readRows(drizzleHarness, schemaSql)
        );
    });

    it('leaves a subsequent drizzle migrate as a no-op', async () => {
        const before = await readRows(
            loginHarness,
            'SELECT * FROM "__drizzle_migrations" ORDER BY "id"'
        );

        await loginHarness.applyMigrations();

        assert.deepEqual(
            await readRows(
                loginHarness,
                'SELECT * FROM "__drizzle_migrations" ORDER BY "id"'
            ),
            before
        );
    });

    it('is itself a no-op when run again', async () => {
        const result = await applyDrizzleMigrations(
            createHarnessExecutor(loginHarness),
            migrationsFolder
        );

        assert.deepEqual(result.applied, []);
        assert.equal(result.alreadyApplied.length, 7);
    });

    it('resumes after drizzle applied only some migrations', async () => {
        const partialHarness = await createD1Harness();

        try {
            await applyDrizzleMigrations(
                createHarnessExecutor(partialHarness),
                migrationsFolder
            );
            await partialHarness.env.DB.prepare(
                'DELETE FROM "__drizzle_migrations" WHERE "name" = \'20260930205224_magical_exodus\''
            ).run();
            await partialHarness.env.DB.exec(
                'DROP TABLE "channel_snapshots"; ALTER TABLE "channels" DROP COLUMN "stopped_at"'
            );

            const result = await applyDrizzleMigrations(
                createHarnessExecutor(partialHarness),
                migrationsFolder
            );

            assert.equal(result.applied.length, 1);
            assert.deepEqual(
                await readRows(partialHarness, bookkeepingSql),
                await readRows(drizzleHarness, bookkeepingSql)
            );
        } finally {
            await partialHarness.dispose();
        }
    });
});
