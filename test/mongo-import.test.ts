import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertApplicationTablesEmpty,
    getD1ExecuteArguments,
    parseApplicationTableCounts
} from '../scripts/db/d1-import-target';
import {
    createGithubCliTokenEnvironment,
    getGithubCliTokenArguments,
    prepareMongoImport
} from '../scripts/db/mongo-import';

const ids = {
    channel: '000000000000000000000001',
    player: '000000000000000000000002',
    score: '000000000000000000000003',
    status: '000000000000000000000004'
};

const createFixtureRecords = () => {
    return {
        channels: [
            {
                _id: { $oid: ids.channel },
                entity_id: -1001,
                updated_at: { $date: '2026-07-15T12:00:00.000Z' },
                release: '4.0.1',
                players: [
                    {
                        player_id: { $oid: ids.player },
                        score_id: { $oid: ids.score },
                        status_id: { $oid: ids.status }
                    }
                ]
            }
        ],
        players: [
            {
                _id: { $oid: ids.player },
                entity_id: 42,
                name: "O'Brien"
            }
        ],
        scores: [
            {
                _id: { $oid: ids.score },
                channel_id: { $oid: ids.channel },
                player_id: { $oid: ids.player },
                score: 7
            }
        ],
        statuses: [
            {
                _id: { $oid: ids.status },
                channel_id: { $oid: ids.channel },
                player_id: { $oid: ids.player },
                status: true,
                auto: false
            }
        ]
    };
};

const hashGitBlob = (bytes: Uint8Array) => {
    return createHash('sha1')
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex');
};

type FixtureRecords = ReturnType<typeof createFixtureRecords>;

interface TestCleanupContext {
    after(callback: () => void): void;
}

const createFixtureDirectory = (
    context: TestCleanupContext,
    mutate?: (records: FixtureRecords) => void
) => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-mongo-import-test-')
    );
    const records = createFixtureRecords();

    mutate?.(records);
    fs.writeFileSync(
        path.join(directory, 'channels.json'),
        JSON.stringify(records.channels),
        'utf8'
    );
    fs.writeFileSync(
        path.join(directory, 'players.json'),
        `${records.players.map(record => JSON.stringify(record)).join('\n')}\n`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(directory, 'scores.json'),
        JSON.stringify(records.scores),
        'utf8'
    );
    fs.writeFileSync(
        path.join(directory, 'status.json'),
        `${records.statuses
            .map(record => {
                return JSON.stringify(record);
            })
            .join('\n')}\n`,
        'utf8'
    );
    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return directory;
};

test('Mongo import validates mixed JSON-array/NDJSON fixtures and reports hashes', async context => {
    const directory = createFixtureDirectory(context);
    const outputDirectory = path.join(directory, 'output');
    const report = await prepareMongoImport({
        source: { kind: 'directory', directory },
        outputDirectory,
        importTimestamp: 1_752_580_800_000
    });
    const sql = fs.readFileSync(report.outputSqlPath, 'utf8');

    assert.deepEqual(report.sourceCounts, {
        channels: 1,
        players: 1,
        scores: 1,
        statuses: 1
    });
    assert.deepEqual(report.transformedCounts, {
        channels: 1,
        players: 1,
        channelMembers: 1
    });
    assert.equal(report.validation.validated, true);
    assert.equal(report.source.files.channels.format, 'json-array');
    assert.equal(report.source.files.players.format, 'ndjson');
    assert.match(report.source.files.scores.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.source.files.statuses.blobSha, null);
    assert.match(sql, /O''Brien/);
    assert.doesNotMatch(sql, /ON CONFLICT/i);
    assert.doesNotMatch(sql, /^\s*BEGIN(?: TRANSACTION)?;/im);
    assert.doesNotMatch(sql, /^\s*COMMIT;/im);
    assert.equal(fs.statSync(report.outputSqlPath).mode & 0o777, 0o600);
});

test('Mongo import rejects malformed scalar fields without producing SQL', async context => {
    const directory = createFixtureDirectory(context, records => {
        records.scores[0]!.score = 1.5;
    });
    const outputDirectory = path.join(directory, 'output');

    await assert.rejects(
        prepareMongoImport({
            source: { kind: 'directory', directory },
            outputDirectory
        }),
        /scores\[0\]\.score: expected a safe integer/
    );
    assert.equal(
        fs.existsSync(path.join(outputDirectory, 'mongo-to-d1.sql')),
        false
    );
});

test('Mongo import rejects invalid dates and score ownership mismatches', async context => {
    const invalidDateDirectory = createFixtureDirectory(context, records => {
        records.channels[0]!.updated_at.$date = 'not-a-date';
    });
    const mismatchDirectory = createFixtureDirectory(context, records => {
        records.scores[0]!.player_id.$oid = '000000000000000000000099';
    });

    await assert.rejects(
        prepareMongoImport({
            source: { kind: 'directory', directory: invalidDateDirectory },
            outputDirectory: path.join(invalidDateDirectory, 'output')
        }),
        /expected a valid millisecond date/
    );
    await assert.rejects(
        prepareMongoImport({
            source: { kind: 'directory', directory: mismatchDirectory },
            outputDirectory: path.join(mismatchDirectory, 'output')
        }),
        /score .* belongs to channel\/player/
    );
});

test('GitHub source resolves once and reads metadata/raw content at the resolved SHA', async context => {
    const directory = createFixtureDirectory(context);
    const resolvedSha = '4b9ebd56e45a52547258886866cfb943da03f620';
    const fileByName = new Map([
        [
            'channels.json',
            Uint8Array.from(
                fs.readFileSync(path.join(directory, 'channels.json'))
            )
        ],
        [
            'players.json',
            Uint8Array.from(
                fs.readFileSync(path.join(directory, 'players.json'))
            )
        ],
        [
            'scores.json',
            Uint8Array.from(
                fs.readFileSync(path.join(directory, 'scores.json'))
            )
        ],
        [
            'status.json',
            Uint8Array.from(
                fs.readFileSync(path.join(directory, 'status.json'))
            )
        ]
    ]);
    const requests: string[] = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
        const url = String(input);
        const accept = new Headers(init?.headers).get('Accept');

        requests.push(`${accept} ${url}`);
        assert.equal(init?.redirect, 'error');
        assert.equal(
            new Headers(init?.headers).get('X-GitHub-Api-Version'),
            '2026-03-10'
        );

        if (url.includes('/commits/')) {
            return Response.json({ sha: resolvedSha });
        }

        const name = Array.from(fileByName.keys()).find(fileName => {
            return url.includes(`/contents/${fileName}?`);
        });

        assert.ok(name);
        assert.match(url, new RegExp(`ref=${resolvedSha}$`));
        const bytes = fileByName.get(name);

        assert.ok(bytes);

        if (accept === 'application/vnd.github+json') {
            return Response.json({
                name,
                type: 'file',
                size: bytes.byteLength,
                sha: hashGitBlob(bytes)
            });
        }

        return new Response(bytes);
    };
    const report = await prepareMongoImport({
        source: {
            kind: 'github',
            repository: 'serhii-chernenko/princess-db',
            ref: 'main'
        },
        outputDirectory: path.join(directory, 'github-output'),
        githubToken: 'test-token',
        fetchImplementation
    });

    assert.equal(requests.length, 9);
    assert.equal(report.source.kind, 'github');
    assert.equal(report.source.resolvedCommitSha, resolvedSha);
    assert.equal(
        report.source.files.channels.blobSha,
        hashGitBlob(fileByName.get('channels.json')!)
    );

    for (let index = 1; index < requests.length; index += 2) {
        assert.match(requests[index] ?? '', /application\/vnd\.github\+json/);
        assert.match(
            requests[index + 1] ?? '',
            /application\/vnd\.github\.raw\+json/
        );
    }
});

test('production import controls require a pinned SHA and explicit remote target', async context => {
    const directory = createFixtureDirectory(context);

    await assert.rejects(
        prepareMongoImport({
            source: {
                kind: 'github',
                ref: 'main',
                requireCommitSha: true
            },
            outputDirectory: path.join(directory, 'production-gate-output'),
            githubToken: 'test-token',
            fetchImplementation: async () => {
                throw new Error('fetch must not run');
            }
        }),
        /requires an immutable 40-character Git commit SHA/
    );

    const productionArguments = getD1ExecuteArguments(
        'production',
        '/tmp/wrangler.jsonc',
        { file: '/tmp/import.sql' }
    );
    const localArguments = getD1ExecuteArguments(
        'local',
        '/tmp/wrangler.jsonc',
        { command: 'SELECT 1' }
    );

    assert.deepEqual(productionArguments.slice(5, 10), [
        '--config',
        '/tmp/wrangler.jsonc',
        '--env',
        'production',
        '--remote'
    ]);
    assert.ok(productionArguments.includes('--file'));
    assert.ok(localArguments.includes('--local'));
    assert.equal(localArguments.includes('--remote'), false);
});

test('empty-target preflight counts only application tables and fails closed', () => {
    const counts = parseApplicationTableCounts(
        JSON.stringify([
            {
                success: true,
                results: [
                    {
                        channels: 0,
                        players: 0,
                        channelMembers: 0,
                        telegramUpdates: 0
                    }
                ]
            }
        ])
    );

    assert.doesNotThrow(() => {
        assertApplicationTablesEmpty(counts);
    });
    assert.throws(() => {
        assertApplicationTablesEmpty({ ...counts, channelMembers: 1 });
    }, /D1 import target is not empty: channelMembers=1/);
});

test('GitHub CLI token fallback receives only CLI configuration environment', () => {
    const environment = createGithubCliTokenEnvironment({
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/operator',
        XDG_CONFIG_HOME: '/home/operator/.config',
        GH_CONFIG_DIR: '/secure/gh',
        GH_HOST: 'github.com',
        SystemRoot: 'C:\\Windows',
        GH_TOKEN: 'direct-token',
        GITHUB_TOKEN: 'actions-token',
        CLOUDFLARE_API_TOKEN: 'cloudflare-token',
        CLOUDFLARE_DATABASE_ID: 'database-id',
        BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
        TELEGRAM_WEBHOOK_PATH: '/telegram/private'
    });

    assert.deepEqual(environment, {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/operator',
        XDG_CONFIG_HOME: '/home/operator/.config',
        GH_CONFIG_DIR: '/secure/gh',
        GH_HOST: 'github.com',
        SystemRoot: 'C:\\Windows'
    });
    assert.deepEqual(getGithubCliTokenArguments(), [
        'auth',
        'token',
        '--hostname',
        'github.com'
    ]);
});

test('package import scripts use the one-shot local and production wrapper', () => {
    const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const runnerSource = fs.readFileSync(
        path.resolve(process.cwd(), 'scripts/db/run-mongo-import.ts'),
        'utf8'
    );

    assert.equal(
        packageJson.scripts['db:import:local'],
        'tsx scripts/db/run-mongo-import.ts local'
    );
    assert.equal(
        packageJson.scripts['db:import:prod'],
        'tsx scripts/db/run-mongo-import.ts production'
    );
    assert.match(runnerSource, /preflightImportTarget\(target\)/);
    assert.match(runnerSource, /executeImportSql\(target/);
    assert.match(runnerSource, /finally \{/);
    assert.match(runnerSource, /fs\.rmSync\(sqlPath, \{ force: true \}\)/);
});
