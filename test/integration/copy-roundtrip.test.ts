import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
    buildChunkedDeleteSql,
    copiedTablesInInsertOrder,
    getExportArguments,
    getWipeOrder
} from '../../scripts/db/copy-production-to-preview';
import { createD1Harness, type D1Harness } from './d1-harness';

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const projectRoot = process.cwd();
const wranglerTimeoutMs = 60_000;
const trickyDisplayName = 'O\'Brien "Q"; DROP TABLE players;-- \u{1F451} Хай';
const seededPlayerTotal = 150;
const seededChannelTotal = 3;
const largeChannelMemberTotal = 130;
const smallChannelMemberTotal = 40;
const seededTimestamp = 1_752_580_800_000;
const localConfigSource = {
    name: 'copy-roundtrip',
    compatibility_date: '2026-05-09',
    d1_databases: [
        {
            binding: 'DB',
            database_name: 'princess-local',
            database_id: '00000000-0000-0000-0000-000000000000'
        }
    ]
};

const createWranglerEnvironment = () => {
    const environment: NodeJS.ProcessEnv = { ...process.env };

    delete environment.CLOUDFLARE_API_TOKEN;
    delete environment.CLOUDFLARE_ACCOUNT_ID;
    environment.WRANGLER_SEND_METRICS = 'false';

    return environment;
};

const runWrangler = (arguments_: string[]) => {
    return spawnSync(pnpmExecutable, ['exec', 'wrangler', ...arguments_], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: createWranglerEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        timeout: wranglerTimeoutMs
    });
};

const isWranglerRunnable = () => {
    const result = runWrangler(['--version']);

    return result.error === undefined && result.status === 0;
};

const createLocalDirectory = () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-d1-roundtrip-')
    );
    const configPath = path.join(directory, 'wrangler.jsonc');
    const stateDirectory = path.join(directory, '.wrangler', 'state');

    fs.writeFileSync(configPath, JSON.stringify(localConfigSource));

    return {
        directory,
        configPath,
        stateDirectory,
        proxyPersistDirectory: path.join(stateDirectory, 'v3')
    };
};

type LocalDirectory = ReturnType<typeof createLocalDirectory>;

const getLocalExportArguments = (local: LocalDirectory, outputPath: string) => {
    const remoteArguments = getExportArguments(
        local.configPath,
        outputPath,
        copiedTablesInInsertOrder
    );
    const environmentIndex = remoteArguments.indexOf('--env');
    const withoutEnvironment = remoteArguments.filter((_, index) => {
        return index !== environmentIndex && index !== environmentIndex + 1;
    });

    return withoutEnvironment.slice(2).map(argument => {
        return argument === '--remote' ? '--local' : argument;
    });
};

const runChecked = (arguments_: string[]) => {
    const result = runWrangler(arguments_);

    assert.equal(
        result.status,
        0,
        `wrangler ${arguments_.join(' ')} failed: ${result.stderr}${result.stdout}`
    );

    return result.stdout;
};

const executeLocal = (
    local: LocalDirectory,
    source: { command: string } | { file: string }
) => {
    const sourceArguments =
        'command' in source
            ? ['--command', source.command]
            : ['--file', source.file];

    return runChecked([
        'd1',
        'execute',
        'DB',
        '--local',
        '--config',
        local.configPath,
        '--persist-to',
        local.stateDirectory,
        '--yes',
        '--json',
        ...sourceArguments
    ]);
};

const wipeApplicationTables = (local: LocalDirectory) => {
    for (const table of getWipeOrder(copiedTablesInInsertOrder)) {
        executeLocal(local, { command: buildChunkedDeleteSql(table) });
    }
};

const snapshotTables = async (harness: D1Harness) => {
    const snapshot: Record<string, string> = {};

    for (const table of copiedTablesInInsertOrder) {
        const { results } = await harness.env.DB.prepare(
            `SELECT * FROM ${table} ORDER BY id`
        ).all();

        snapshot[table] = JSON.stringify(results);
    }

    return snapshot;
};

const countTables = async (harness: D1Harness) => {
    const counts: Record<string, number> = {};

    for (const table of copiedTablesInInsertOrder) {
        const row = await harness.env.DB.prepare(
            `SELECT count(*) AS total FROM ${table}`
        ).first<{ total: number }>();

        counts[table] = row?.total ?? 0;
    }

    return counts;
};

const seedSourceDatabase = async (harness: D1Harness) => {
    const { DB } = harness.env;

    await DB.prepare(
        `INSERT INTO players (telegram_user_id, display_name, created_at, updated_at)
        WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
        )
        SELECT n, 'player ' || n, ?, ? FROM sequence`
    )
        .bind(seededPlayerTotal, seededTimestamp, seededTimestamp)
        .run();
    await DB.prepare('UPDATE players SET display_name = ? WHERE id = 1')
        .bind(trickyDisplayName)
        .run();
    await DB.prepare(
        `INSERT INTO channels (telegram_chat_id, language, release_version, last_vote_at, created_at)
        WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
        )
        SELECT -1000 - n, CASE WHEN n = 2 THEN 'en' ELSE 'ua' END, '5.0.0', CASE WHEN n = 1 THEN ? END, ?
        FROM sequence`
    )
        .bind(seededChannelTotal, seededTimestamp, seededTimestamp)
        .run();

    const insertMembers = (channelId: number, memberTotal: number) => {
        return DB.prepare(
            `INSERT INTO channel_members (channel_id, player_id, score, is_active, is_auto_joined, created_at, updated_at)
            SELECT ?, id, id * 3, id % 2, id % 3 = 0, ?, ? FROM players WHERE id <= ?`
        )
            .bind(channelId, seededTimestamp, seededTimestamp, memberTotal)
            .run();
    };

    await insertMembers(1, largeChannelMemberTotal);
    await insertMembers(2, smallChannelMemberTotal);
};

describe('production to preview export and import round trip', () => {
    const wranglerRunnable = isWranglerRunnable();
    const localDirectories: LocalDirectory[] = [];
    let sourceSnapshot: Record<string, string>;
    let sourceCounts: Record<string, number>;
    let exportedSqlPath: string;
    let destination: LocalDirectory;

    before(async () => {
        if (!wranglerRunnable) {
            return;
        }

        const source = createLocalDirectory();

        destination = createLocalDirectory();
        localDirectories.push(source, destination);

        const sourceHarness = await createD1Harness({
            persistDirectory: source.proxyPersistDirectory
        });

        try {
            await sourceHarness.applyMigrations();
            await seedSourceDatabase(sourceHarness);
            sourceSnapshot = await snapshotTables(sourceHarness);
            sourceCounts = await countTables(sourceHarness);
        } finally {
            await sourceHarness.dispose();
        }

        const destinationHarness = await createD1Harness({
            persistDirectory: destination.proxyPersistDirectory
        });

        try {
            await destinationHarness.applyMigrations();
        } finally {
            await destinationHarness.dispose();
        }

        exportedSqlPath = path.join(source.directory, 'production-data.sql');
        runChecked(getLocalExportArguments(source, exportedSqlPath));
    });

    after(() => {
        for (const local of localDirectories) {
            fs.rmSync(local.directory, { recursive: true, force: true });
        }
    });

    it(
        'exports only INSERT statements without schema for the copied tables',
        { skip: !wranglerRunnable },
        () => {
            const exportedSql = fs.readFileSync(exportedSqlPath, 'utf8');

            assert.doesNotMatch(exportedSql, /CREATE (TABLE|INDEX)/);
            assert.doesNotMatch(exportedSql, /__drizzle_migrations/);
            assert.match(exportedSql, /INSERT INTO "channel_members"/);
            assert.ok((sourceCounts.channel_members ?? 0) > 100);
        }
    );

    it(
        'imports identical rows after a wipe and stays identical when repeated',
        { skip: !wranglerRunnable },
        async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
                wipeApplicationTables(destination);
                executeLocal(destination, { file: exportedSqlPath });

                const harness = await createD1Harness({
                    persistDirectory: destination.proxyPersistDirectory
                });

                try {
                    assert.deepEqual(await countTables(harness), sourceCounts);
                    assert.deepEqual(
                        await snapshotTables(harness),
                        sourceSnapshot
                    );
                } finally {
                    await harness.dispose();
                }
            }
        }
    );
});
