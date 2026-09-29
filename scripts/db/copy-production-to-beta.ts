import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    createWranglerChildEnvironment,
    loadD1Environment
} from './d1-child-environment';
import {
    assertRemoteD1Target,
    getD1ExecuteArguments,
    getProjectRoot,
    getWranglerConfigPath
} from './d1-import-target';

export interface WranglerRunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export type WranglerRunner = (arguments_: string[]) => WranglerRunResult;

export const confirmOverwriteBetaFlag = '--confirm-overwrite-beta';
export const migrationsTableName = '__drizzle_migrations';
export const excludedTableNames = [
    migrationsTableName,
    'telegram_updates',
    'release_announcements'
];
export const copiedTablesInInsertOrder = [
    'players',
    'channels',
    'channel_members'
];
export const deleteChunkSize = 1000;

const maximumDeleteIterations = 10_000;
const exportedSqlFileName = 'production-data.sql';
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const parseCopyArguments = (rawArguments: string[]) => {
    const arguments_ = rawArguments.filter(argument => argument !== '--');
    const unknownArguments = arguments_.filter(argument => {
        return argument !== confirmOverwriteBetaFlag;
    });

    if (unknownArguments.length > 0) {
        throw new Error(
            `Unknown arguments: ${unknownArguments.join(' ')}. Usage: copy-production-to-beta.ts ${confirmOverwriteBetaFlag}`
        );
    }

    if (!arguments_.includes(confirmOverwriteBetaFlag)) {
        throw new Error(
            `Copying production data replaces ALL beta data. Re-run with ${confirmOverwriteBetaFlag} to confirm.`
        );
    }

    return { confirmOverwriteBeta: true as const };
};

export const assertDistinctCopyDatabases = (
    productionDatabaseId: string,
    betaDatabaseId: string
) => {
    if (productionDatabaseId === betaDatabaseId) {
        throw new Error(
            'Refusing to copy: production and beta resolve to the same D1 database'
        );
    }
};

export const selectCopyTables = (databaseTables: string[]) => {
    const candidateTables = databaseTables.filter(table => {
        return (
            !excludedTableNames.includes(table) &&
            !table.startsWith('sqlite_') &&
            !table.startsWith('_cf_')
        );
    });
    const unexpectedTables = candidateTables.filter(table => {
        return !copiedTablesInInsertOrder.includes(table);
    });
    const missingTables = copiedTablesInInsertOrder.filter(table => {
        return !candidateTables.includes(table);
    });

    if (unexpectedTables.length > 0 || missingTables.length > 0) {
        throw new Error(
            `Production table set changed (unexpected: ${unexpectedTables.join(', ') || 'none'}; missing: ${missingTables.join(', ') || 'none'}). Update copy-production-to-beta.ts before copying.`
        );
    }

    return [...copiedTablesInInsertOrder];
};

export const getWipeOrder = (tables: string[]) => [...tables].reverse();

export const getExportArguments = (
    configPath: string,
    outputPath: string,
    tables: string[]
) => {
    return [
        'exec',
        'wrangler',
        'd1',
        'export',
        'DB',
        '--config',
        configPath,
        '--env',
        'production',
        '--remote',
        '--output',
        outputPath,
        '--no-schema',
        ...tables.flatMap(table => ['--table', table]),
        '--skip-confirmation'
    ];
};

export const getQueryArguments = (
    target: 'production' | 'beta',
    configPath: string,
    command: string
) => {
    return getD1ExecuteArguments(target, configPath, { command });
};

export const getBetaImportArguments = (configPath: string, sqlPath: string) => {
    return getD1ExecuteArguments('beta', configPath, { file: sqlPath });
};

export const buildTableDiscoverySql = () => {
    return `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name";`;
};

export const buildMigrationHashesSql = () => {
    return `SELECT "hash" FROM "${migrationsTableName}" ORDER BY "id";`;
};

export const buildCountsSql = (tables: string[]) => {
    return `${tables
        .map(table => {
            return `SELECT '${table}' AS "table", COUNT(*) AS "count" FROM "${table}"`;
        })
        .join(' UNION ALL ')};`;
};

export const buildChunkedDeleteSql = (table: string) => {
    return `DELETE FROM "${table}" WHERE "rowid" IN (SELECT "rowid" FROM "${table}" LIMIT ${deleteChunkSize});`;
};

const redactUrls = (text: string) => text.replace(/https?:\/\/\S+/g, '[url]');

const parseJsonEnvelope = (stdout: string) => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout) as unknown;
    } catch (error) {
        throw new Error(`Wrangler returned invalid JSON: ${String(error)}`);
    }

    if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error('Wrangler returned an unexpected D1 result envelope');
    }

    const envelope = parsed[0] as Record<string, unknown> | null;

    if (
        typeof envelope !== 'object' ||
        envelope === null ||
        envelope.success !== true
    ) {
        throw new Error('Wrangler did not return a successful D1 result');
    }

    return envelope;
};

export const parseResultRows = (stdout: string) => {
    const { results } = parseJsonEnvelope(stdout);

    if (!Array.isArray(results)) {
        throw new Error('Wrangler D1 result has no rows array');
    }

    return results as Record<string, unknown>[];
};

export const parseChangedRows = (stdout: string) => {
    const { meta } = parseJsonEnvelope(stdout);
    const changes =
        typeof meta === 'object' && meta !== null && 'changes' in meta
            ? meta.changes
            : undefined;

    if (!Number.isSafeInteger(changes) || (changes as number) < 0) {
        throw new Error('Wrangler D1 result has no valid changes count');
    }

    return changes as number;
};

export const parseTableCounts = (stdout: string) => {
    const counts: Record<string, number> = {};

    for (const row of parseResultRows(stdout)) {
        if (
            typeof row.table !== 'string' ||
            !Number.isSafeInteger(row.count) ||
            (row.count as number) < 0
        ) {
            throw new Error('Wrangler returned an invalid table count row');
        }

        counts[row.table] = row.count as number;
    }

    return counts;
};

export const findCountMismatches = (
    productionCounts: Record<string, number>,
    betaCounts: Record<string, number>,
    tables: string[]
) => {
    return tables.filter(table => {
        return productionCounts[table] !== betaCounts[table];
    });
};

export interface CopyDependencies {
    runWrangler: WranglerRunner;
    productionDatabaseId: string;
    betaDatabaseId: string;
    configPath: string;
    log: (message: string) => void;
}

const runChecked = (
    dependencies: CopyDependencies,
    description: string,
    arguments_: string[]
) => {
    const result = dependencies.runWrangler(arguments_);

    if (result.status !== 0) {
        const detail = redactUrls((result.stderr || result.stdout).trim());

        throw new Error(
            detail
                ? `${description} failed: ${detail}`
                : `${description} exited with status ${String(result.status)}`
        );
    }

    return result.stdout;
};

const queryRows = (
    dependencies: CopyDependencies,
    target: 'production' | 'beta',
    description: string,
    sql: string
) => {
    return parseResultRows(
        runChecked(
            dependencies,
            description,
            getQueryArguments(target, dependencies.configPath, sql)
        )
    );
};

const readMigrationHashes = (
    dependencies: CopyDependencies,
    target: 'production' | 'beta'
) => {
    return queryRows(
        dependencies,
        target,
        `${target} migrations lookup`,
        buildMigrationHashesSql()
    ).map(row => String(row.hash));
};

const readTableCounts = (
    dependencies: CopyDependencies,
    target: 'production' | 'beta',
    tables: string[]
) => {
    return parseTableCounts(
        runChecked(
            dependencies,
            `${target} row count`,
            getQueryArguments(
                target,
                dependencies.configPath,
                buildCountsSql(tables)
            )
        )
    );
};

export const assertMigrationsMatch = (
    productionHashes: string[],
    betaHashes: string[]
) => {
    const matches =
        productionHashes.length === betaHashes.length &&
        productionHashes.every((hash, index) => hash === betaHashes[index]);

    if (!matches) {
        throw new Error(
            `Beta migrations (${betaHashes.length}) do not match production (${productionHashes.length}). Run "pnpm db:migrate:beta" first.`
        );
    }
};

const wipeBetaTable = (dependencies: CopyDependencies, table: string) => {
    for (let iteration = 0; iteration < maximumDeleteIterations; iteration++) {
        const changes = parseChangedRows(
            runChecked(
                dependencies,
                `beta ${table} wipe`,
                getQueryArguments(
                    'beta',
                    dependencies.configPath,
                    buildChunkedDeleteSql(table)
                )
            )
        );

        if (changes < deleteChunkSize) {
            return;
        }
    }

    throw new Error(`Beta ${table} wipe did not converge`);
};

const betaRestoreNotice =
    'Beta is now empty or only partially filled. Re-run "pnpm db:copy:production-to-beta --confirm-overwrite-beta" to restore it.';

export const copyProductionToBeta = (dependencies: CopyDependencies) => {
    assertDistinctCopyDatabases(
        dependencies.productionDatabaseId,
        dependencies.betaDatabaseId
    );

    const productionTables = selectCopyTables(
        queryRows(
            dependencies,
            'production',
            'production table discovery',
            buildTableDiscoverySql()
        ).map(row => String(row.name))
    );

    assertMigrationsMatch(
        readMigrationHashes(dependencies, 'production'),
        readMigrationHashes(dependencies, 'beta')
    );

    const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-d1-copy-')
    );
    const sqlPath = path.join(temporaryDirectory, exportedSqlFileName);

    try {
        dependencies.log('Exporting production data (production is blocked)');
        runChecked(
            dependencies,
            'production export',
            getExportArguments(
                dependencies.configPath,
                sqlPath,
                productionTables
            )
        );

        if (!fs.existsSync(sqlPath)) {
            throw new Error('Production export did not produce a SQL file');
        }

        const productionCounts = readTableCounts(
            dependencies,
            'production',
            productionTables
        );

        try {
            dependencies.log('Wiping beta application tables');

            for (const table of getWipeOrder(productionTables)) {
                wipeBetaTable(dependencies, table);
            }

            if (fs.readFileSync(sqlPath, 'utf8').includes('INSERT INTO')) {
                dependencies.log('Importing production data into beta');
                runChecked(
                    dependencies,
                    'beta import',
                    getBetaImportArguments(dependencies.configPath, sqlPath)
                );
            }

            const betaCounts = readTableCounts(
                dependencies,
                'beta',
                productionTables
            );
            const mismatches = findCountMismatches(
                productionCounts,
                betaCounts,
                productionTables
            );

            if (mismatches.length > 0) {
                throw new Error(
                    `Row counts differ after copy for: ${mismatches
                        .map(table => {
                            return `${table} (production=${String(productionCounts[table])}, beta=${String(betaCounts[table])})`;
                        })
                        .join(
                            ', '
                        )}. Production may have changed during the copy.`
                );
            }

            return { tables: productionTables, counts: betaCounts };
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);

            throw new Error(`${reason}\n${betaRestoreNotice}`, {
                cause: error
            });
        }
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
};

const createSpawnRunner = (
    projectRoot: string,
    wranglerLogDirectory: string
): WranglerRunner => {
    return arguments_ => {
        const result = spawnSync(pnpmExecutable, arguments_, {
            cwd: projectRoot,
            encoding: 'utf8',
            env: createWranglerChildEnvironment(process.env, 'production', {
                WRANGLER_LOG_PATH: wranglerLogDirectory
            }) as unknown as NodeJS.ProcessEnv,
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        if (result.error) {
            throw result.error;
        }

        return {
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr
        };
    };
};

export const runCopyProductionToBeta = (arguments_: string[]) => {
    parseCopyArguments(arguments_);

    const projectRoot = getProjectRoot();

    loadD1Environment(projectRoot);

    const productionDatabaseId = assertRemoteD1Target('production');
    const betaDatabaseId = assertRemoteD1Target('beta');

    const wranglerLogDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-d1-copy-logs-')
    );

    try {
        const summary = copyProductionToBeta({
            runWrangler: createSpawnRunner(projectRoot, wranglerLogDirectory),
            productionDatabaseId,
            betaDatabaseId,
            configPath: getWranglerConfigPath(),
            log: message => {
                console.log(message);
            }
        });

        console.log(
            JSON.stringify({ event: 'production_copied_to_beta', ...summary })
        );
    } finally {
        fs.rmSync(wranglerLogDirectory, { recursive: true, force: true });
    }
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    try {
        runCopyProductionToBeta(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
