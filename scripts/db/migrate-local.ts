import { migrate } from 'drizzle-orm/d1/migrator';
import { getPlatformProxy } from 'wrangler';

import { createDb } from '../../src/db/client';
import type { WorkerBindings } from '../../src/worker/env';

const run = async () => {
    const proxy = await getPlatformProxy<WorkerBindings>({
        persist: {
            path: '.wrangler/state/v3'
        }
    });

    try {
        const db = createDb(proxy.env);

        await migrate(db, {
            migrationsFolder: './drizzle'
        });

        const tables = await proxy.env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).all<{ name: string }>();

        console.log(
            JSON.stringify(
                {
                    migrated: true,
                    tables: tables.results.map(row => row.name)
                },
                null,
                2
            )
        );
    } finally {
        await proxy.dispose();
    }
};

void run();
