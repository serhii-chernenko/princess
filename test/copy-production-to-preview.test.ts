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
    copyProductionToPreview,
    countInsertStatements,
    deleteChunkSize,
    getPreviewImportArguments,
    getExportArguments,
    getWipeOrder,
    migrationsTableName,
    parseChangedRows,
    parseCopyArguments,
    selectCopyTables,
    type WranglerRunResult
} from '../scripts/db/copy-production-to-preview';

const configPath = path.resolve('/tmp/princess/wrangler.jsonc');
const databaseIds = {
    productionDatabaseId: 'production-id',
    previewDatabaseId: 'preview-id'
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
    previewHashes?: string[];
    previewCountsAfterImport?: number;
    exportFails?: boolean;
    deleteChanges?: number[];
    exportedRowsOverride?: Record<string, number>;
}

const productionRowCounts: Record<string, number> = {
    players: 3,
    channels: 2,
    channel_members: 5
};

const createFakeRunner = (options: FakeOptions = {}) => {
    const calls: string[][] = [];
    const exportedFiles: string[] = [];
    const importedFiles: string[] = [];
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
            const table = arguments_[arguments_.indexOf('--table') + 1] ?? '';
            const rowTotal =
                options.exportedRowsOverride?.[table] ??
                productionRowCounts[table] ??
                0;

            fs.writeFileSync(
                outputPath,
                Array.from({ length: rowTotal }, (_, index) => {
                    return `INSERT INTO "${table}" VALUES (${String(index + 1)});`;
                }).join('\n')
            );

            return ok();
        }

        if (arguments_.includes('--file')) {
            importedFiles.push(
                arguments_[arguments_.indexOf('--file') + 1] ?? ''
            );
        }

        const environment =
            arguments_[4] === 'princess-preview' ? 'preview' : 'production';
        const command = arguments_[arguments_.indexOf('--command') + 1] ?? '';

        if (command.includes('sqlite_master')) {
            return ok(envelope(allProductionTables.map(name => ({ name }))));
        }

        if (command.includes('__drizzle_migrations')) {
            const hashes =
                environment === 'preview'
                    ? (options.previewHashes ?? ['a', 'b'])
                    : ['a', 'b'];

            return ok(envelope(hashes.map(hash => ({ hash }))));
        }

        if (command.startsWith('DELETE')) {
            return ok(envelope([], deleteChanges.shift() ?? 0));
        }

        if (command.includes('COUNT(*)')) {
            const players =
                environment === 'preview'
                    ? (options.previewCountsAfterImport ?? 3)
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

    return { calls, exportedFiles, importedFiles, runWrangler };
};

test('copy arguments require the explicit overwrite confirmation flag', () => {
    assert.deepEqual(parseCopyArguments(['--confirm-overwrite-preview']), {
        confirmOverwritePreview: true
    });
    assert.deepEqual(
        parseCopyArguments(['--', '--confirm-overwrite-preview']),
        {
            confirmOverwritePreview: true
        }
    );
    assert.throws(() => {
        parseCopyArguments([]);
    }, /--confirm-overwrite-preview to confirm/);
    assert.throws(() => {
        parseCopyArguments([
            '--confirm-overwrite-preview',
            '--target=production'
        ]);
    }, /Unknown arguments/);
});

test('copy direction guard rejects identical production and preview databases', () => {
    assert.throws(() => {
        assertDistinctCopyDatabases('same-id', 'same-id');
    }, /same D1 database/);
    assert.doesNotThrow(() => {
        assertDistinctCopyDatabases('production-id', 'preview-id');
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

test('export and import commands are hard-wired production to preview', () => {
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
    assert.deepEqual(getPreviewImportArguments(configPath, '/tmp/out.sql'), [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'princess-preview',
        '--config',
        configPath,
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
    const result = copyProductionToPreview({
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
    assert.deepEqual(
        fake.importedFiles.map(file => path.basename(file)),
        ['players.sql', 'channels.sql', 'channel_members.sql']
    );
    assert.deepEqual(result.counts, {
        players: 3,
        channels: 2,
        channel_members: 5
    });
    assert.equal(fake.exportedFiles.length, 3);
    assert.equal(fs.existsSync(fake.exportedFiles[0] ?? ''), false);
    assert.equal(
        fs.existsSync(path.dirname(fake.exportedFiles[0] ?? '')),
        false
    );
});

test('copy aborts before wiping preview when an export lacks production rows', () => {
    const fake = createFakeRunner({
        exportedRowsOverride: { channel_members: 0 }
    });

    assert.throws(() => {
        copyProductionToPreview({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /channel_members export has 0 INSERT statements but production has 5 rows/);
    assert.equal(
        fake.calls.some(call => {
            return call[call.indexOf('--command') + 1]?.startsWith('DELETE');
        }),
        false
    );
    assert.equal(fake.importedFiles.length, 0);
});

test('insert statements are counted per table at line starts', () => {
    const sql = [
        'INSERT INTO "players" VALUES (1);',
        'INSERT INTO "players" VALUES (2);',
        'INSERT INTO "channels" VALUES (1);'
    ].join('\n');

    assert.equal(countInsertStatements(sql, 'players'), 2);
    assert.equal(countInsertStatements(sql, 'channels'), 1);
    assert.equal(countInsertStatements(sql, 'channel_members'), 0);
});

test('copy keeps deleting while chunks are full', () => {
    const fake = createFakeRunner({
        deleteChanges: [deleteChunkSize, 4, 0, 0]
    });

    copyProductionToPreview({
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

test('copy aborts before touching production or preview data when migrations differ', () => {
    const fake = createFakeRunner({ previewHashes: ['a'] });

    assert.throws(() => {
        copyProductionToPreview({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /pnpm db:migrate:preview/);
    assert.equal(fake.exportedFiles.length, 0);
    assert.equal(
        fake.calls.some(call => {
            return call[call.indexOf('--command') + 1]?.startsWith('DELETE');
        }),
        false
    );
});

test('copy fails on row count mismatch and still removes the SQL file', () => {
    const fake = createFakeRunner({ previewCountsAfterImport: 1 });

    assert.throws(() => {
        copyProductionToPreview({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /players \(production=3, preview=1\)/);
    assert.equal(fs.existsSync(fake.exportedFiles[0] ?? ''), false);
});

test('copy itself refuses identical production and preview database ids', () => {
    const fake = createFakeRunner();

    assert.throws(() => {
        copyProductionToPreview({
            runWrangler: fake.runWrangler,
            productionDatabaseId: 'same-id',
            previewDatabaseId: 'same-id',
            configPath,
            log: () => undefined
        });
    }, /same D1 database/);
    assert.equal(fake.calls.length, 0);
});

test('post-wipe failures state that preview is empty or partial and how to restore it', () => {
    const fake = createFakeRunner({ previewCountsAfterImport: 1 });

    assert.throws(() => {
        copyProductionToPreview({
            runWrangler: fake.runWrangler,
            ...databaseIds,
            configPath,
            log: () => undefined
        });
    }, /Preview is now empty or only partially filled\. Re-run "pnpm db:copy:production-to-preview --confirm-overwrite-preview"/);
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
            copyProductionToPreview({
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
                /production players export failed/.test(error.message) &&
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
        packageJson.scripts['db:copy:production-to-preview'],
        'tsx scripts/db/copy-production-to-preview.ts'
    );
});
