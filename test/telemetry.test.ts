import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getTelegramCommandCategory,
    normalizeTelemetryPath,
    toPrincessAttributes
} from '../src/worker/telemetry';

test('telemetry normalizes Telegram routes and classifies commands without retaining text', () => {
    const secretPath = '/telegram/secret-webhook-path';

    assert.equal(
        normalizeTelemetryPath(secretPath, secretPath),
        '/telegram/webhook'
    );
    assert.equal(
        normalizeTelemetryPath('/telegram/untrusted-route', secretPath),
        '/telegram/webhook'
    );
    assert.equal(
        normalizeTelemetryPath('/unknown-route', secretPath),
        '/unknown'
    );
    assert.equal(
        getTelegramCommandCategory({
            message: { text: '/run something confidential' }
        }),
        'run'
    );
    assert.equal(
        getTelegramCommandCategory({
            message: { text: '/unlisted confidential command' }
        }),
        'otherCommand'
    );
});

test('Princess telemetry stores application fields only in the declared Axiom map', () => {
    const event = toPrincessAttributes(
        {
            event: 'telegram_webhook_completed',
            outcome: 'accepted',
            commandCategory: 'run',
            idempotencyOutcome: 'processed'
        },
        'production'
    );

    assert.deepEqual(event, {
        attributes: {
            princess: {
                event: 'telegram_webhook_completed',
                outcome: 'accepted',
                commandCategory: 'run',
                idempotencyOutcome: 'processed',
                botEnvironment: 'production'
            }
        }
    });
    assert.equal(JSON.stringify(event).includes('secret-webhook-path'), false);
    assert.equal(JSON.stringify(event).includes('message text'), false);
});
