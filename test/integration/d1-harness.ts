import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from 'drizzle-orm/d1/migrator';
import { getPlatformProxy } from 'wrangler';

import { createDb } from '../../src/db/client';
import { createRepositories } from '../../src/db/repositories';
import type { WorkerBindings } from '../../src/worker/env';

const migrationsFolder = path.resolve(process.cwd(), 'drizzle');

export interface D1HarnessOptions {
    persistDirectory?: string;
}

export const createD1Harness = async (options: D1HarnessOptions = {}) => {
    const ownsPersistDirectory = options.persistDirectory === undefined;
    const persistDirectory =
        options.persistDirectory ??
        fs.mkdtempSync(path.join(os.tmpdir(), 'princess-d1-integration-'));
    const proxy = await getPlatformProxy<WorkerBindings>({
        persist: { path: persistDirectory }
    });
    const db = createDb(proxy.env);

    return {
        env: proxy.env,
        persistDirectory,
        db,
        repositories: createRepositories(db),
        applyMigrations() {
            return migrate(db, { migrationsFolder });
        },
        async clearApplicationTables() {
            await proxy.env.DB.batch([
                proxy.env.DB.prepare('DELETE FROM channel_snapshots'),
                proxy.env.DB.prepare('DELETE FROM release_announcements'),
                proxy.env.DB.prepare('DELETE FROM vote_wins'),
                proxy.env.DB.prepare('DELETE FROM channel_members'),
                proxy.env.DB.prepare('DELETE FROM channels'),
                proxy.env.DB.prepare('DELETE FROM players'),
                proxy.env.DB.prepare('DELETE FROM telegram_updates')
            ]);
        },
        async dispose() {
            await proxy.dispose();

            if (ownsPersistDirectory) {
                fs.rmSync(persistDirectory, { recursive: true, force: true });
            }
        }
    };
};

export type D1Harness = Awaited<ReturnType<typeof createD1Harness>>;

export const countRows = async (harness: D1Harness, tableName: string) => {
    const row = await harness.env.DB.prepare(
        `SELECT count(*) AS total FROM ${tableName}`
    ).first<{ total: number }>();

    return row?.total ?? 0;
};

export const seedGeneratedPlayers = async (
    harness: D1Harness,
    playerCount: number
) => {
    await harness.env.DB.prepare(
        `INSERT INTO players (telegram_user_id, display_name, created_at, updated_at)
        WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
        )
        SELECT n, 'player ' || n, 0, 0 FROM sequence`
    )
        .bind(playerCount)
        .run();
};

export const createWorkerEnv = (
    harness: D1Harness,
    overrides: Record<string, string>
) => {
    return { ...harness.env, ...overrides } as typeof harness.env;
};
