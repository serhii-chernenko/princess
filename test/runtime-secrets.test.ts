import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'dotenv';

import {
    formatStableRuntimeSecrets,
    writeStableRuntimeSecrets
} from '../scripts/cloudflare/write-runtime-secrets';

const runtimeEnvironment = {
    BOT_TOKEN: '123456:test-token',
    TELEGRAM_WEBHOOK_PATH: '/telegram/princess-stable',
    TELEGRAM_WEBHOOK_SECRET: 'stable_secret-token'
};

const validEnvironment = {
    CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
    ...runtimeEnvironment
};

test('runtime secret generator writes a private dotenv file without changing values', context => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'princess-runtime-secrets-test-')
    );
    const outputPath = path.join(directory, '.dev.vars.production');

    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    writeStableRuntimeSecrets(outputPath, validEnvironment);

    assert.deepEqual(parse(fs.readFileSync(outputPath)), runtimeEnvironment);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
});

test('runtime secret generator rejects missing, blank, and multiline values', () => {
    for (const [key, value] of [
        ['CLOUDFLARE_API_TOKEN', ''],
        ['CLOUDFLARE_ACCOUNT_ID', 'account\nnext'],
        ['BOT_TOKEN', ''],
        ['BOT_TOKEN', '   '],
        ['TELEGRAM_WEBHOOK_SECRET', 'first\nsecond'],
        ['TELEGRAM_WEBHOOK_PATH', '/telegram\rnext']
    ] as const) {
        assert.throws(
            () => {
                formatStableRuntimeSecrets({
                    ...validEnvironment,
                    [key]: value
                });
            },
            { message: new RegExp(`^${key} must `) }
        );
    }

    assert.throws(
        () => {
            formatStableRuntimeSecrets({
                CLOUDFLARE_API_TOKEN: validEnvironment.CLOUDFLARE_API_TOKEN,
                CLOUDFLARE_ACCOUNT_ID: validEnvironment.CLOUDFLARE_ACCOUNT_ID,
                BOT_TOKEN: validEnvironment.BOT_TOKEN,
                TELEGRAM_WEBHOOK_PATH: validEnvironment.TELEGRAM_WEBHOOK_PATH
            });
        },
        { message: /^TELEGRAM_WEBHOOK_SECRET must be a non-empty value$/ }
    );
});

test('runtime secret generator safely quotes dotenv metacharacters', () => {
    const environment = {
        ...validEnvironment,
        TELEGRAM_WEBHOOK_SECRET: 'secret#with spaces'
    };
    const content = formatStableRuntimeSecrets(environment);

    assert.deepEqual(parse(content), {
        ...runtimeEnvironment,
        TELEGRAM_WEBHOOK_SECRET: environment.TELEGRAM_WEBHOOK_SECRET
    });
});
