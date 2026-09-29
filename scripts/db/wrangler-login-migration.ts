import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils';

import { migrationsTableName } from './copy-production-to-beta';
import { createWranglerChildEnvironment } from './d1-child-environment';
import { getD1ExecuteArguments } from './d1-import-target';
import type { D1DatabaseTarget } from './production-d1-target';

export interface MigrationSqlExecutor {
    query: (sql: string) => Promise<Record<string, unknown>[]>;
    execute: (statements: string[]) => Promise<void>;
}

export interface WranglerLoginMigrationResult {
    applied: string[];
    alreadyApplied: string[];
}

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const migrationNamePattern = /^[0-9]{14}_[A-Za-z0-9_]+$/;
const migrationHashPattern = /^[0-9a-f]{64}$/;

export const buildCreateMigrationsTableSql = () => {
    return [
        `CREATE TABLE IF NOT EXISTS "${migrationsTableName}" (`,
        '\t\t\tid INTEGER PRIMARY KEY,',
        '\t\t\thash text NOT NULL,',
        '\t\t\tcreated_at numeric,',
        '\t\t\tname text,',
        '\t\t\tapplied_at TEXT',
        '\t\t);'
    ].join('\n');
};

export const buildInsertMigrationSql = (
    migration: { hash: string; folderMillis: number; name: string },
    appliedAt: Date
) => {
    if (
        !migrationHashPattern.test(migration.hash) ||
        !migrationNamePattern.test(migration.name) ||
        !Number.isSafeInteger(migration.folderMillis)
    ) {
        throw new Error(
            `Refusing to record unexpected migration ${migration.name}`
        );
    }

    return `INSERT INTO "${migrationsTableName}" ("hash", "created_at", "name", "applied_at") values('${migration.hash}', ${migration.folderMillis}, '${migration.name}', '${appliedAt.toISOString()}');`;
};

const readAppliedMigrations = async (executor: MigrationSqlExecutor) => {
    const tables = await executor.query(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = '${migrationsTableName}';`
    );

    if (tables.length === 0) {
        await executor.execute([buildCreateMigrationsTableSql()]);

        return [];
    }

    const columns = (
        await executor.query(
            `SELECT "name" FROM pragma_table_info('${migrationsTableName}');`
        )
    ).map(column => column.name);

    if (!columns.includes('name') || !columns.includes('applied_at')) {
        throw new Error(
            `${migrationsTableName} uses a legacy layout; upgrade it with drizzle before migrating in wrangler-login mode`
        );
    }

    const rows = await executor.query(
        `SELECT "id", "hash", "created_at", "name" FROM "${migrationsTableName}";`
    );

    return rows.map(row => {
        return {
            id: Number(row.id),
            hash: String(row.hash),
            created_at: String(row.created_at),
            name: typeof row.name === 'string' ? row.name : null
        };
    });
};

export const applyDrizzleMigrations = async (
    executor: MigrationSqlExecutor,
    migrationsFolder: string,
    now: () => Date = () => new Date()
): Promise<WranglerLoginMigrationResult> => {
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const dbMigrations = await readAppliedMigrations(executor);
    const pending = getMigrationsToRun({ localMigrations, dbMigrations });
    const pendingNames = new Set(pending.map(migration => migration.name));

    for (const migration of pending) {
        const migrationStatements = migration.sql.filter(statement => {
            return statement.trim() !== '';
        });

        await executor.execute([
            ...migrationStatements,
            buildInsertMigrationSql(migration, now())
        ]);
    }

    return {
        applied: pending.map(migration => migration.name),
        alreadyApplied: localMigrations
            .map(migration => migration.name)
            .filter(name => !pendingNames.has(name))
    };
};

export const parseD1Rows = (output: string) => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(output) as unknown;
    } catch (error) {
        throw new Error(`Wrangler returned invalid JSON: ${String(error)}`);
    }

    if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error('Wrangler returned an unexpected D1 result envelope');
    }

    const envelope = parsed[0] as { success?: unknown; results?: unknown };

    if (envelope.success !== true || !Array.isArray(envelope.results)) {
        throw new Error('Wrangler did not return a successful D1 result');
    }

    return envelope.results as Record<string, unknown>[];
};

export const createWranglerMigrationExecutor = (
    target: D1DatabaseTarget,
    projectRoot: string,
    wranglerConfigPath: string,
    source: Readonly<Record<string, string | undefined>> = process.env
): MigrationSqlExecutor => {
    const run = (
        operation: { command: string } | { file: string },
        stdio: 'inherit' | 'pipe'
    ) => {
        const result = spawnSync(
            pnpmExecutable,
            getD1ExecuteArguments(target, wranglerConfigPath, operation),
            {
                cwd: projectRoot,
                encoding: 'utf8',
                env: createWranglerChildEnvironment(
                    source,
                    target
                ) as unknown as NodeJS.ProcessEnv,
                maxBuffer: 16 * 1024 * 1024,
                stdio:
                    stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe']
            }
        );

        if (result.error) {
            throw result.error;
        }

        if (result.status !== 0) {
            const detail =
                `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();

            throw new Error(
                detail
                    ? `${target} D1 migration step failed: ${detail}`
                    : `${target} D1 migration step exited with status ${result.status}`
            );
        }

        return result.stdout ?? '';
    };

    return {
        async query(sql) {
            return parseD1Rows(run({ command: sql }, 'pipe'));
        },
        async execute(statements) {
            const directory = fs.mkdtempSync(
                path.join(os.tmpdir(), 'princess-d1-migration-')
            );
            const filePath = path.join(directory, 'migration.sql');

            try {
                fs.writeFileSync(filePath, `${statements.join('\n')}\n`, {
                    encoding: 'utf8',
                    mode: 0o600
                });
                run({ file: filePath }, 'inherit');
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }
    };
};

export const runWranglerLoginMigration = (
    target: D1DatabaseTarget,
    projectRoot: string,
    wranglerConfigPath: string
) => {
    return applyDrizzleMigrations(
        createWranglerMigrationExecutor(
            target,
            projectRoot,
            wranglerConfigPath
        ),
        path.join(projectRoot, 'drizzle')
    );
};
