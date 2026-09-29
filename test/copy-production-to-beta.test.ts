import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createWranglerChildEnvironment } from '../scripts/db/d1-child-environment';
import {
    assertDistinctCopyDatabases,
    buildChunkedDeleteSql,
    buildCountsSql,
    buildMigrationHashesSql,
    copiedTablesInInsertOrder,
    copyProductionToBeta,
    deleteChunkSize,
    getBetaImportArguments,
    getExportArguments,
    getWipeOrder,
    migrationsTableName,
    parseChangedRows,
    parseCopyArguments,
    selectCopyTables,
    type WranglerRunResult
} from '../scripts/db/copy-production-to-beta';

const configPath = path.resolve('/tmp/princess/wrangler.jsonc');
const databaseIds = {
    productionDatabaseId: 'production-id',
    betaDatabaseId: 'beta-id'
};
const allProductionTables = [
    '__drizzle_migrations',
    '_cf_KV',
    'channel_members',
    'channels',
    'players',
    'release_announcements',
    'sqlite_sequence',
    'telegram_updates'
];

const envelope = (results: unknown[], changes = 0) => {
    return JSON.stringify([{ success: true, results, meta: { changes } }]);
};

const ok = (stdout = ''): WranglerRunResult => {
    return { status: 0, stdout, stderr: '' };
};

interface FakeOptions {
    betaHashes?: string[];
    betaCountsAfterImport?: number;
    exportFails?: boolean;
    deleteChanges?: number[];
}

const createFakeRunner = (options: FakeOptions = {}) => {
    const calls: string[][] = [];
    const exportedFiles: string[] = [];
    const deleteChanges = [...(options.deleteChanges ?? [0, 0, 0])];
    const runWrangler = (arguments_: string[]): WranglerRunResult => {
        calls.push(arguments_);

        if (arguments_[3] === 'export') {
            if (options.exportFails) {
                return {
                    status: 1,
                    stdout: 'download https://signed.example/secret',
                    stderr: 'boom https://signed.example/secret'
                };
            }

            const outputPath =
                arguments_[arguments_.indexOf('--output') + 1] ?? '';

            exportedFiles.push(outputPath);
            fs.writeFileSync(outputPath, 'INSERT INTO "players" VALUES (1);');

            return ok();
        }

        const environment = arguments_[arguments_.indexOf('--env') + 1];
        const command = arguments_[arguments_.indexOf('--command') + 1] ?? '';

        if (command.includes('sqlite_master')) {
            return ok(envelope(allProductionTables.map(name => ({ name }))));
        }

        if (command.includes('__drizzle_migrations')) {
            const hashes =
                environment === 'beta'
                    ? (options.betaHashes ?? ['a', 'b'])
                    : ['a', 'b'];

            return ok(envelope(hashes.map(hash => ({ hash }))));
        }

        if (command.startsWith('DELETE')) {
            return ok(envelope([], deleteChanges.shift() ?? 0));
        }

        if (command.includes('COUNT(*)')) {
            const players =
                environment === 'beta'
                    ? (options.betaCountsAfterImport ?? 3)
                    : 3;

            return ok(
                envelope([
                    { table: 'players', count: players },
                    { table: 'channels', count: 2 },
                    { table: 'channel_members', count: 5 }
                ])
            );
        }

        return ok();
    };

    return { calls, exportedFiles, runWrangler };
};

test('copy arguments require the explicit overwrite confirmation flag', () => {
    assert.deepEqual(parseCopyArguments(['--confirm-overwrite-beta']), {
        confirmOverwriteBeta: true
    });
    assert.deepEqual(parseCopyArguments(['--', '--confirm-overwrite-beta']), {
        confirmOverwriteBeta: true
    });
    assert.throws(() => {
        parseCopyArguments([]);
    }, /--confirm-overwrite-beta to confirm/);
    assert.throws(() => {
        parseCopyArguments(['--confirm-overwrite-beta', '--target=production']);
    }, /Unknown arguments/);
});

test('copy direction guard rejects identical production and beta databases', () => {
    assert.throws(() => {
        assertDistinctCopyDatabases('same-id', 'same-id');
    }, /same D1 database/);
    assert.doesNotThrow(() => {
        assertDistinctCopyDatabases('production-id', 'beta-id');
    });
});

test('table selection excludes bookkeeping and ledger tables and fails on drift', () => {
    assert.deepEqual(
        selectCopyTables(allProductionTables),
        copiedTablesInInsertOrder
    );
    assert.deepEqual(getWipeOrder(copiedTablesInInsertOrder), [
        'channel_members',
        'channels',
        'players'
    ]);
    assert.throws(() => {
        selectCopyTables([...allProductionTables, 'new_table']);
    }, /unexpected: new_table/);
    assert.throws(() => {
        selectCopyTables(['players']);
    }, /missing: channels, channel_members/);
});

test('export and import commands are hard-wired production to beta', () => {
    const exportArguments = getExportArguments(
        configPath,
        '/tmp/out.sql',
        copiedTablesInInsertOrder
    );

    assert.deepEqual(exportArguments.slice(0, 10), [
        'exec',
        'wrangler',
        'd1',
        'export',
        'DB',
        '--config',
        configPath,
        '--env',
        'production',
        '--remote'
    ]);
    assert.ok(exportArguments.includes('--no-schema'));
    assert.deepEqual(
        exportArguments.filter((_argument, index) => {
            return exportArguments[index - 1] === '--table';
        }),
        copiedTablesInInsertOrder
    );
    assert.equal(exportArguments.includes('telegram_updates'), false);
    assert.equal(exportArguments.includes('release_announcements'), false);
    assert.deepEqual(getBetaImportArguments(configPath, '/tmp/out.sql'), [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'DB',
        '--config',
        configPath,
        '--env',
        'beta',
        '--remote',
        '--file',
        '/tmp/out.sql',
        '--yes'
    ]);
});

test('generated SQL is chunked and quoted', () => {
    assert.equal(
        buildChunkedDeleteSql('players'),
        `DELETE FROM "players" WHERE "rowid" IN (SELECT "rowid" FROM "players" LIMIT ${deleteChunkSize});`
    );
    assert.match(buildCountsSql(['a', 'b']), /FROM "a" UNION ALL SELECT 'b'/);
    assert.equal(parseChangedRows(envelope([], 7)), 7);
});

test('copy runs migrations check, wipe in FK order, import, verify, and cleans up', () => {
    const fake = createFakeRunner({ deleteChanges: [0, 0, 0] });
    const logs: string[] = [];
    const result = copyProductionToBeta({
        runWrangler: fake.runWrangler,
        ...databaseIds,
        configPath,
        log: message => {
            logs.push(message);
        }
    });

    const deleteCommands = fake.calls
        .map(call => call[call.indexOf('--command') + 1])
        .filter(command => command?.startsWith('DELETE'));

    assert.deepEqual(
        deleteCommands.map(command => command?.split('"')[1]),
        ['channel_members', 'channels', 'players']
    );
    assert.equal(fake.calls.filter(call => call.includes('--file')).length, 1);
    assert.deepEqual(result.counts, {
        players: 3,
        channels: 2,
        channel_members: 5
    });
    assert.equal(fake.exportedFiles.length, 1);
    assert.equal(fs.existsSync(fake.exportedFiles[0] ?? ''), false);
    assert.equal(
        fs.existsSync(path.dirname(fake.exportedFiles[0] ?? '')),
        false
    );
});

test('copy keeps deleting while chunks are full', () => {
    const fake = createFakeRunner({
        deleteChanges: [deleteChunkSize, 4, 0, 0]
    });

    copyProductionToBeta({
        runWrangler: fake.runWrangler,
        ...databaseIds,
        configPath,
        log: () => undefined
    });

    const deleteCalls = fake.calls.filter(call => {
        return call[call.indexOf('--command') + 1]?.startsWith('DELETE');
    });

    assert.equal(deleteCalls.length, 4);
});

test('copy aborts before touching production or beta data when migrations differ', () => {
    const fake = createFakeRunner({ betaHashes: ['a'] });

    assert.throws(() => {
        copyProductionToBeta({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /pnpm db:migrate:beta/);
    assert.equal(fake.exportedFiles.length, 0);
    assert.equal(
        fake.calls.some(call => {
            return call[call.indexOf('--command') + 1]?.startsWith('DELETE');
        }),
        false
    );
});

test('copy fails on row count mismatch and still removes the SQL file', () => {
    const fake = createFakeRunner({ betaCountsAfterImport: 1 });

    assert.throws(() => {
        copyProductionToBeta({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /players \(production=3, beta=1\)/);
    assert.equal(fs.existsSync(fake.exportedFiles[0] ?? ''), false);
});

test('copy itself refuses identical production and beta database ids', () => {
    const fake = createFakeRunner();

    assert.throws(() => {
        copyProductionToBeta({
            runWrangler: fake.runWrangler,
            productionDatabaseId: 'same-id',
            betaDatabaseId: 'same-id',
            configPath,
            log: () => undefined
        });
    }, /same D1 database/);
    assert.equal(fake.calls.length, 0);
});

test('post-wipe failures state that beta is empty or partial and how to restore it', () => {
    const fake = createFakeRunner({ betaCountsAfterImport: 1 });

    assert.throws(() => {
        copyProductionToBeta({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /Beta is now empty or only partially filled\. Re-run "pnpm db:copy:production-to-beta --confirm-overwrite-beta"/);
});

test('wrangler log path is allowed through the child environment only when provided', () => {
    const source = {
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_API_TOKEN: 'token',
        WRANGLER_LOG_PATH: '/home/user/.config/.wrangler/logs'
    };

    assert.equal(
        createWranglerChildEnvironment(source, 'production').WRANGLER_LOG_PATH,
        undefined
    );
    assert.equal(
        createWranglerChildEnvironment(source, 'production', {
            WRANGLER_LOG_PATH: '/tmp/copy-logs'
        }).WRANGLER_LOG_PATH,
        '/tmp/copy-logs'
    );
});

test('migration hashes are read from the drizzle migrations table', () => {
    assert.equal(migrationsTableName, '__drizzle_migrations');
    assert.match(
        buildMigrationHashesSql(),
        /SELECT "hash" FROM "__drizzle_migrations" ORDER BY "id"/
    );
});

test('export failures redact signed URLs from the error', () => {
    const fake = createFakeRunner({ exportFails: true });

    assert.throws(
        () => {
            copyProductionToBeta({
                runWrangler: fake.runWrangler,
                ...databaseIds,
                ...databaseIds,
                ...databaseIds,
                configPath,
                log: () => undefined
            });
        },
        (error: Error) => {
            return (
                /production export failed/.test(error.message) &&
                !error.message.includes('signed.example')
            );
        }
    );
});

test('package exposes the copy command through the guarded script', () => {
    const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    assert.equal(
        packageJson.scripts['db:copy:production-to-beta'],
        'tsx scripts/db/copy-production-to-beta.ts'
    );
});
