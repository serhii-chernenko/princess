import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createDrizzleChildEnvironment,
    createWranglerChildEnvironment
} from '../scripts/db/d1-child-environment';
import { getD1ExecuteArguments } from '../scripts/db/d1-import-target';
import { getProductionMigrationArguments } from '../scripts/db/migrate-production';
import { prepareMongoImport } from '../scripts/db/mongo-import';
import {
    parseD1DatabaseId,
    resolveBetaD1DatabaseId,
    resolveProductionD1DatabaseId
} from '../scripts/db/production-d1-target';
import { resolveMongoBackupRepository } from '../scripts/db/run-mongo-import';

const productionDatabaseId = '12345678-1234-1234-1234-1234567890ab';
const otherDatabaseId = '87654321-4321-4321-4321-ba0987654321';

const betaDatabaseId = 'abcdef12-1234-1234-1234-1234567890ab';

const createWranglerConfig = (
    databaseId: string,
    options: {
        productionDatabaseName?: string;
        betaDatabaseId?: string;
        betaDatabaseName?: string;
    } = {}
) => {
    const createBinding = (bindingDatabaseId: string, databaseName: string) => {
        return {
            binding: 'DB',
            database_id: bindingDatabaseId,
            database_name: databaseName
        };
    };

    return JSON.stringify({
        env: {
            production: {
                d1_databases: [
                    createBinding(
                        databaseId,
                        options.productionDatabaseName ?? 'princess-production'
                    )
                ]
            },
            beta: {
                d1_databases: [
                    createBinding(
                        options.betaDatabaseId ?? betaDatabaseId,
                        options.betaDatabaseName ?? 'princess-beta'
                    )
                ]
            }
        }
    });
};

test('D1 target parser resolves each environment to its own binding', () => {
    const config = createWranglerConfig(productionDatabaseId);

    assert.equal(parseD1DatabaseId(config, 'production'), productionDatabaseId);
    assert.equal(parseD1DatabaseId(config, 'beta'), betaDatabaseId);
});

test('production D1 target ignores unconfigured beta placeholders', () => {
    const config = createWranglerConfig(productionDatabaseId, {
        betaDatabaseId: 'REPLACE_WITH_BETA_DATABASE_ID'
    });

    assert.equal(parseD1DatabaseId(config, 'production'), productionDatabaseId);
    assert.throws(() => {
        parseD1DatabaseId(config, 'beta');
    }, /must be a real lowercase Cloudflare D1 database UUID/);
});

test('D1 target parser rejects placeholders, zero IDs, and ambiguity', () => {
    assert.throws(() => {
        parseD1DatabaseId(
            createWranglerConfig('REPLACE_WITH_PRODUCTION_DATABASE_ID'),
            'production'
        );
    }, /must be a real lowercase Cloudflare D1 database UUID/);
    assert.throws(() => {
        parseD1DatabaseId(
            createWranglerConfig('00000000-0000-0000-0000-000000000000'),
            'production'
        );
    }, /must be a real lowercase Cloudflare D1 database UUID/);
    assert.throws(() => {
        parseD1DatabaseId(
            JSON.stringify({
                env: {
                    production: {
                        d1_databases: [
                            {
                                binding: 'DB',
                                database_id: productionDatabaseId,
                                database_name: 'princess-production'
                            },
                            {
                                binding: 'DB',
                                database_id: otherDatabaseId,
                                database_name: 'princess-production'
                            }
                        ]
                    }
                }
            }),
            'production'
        );
    }, /must define exactly one DB binding/);
});

test('D1 targets enforce per-environment names and forbid sharing', () => {
    assert.throws(() => {
        parseD1DatabaseId(
            createWranglerConfig(productionDatabaseId, {
                productionDatabaseName: 'wrong-production-name'
            }),
            'production'
        );
    }, /production DB database_name must be princess-production/);
    assert.throws(() => {
        parseD1DatabaseId(
            createWranglerConfig(productionDatabaseId, {
                betaDatabaseName: 'princess-production'
            }),
            'beta'
        );
    }, /beta DB database_name must be princess-beta/);
    assert.throws(() => {
        parseD1DatabaseId(
            createWranglerConfig(productionDatabaseId, {
                betaDatabaseId: productionDatabaseId
            }),
            'beta'
        );
    }, /beta DB binding must not share the production database/);
});

test('production D1 target rejects a mismatched environment database ID', context => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-production-target-test-')
    );
    const configPath = path.join(directory, 'wrangler.jsonc');

    fs.writeFileSync(
        configPath,
        createWranglerConfig(productionDatabaseId),
        'utf8'
    );
    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    assert.throws(() => {
        resolveProductionD1DatabaseId(configPath);
    }, /CLOUDFLARE_DATABASE_ID confirmation is required/);
    assert.throws(() => {
        resolveBetaD1DatabaseId(configPath, productionDatabaseId);
    }, /CLOUDFLARE_BETA_DATABASE_ID does not match the beta DB binding/);
    assert.equal(
        resolveBetaD1DatabaseId(configPath, betaDatabaseId),
        betaDatabaseId
    );
    assert.equal(
        resolveProductionD1DatabaseId(configPath, productionDatabaseId),
        productionDatabaseId
    );
    assert.throws(() => {
        resolveProductionD1DatabaseId(configPath, otherDatabaseId);
    }, /does not match the production DB binding/);
});

test('Drizzle child environment passes the target-specific database ID variable', () => {
    const source = {
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_D1_TOKEN: 'd1-token'
    };

    assert.deepEqual(
        createDrizzleChildEnvironment(source, betaDatabaseId, 'beta'),
        {
            CLOUDFLARE_ACCOUNT_ID: source.CLOUDFLARE_ACCOUNT_ID,
            CLOUDFLARE_BETA_DATABASE_ID: betaDatabaseId,
            CLOUDFLARE_D1_TOKEN: source.CLOUDFLARE_D1_TOKEN
        }
    );
});

test('D1 subprocess environments exclude unrelated GitHub and bot secrets', () => {
    const source = {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/operator',
        SystemRoot: 'C:\\Windows',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_DATABASE_ID: productionDatabaseId,
        CLOUDFLARE_D1_TOKEN: 'd1-token',
        CLOUDFLARE_API_TOKEN: 'wrangler-token',
        GH_TOKEN: 'github-token',
        GITHUB_TOKEN: 'github-actions-token',
        BOT_TOKEN: 'telegram-bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
        TELEGRAM_WEBHOOK_PATH: '/telegram/secret-path',
        MONGO_BACKUP_REF: 'backup-ref',
        UNRELATED_SECRET: 'unrelated-secret'
    };
    const drizzleEnvironment = createDrizzleChildEnvironment(
        source,
        productionDatabaseId
    );
    const wranglerEnvironment = createWranglerChildEnvironment(
        source,
        'production'
    );
    const localWranglerEnvironment = createWranglerChildEnvironment(
        source,
        'local'
    );

    for (const environment of [
        drizzleEnvironment,
        wranglerEnvironment,
        localWranglerEnvironment
    ]) {
        assert.equal(environment.GH_TOKEN, undefined);
        assert.equal(environment.GITHUB_TOKEN, undefined);
        assert.equal(environment.BOT_TOKEN, undefined);
        assert.equal(environment.TELEGRAM_WEBHOOK_SECRET, undefined);
        assert.equal(environment.TELEGRAM_WEBHOOK_PATH, undefined);
        assert.equal(environment.UNRELATED_SECRET, undefined);
    }

    assert.deepEqual(drizzleEnvironment, {
        PATH: source.PATH,
        HOME: source.HOME,
        SystemRoot: source.SystemRoot,
        CLOUDFLARE_ACCOUNT_ID: source.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_DATABASE_ID: productionDatabaseId,
        CLOUDFLARE_D1_TOKEN: source.CLOUDFLARE_D1_TOKEN
    });
    assert.deepEqual(wranglerEnvironment, {
        PATH: source.PATH,
        HOME: source.HOME,
        SystemRoot: source.SystemRoot,
        CLOUDFLARE_ACCOUNT_ID: source.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: source.CLOUDFLARE_API_TOKEN
    });
    assert.deepEqual(localWranglerEnvironment, {
        PATH: source.PATH,
        HOME: source.HOME,
        SystemRoot: source.SystemRoot
    });
});

test('D1 tooling loads only the dedicated D1 file and Drizzle reloads no dotenv', () => {
    const childEnvironmentSource = fs.readFileSync(
        path.resolve(process.cwd(), 'scripts/db/d1-child-environment.ts'),
        'utf8'
    );
    const migrationSource = fs.readFileSync(
        path.resolve(process.cwd(), 'scripts/db/migrate-production.ts'),
        'utf8'
    );
    const drizzleConfigSource = fs.readFileSync(
        path.resolve(process.cwd(), 'drizzle.production.config.ts'),
        'utf8'
    );

    assert.match(childEnvironmentSource, /env\/\.env\.d1/);
    assert.doesNotMatch(childEnvironmentSource, /\.dev\.vars\.production/);
    assert.doesNotMatch(migrationSource, /\.dev\.vars\.production/);
    assert.doesNotMatch(drizzleConfigSource, /dotenv|\.dev\.vars/);
});

test('production import repository is fixed while local overrides remain available', () => {
    assert.equal(
        resolveMongoBackupRepository('production', undefined),
        'serhii-chernenko/princess-db'
    );
    assert.throws(() => {
        resolveMongoBackupRepository('production', 'attacker/backup');
    }, /does not accept MONGO_BACKUP_REPOSITORY/);
    assert.throws(() => {
        resolveMongoBackupRepository(
            'production',
            'serhii-chernenko/princess-db'
        );
    }, /does not accept MONGO_BACKUP_REPOSITORY/);
    assert.equal(
        resolveMongoBackupRepository('local', 'developer/fixture-backup'),
        'developer/fixture-backup'
    );
});

test('production importer rejects a wrong repository before fetching', async context => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-production-repository-test-')
    );
    let fetchCalled = false;

    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    await assert.rejects(
        prepareMongoImport({
            source: {
                kind: 'github',
                repository: 'attacker/backup',
                ref: '4b9ebd56e45a52547258886866cfb943da03f620',
                requireCommitSha: true
            },
            outputDirectory: directory,
            githubToken: 'test-token',
            fetchImplementation: async () => {
                fetchCalled = true;
                throw new Error('fetch must not run');
            }
        }),
        /Production Mongo import source must be serhii-chernenko\/princess-db/
    );
    assert.equal(fetchCalled, false);
});

test('production migration and D1 commands target explicit reviewed configs', () => {
    const migrationConfigPath = path.resolve(
        '/tmp/princess/drizzle.production.config.ts'
    );
    const wranglerConfigPath = path.resolve('/tmp/princess/wrangler.jsonc');

    assert.deepEqual(getProductionMigrationArguments(migrationConfigPath), [
        'exec',
        'drizzle-kit',
        'migrate',
        '--config',
        migrationConfigPath
    ]);
    assert.deepEqual(
        getD1ExecuteArguments('production', wranglerConfigPath, {
            file: '/tmp/import.sql'
        }),
        [
            'exec',
            'wrangler',
            'd1',
            'execute',
            'DB',
            '--config',
            wranglerConfigPath,
            '--env',
            'production',
            '--remote',
            '--file',
            '/tmp/import.sql',
            '--yes'
        ]
    );
});

test('beta D1 execute and migration commands are explicit and remote', () => {
    const wranglerConfigPath = path.resolve('/tmp/princess/wrangler.jsonc');
    const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    assert.deepEqual(
        getD1ExecuteArguments('beta', wranglerConfigPath, {
            file: '/tmp/import.sql'
        }).slice(5),
        [
            '--config',
            wranglerConfigPath,
            '--env',
            'beta',
            '--remote',
            '--file',
            '/tmp/import.sql',
            '--yes'
        ]
    );
    assert.equal(
        packageJson.scripts['db:migrate:beta'],
        'tsx scripts/db/migrate-beta.ts'
    );
});

test('package production migration uses the fail-closed target wrapper', () => {
    const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const drizzleConfigSource = fs.readFileSync(
        path.resolve(process.cwd(), 'drizzle.production.config.ts'),
        'utf8'
    );

    assert.equal(
        packageJson.scripts['db:migrate:prod'],
        'tsx scripts/db/migrate-production.ts'
    );
    assert.match(drizzleConfigSource, /resolveProductionD1DatabaseId/);
    assert.doesNotMatch(
        packageJson.scripts['db:migrate:prod'] ?? '',
        /\$CLOUDFLARE_DATABASE_ID|CLOUDFLARE_DATABASE_ID=/
    );
});
