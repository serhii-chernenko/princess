import assert from 'node:assert/strict';
import test from 'node:test';

import {
    emitTelemetryEvent,
    getTelegramCommandCategory,
    normalizeTelemetryPath,
    toPrincessAttributes
} from '../src/worker/telemetry';
import type { WorkerBindings } from '../src/worker/env';

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
    assert.equal(
        getTelegramCommandCategory({ message: { text: '/list' } }),
        'list'
    );
    assert.equal(
        getTelegramCommandCategory({ message: { text: '/stop' } }),
        'stop'
    );
    assert.equal(
        getTelegramCommandCategory({ message: { text: '/forget' } }),
        'forget'
    );
    assert.equal(
        getTelegramCommandCategory({ message: { text: '/restore' } }),
        'restore'
    );
});

test('Princess telemetry exposes safe dimensions as queryable log attributes', () => {
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
        eventName: 'telegram_webhook_completed',
        outcome: 'accepted',
        commandCategory: 'run',
        idempotencyOutcome: 'processed',
        botEnvironment: 'production'
    });
    assert.equal(JSON.stringify(event).includes('secret-webhook-path'), false);
    assert.equal(JSON.stringify(event).includes('message text'), false);
});

test('only production ships queryable evlog attributes to New Relic EU', async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; headers: Headers; body: string }[] = [];
    const background: Promise<unknown>[] = [];

    globalThis.fetch = async (input, init) => {
        requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: String(init?.body)
        });
        return new Response('{}', { status: 200 });
    };

    try {
        const context = {
            waitUntil(promise: Promise<unknown>) {
                background.push(promise);
            }
        };
        const baseEnv = {
            NEW_RELIC_LICENSE_KEY: 'test-license-key'
        } as WorkerBindings;

        emitTelemetryEvent(
            { ...baseEnv, BOT_ENVIRONMENT: 'preview' },
            context,
            { event: 'http_request_completed', status: 200 }
        );
        assert.equal(background.length, 0);

        emitTelemetryEvent(
            { ...baseEnv, BOT_ENVIRONMENT: 'production' },
            context,
            {
                event: 'telegram_webhook_completed',
                outcome: 'accepted',
                commandCategory: 'run',
                status: 200
            }
        );
        assert.equal(background.length, 1);
        await Promise.all(background);
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://otlp.eu01.nr-data.net/v1/logs');
    assert.equal(requests[0]?.headers.get('api-key'), 'test-license-key');
    assert.equal(requests[0]?.headers.get('content-type'), 'application/json');

    const payload = JSON.parse(requests[0]?.body ?? '') as {
        resourceLogs: {
            resource: {
                attributes: { key: string; value: { stringValue?: string } }[];
            };
            scopeLogs: {
                logRecords: {
                    attributes: {
                        key: string;
                        value: { stringValue?: string };
                    }[];
                }[];
            }[];
        }[];
    };
    const resourceAttributes = payload.resourceLogs[0]?.resource.attributes;
    const logAttributes =
        payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes;

    assert.equal(
        resourceAttributes?.find(attribute => attribute.key === 'service.name')
            ?.value.stringValue,
        'princess'
    );
    assert.equal(
        logAttributes?.find(attribute => attribute.key === 'eventName')?.value
            .stringValue,
        'telegram_webhook_completed'
    );
    assert.equal(
        logAttributes?.find(attribute => attribute.key === 'commandCategory')
            ?.value.stringValue,
        'run'
    );
});
