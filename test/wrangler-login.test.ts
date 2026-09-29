import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createWranglerChildEnvironment,
    resolveCloudflareAuthMode
} from '../scripts/db/d1-child-environment';
import { parseD1Target } from '../scripts/db/production-d1-target';
import {
    parseImportInputDirectory,
    resolveMongoImportSource
} from '../scripts/db/run-mongo-import';
import { parseD1Rows } from '../scripts/db/wrangler-login-migration';

const accountId = 'a'.repeat(32);
const baseSource = {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    XDG_CONFIG_HOME: '/home/operator/.config',
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: 'api-token'
};
const projectRoot = path.resolve(process.cwd());

test('committed wrangler.jsonc resolves distinct real production and preview databases', () => {
    const configSource = fs.readFileSync(
        path.join(projectRoot, 'wrangler.jsonc'),
        'utf8'
    );
    const production = parseD1Target(configSource, 'production');
    const preview = parseD1Target(configSource, 'preview');

    assert.equal(production.databaseId, '19c5b5dd-ac9e-43ff-9a0a-40c77c39d1d1');
    assert.equal(preview.databaseId, 'b9a13fb8-8745-4d33-a5a2-f067b7b35220');
    assert.notEqual(production.databaseId, preview.databaseId);
    assert.doesNotMatch(configSource, /REPLACE_WITH_/);
});

test('auth mode defaults to token and keeps the API token requirement', () => {
    assert.equal(resolveCloudflareAuthMode(baseSource), 'token');
    assert.equal(
        resolveCloudflareAuthMode({
            ...baseSource,
            CLOUDFLARE_AUTH_MODE: 'token'
        }),
        'token'
    );
    assert.equal(
        createWranglerChildEnvironment(baseSource, 'preview')
            .CLOUDFLARE_API_TOKEN,
        'api-token'
    );
    assert.throws(() => {
        createWranglerChildEnvironment(
            { ...baseSource, CLOUDFLARE_API_TOKEN: undefined },
            'preview'
        );
    }, /CLOUDFLARE_API_TOKEN is required and invalid/);
});

test('wrangler-login mode drops the API token but keeps OAuth config lookup variables', () => {
    const environment = createWranglerChildEnvironment(
        { ...baseSource, CLOUDFLARE_AUTH_MODE: 'wrangler-login' },
        'preview'
    );

    assert.deepEqual(environment, {
        PATH: baseSource.PATH,
        HOME: baseSource.HOME,
        XDG_CONFIG_HOME: baseSource.XDG_CONFIG_HOME,
        CLOUDFLARE_ACCOUNT_ID: accountId
    });
    assert.throws(() => {
        createWranglerChildEnvironment(
            {
                ...baseSource,
                CLOUDFLARE_ACCOUNT_ID: undefined,
                CLOUDFLARE_AUTH_MODE: 'wrangler-login'
            },
            'preview'
        );
    }, /CLOUDFLARE_ACCOUNT_ID is required and invalid/);
});

test('wrangler-login mode is rejected in CI and for unknown values', () => {
    for (const ciVariable of ['CI', 'GITHUB_ACTIONS']) {
        assert.throws(() => {
            resolveCloudflareAuthMode({
                ...baseSource,
                CLOUDFLARE_AUTH_MODE: 'wrangler-login',
                [ciVariable]: 'true'
            });
        }, /rejected in CI/);
    }

    assert.throws(() => {
        resolveCloudflareAuthMode({
            ...baseSource,
            CLOUDFLARE_AUTH_MODE: 'oauth'
        });
    }, /CLOUDFLARE_AUTH_MODE must be/);
});

test('D1 result parser accepts one successful envelope only', () => {
    assert.deepEqual(
        parseD1Rows(JSON.stringify([{ success: true, results: [{ a: 1 }] }])),
        [{ a: 1 }]
    );
    assert.throws(() => {
        parseD1Rows(JSON.stringify([{ success: false, results: [] }]));
    }, /did not return a successful D1 result/);
    assert.throws(() => {
        parseD1Rows('[]');
    }, /unexpected D1 result envelope/);
});

test('import input directory argument accepts only --input-dir with a value', () => {
    assert.equal(parseImportInputDirectory([]), undefined);
    assert.equal(parseImportInputDirectory(['--']), undefined);
    assert.equal(
        parseImportInputDirectory(['--input-dir', '/backups/princess-db']),
        '/backups/princess-db'
    );
    assert.throws(() => {
        parseImportInputDirectory(['--input-dir']);
    }, /Usage/);
    assert.throws(() => {
        parseImportInputDirectory(['--input-dir', '/a', 'extra']);
    }, /Usage/);
    assert.throws(() => {
        parseImportInputDirectory(['--unknown', '/a']);
    }, /Usage/);
});

test('preview import source resolves a local backup directory', context => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-preview-source-test-')
    );

    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    assert.deepEqual(
        resolveMongoImportSource('preview', {
            projectRoot,
            environment: { MONGO_BACKUP_DIR: directory }
        }),
        { kind: 'directory', directory }
    );
    assert.deepEqual(
        resolveMongoImportSource('preview', {
            projectRoot,
            environment: {},
            inputDirectory: directory
        }),
        { kind: 'directory', directory }
    );
});

test('preview import source defaults to princess-db under the project root', context => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-preview-default-test-')
    );

    context.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    assert.throws(() => {
        resolveMongoImportSource('preview', {
            projectRoot: root,
            environment: {}
        });
    }, /backup directory does not exist/);

    fs.mkdirSync(path.join(root, 'princess-db'));

    assert.deepEqual(
        resolveMongoImportSource('preview', {
            projectRoot: root,
            environment: {}
        }),
        { kind: 'directory', directory: path.join(root, 'princess-db') }
    );
});

test('preview import rejects a missing directory and ambiguous sources', () => {
    assert.throws(() => {
        resolveMongoImportSource('preview', {
            projectRoot,
            environment: { MONGO_BACKUP_DIR: '/nonexistent/princess-db' }
        });
    }, /backup directory does not exist/);
    assert.throws(() => {
        resolveMongoImportSource('preview', {
            projectRoot,
            environment: {
                MONGO_BACKUP_DIR: projectRoot,
                MONGO_BACKUP_REF: 'main'
            }
        });
    }, /either MONGO_BACKUP_DIR\/--input-dir or MONGO_BACKUP_REF/);
});

test('production import stays pinned to an immutable GitHub SHA and never uses a directory', () => {
    assert.deepEqual(
        resolveMongoImportSource('production', {
            projectRoot,
            environment: {
                MONGO_BACKUP_REF: '4b9ebd56e45a52547258886866cfb943da03f620',
                MONGO_BACKUP_DIR: projectRoot
            }
        }),
        {
            kind: 'github',
            repository: 'serhii-chernenko/princess-db',
            ref: '4b9ebd56e45a52547258886866cfb943da03f620',
            requireCommitSha: true
        }
    );
    assert.throws(() => {
        resolveMongoImportSource('production', {
            projectRoot,
            environment: {}
        });
    }, /MONGO_BACKUP_REF must identify/);
    assert.throws(() => {
        resolveMongoImportSource('production', {
            projectRoot,
            environment: { MONGO_BACKUP_REF: 'main' },
            inputDirectory: projectRoot
        });
    }, /--input-dir is only supported for the preview import target/);
    assert.throws(() => {
        resolveMongoImportSource('production', {
            projectRoot,
            environment: {
                MONGO_BACKUP_REF: 'main',
                MONGO_BACKUP_REPOSITORY: 'attacker/backup'
            }
        });
    }, /does not accept MONGO_BACKUP_REPOSITORY/);
});
