import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecret } from '../scripts/db/migrate-production';
import {
    assertPinnedCiConfiguration,
    isTransientD1Error,
    resolveCiMigrationTarget,
    runWithTransientRetry
} from '../scripts/db/migrate-ci';

const instantSleep = async () => {};

test('main builds migrate production', () => {
    assert.equal(
        resolveCiMigrationTarget({
            WORKERS_CI: '1',
            WORKERS_CI_BRANCH: 'main'
        }),
        'production'
    );
});

test('every other branch migrates preview only', () => {
    for (const branch of [
        'feat/d1-migrations-autoapply',
        'main-backup',
        'release/main',
        'Main'
    ]) {
        assert.equal(
            resolveCiMigrationTarget({
                WORKERS_CI: '1',
                WORKERS_CI_BRANCH: branch
            }),
            'preview',
            branch
        );
    }
});

test('a missing or blank branch is refused instead of defaulting to a target', () => {
    for (const branch of [undefined, '', '   ']) {
        assert.throws(() => {
            return resolveCiMigrationTarget({
                WORKERS_CI: '1',
                WORKERS_CI_BRANCH: branch
            });
        }, /WORKERS_CI_BRANCH is empty/);
    }
});

test('the CI migration refuses to run outside Workers Builds', () => {
    assert.throws(() => {
        return resolveCiMigrationTarget({ WORKERS_CI_BRANCH: 'main' });
    }, /only inside Cloudflare Workers Builds/);
    assert.throws(() => {
        return resolveCiMigrationTarget({
            CI: 'true',
            WORKERS_CI_BRANCH: 'main'
        });
    }, /only inside Cloudflare Workers Builds/);
});

test('only D1 error 7403 is transient', () => {
    assert.equal(
        isTransientD1Error(
            new Error(
                'production Drizzle migration exited with status 1: D1 error 7403'
            )
        ),
        true
    );
    assert.equal(
        isTransientD1Error(new Error('SQLITE_ERROR: no such table')),
        false
    );
    assert.equal(
        isTransientD1Error(new Error('exited with status 17403')),
        false
    );
    assert.equal(isTransientD1Error('7403'), false);
});

test('transient errors are retried and then succeed', async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await runWithTransientRetry(
        async () => {
            calls += 1;

            if (calls < 3) {
                throw new Error('D1 error 7403');
            }

            return 'migrated';
        },
        {
            delayMilliseconds: 10,
            sleep: async milliseconds => {
                delays.push(milliseconds);
            }
        }
    );

    assert.equal(result, 'migrated');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [10, 20]);
});

test('transient errors stop after the attempt cap', async () => {
    let calls = 0;

    await assert.rejects(
        runWithTransientRetry(
            async () => {
                calls += 1;
                throw new Error('D1 error 7403');
            },
            { maxAttempts: 3, sleep: instantSleep }
        ),
        /7403/
    );
    assert.equal(calls, 3);
});

test('other errors fail on the first attempt', async () => {
    let calls = 0;

    await assert.rejects(
        runWithTransientRetry(
            async () => {
                calls += 1;
                throw new Error('SQLITE_ERROR: duplicate column name');
            },
            { sleep: instantSleep }
        ),
        /duplicate column/
    );
    assert.equal(calls, 1);
});

test('prefixed branch values are refused instead of interpreted', () => {
    for (const branch of ['refs/heads/main', 'refs/pull/1/head']) {
        assert.throws(() => {
            return resolveCiMigrationTarget({
                WORKERS_CI: '1',
                WORKERS_CI_BRANCH: branch
            });
        }, /bare branch name/);
    }
});

test('CI requires both database ids pinned outside the repository', () => {
    const pinned = {
        CLOUDFLARE_DATABASE_ID: '19c5b5dd-ac9e-43ff-9a0a-40c77c39d1d1',
        CLOUDFLARE_PREVIEW_DATABASE_ID: 'b9a13fb8-8745-4d33-a5a2-f067b7b35220'
    };

    assert.doesNotThrow(() => {
        assertPinnedCiConfiguration(pinned);
        assertPinnedCiConfiguration({
            ...pinned,
            CLOUDFLARE_AUTH_MODE: 'token'
        });
    });
    assert.throws(() => {
        assertPinnedCiConfiguration({ ...pinned, CLOUDFLARE_DATABASE_ID: '' });
    }, /CLOUDFLARE_DATABASE_ID must be set/);
    assert.throws(() => {
        assertPinnedCiConfiguration({
            CLOUDFLARE_DATABASE_ID: pinned.CLOUDFLARE_DATABASE_ID
        });
    }, /CLOUDFLARE_PREVIEW_DATABASE_ID must be set/);
    assert.throws(() => {
        assertPinnedCiConfiguration({
            ...pinned,
            CLOUDFLARE_PREVIEW_DATABASE_ID: pinned.CLOUDFLARE_DATABASE_ID
        });
    }, /must differ/);
    assert.throws(() => {
        assertPinnedCiConfiguration({
            ...pinned,
            CLOUDFLARE_AUTH_MODE: 'wrangler-login'
        });
    }, /only CLOUDFLARE_AUTH_MODE=token/);
});

test('the D1 token is redacted from echoed migration output', () => {
    assert.equal(
        redactSecret('Bearer abc123 failed, abc123', 'abc123'),
        'Bearer [redacted] failed, [redacted]'
    );
    assert.equal(redactSecret('nothing', undefined), 'nothing');
});
