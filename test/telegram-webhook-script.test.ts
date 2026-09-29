import assert from 'node:assert/strict';
import test from 'node:test';

import {
    callTelegramApi,
    formatTelegramWebhookInfo,
    TELEGRAM_API_MAX_RESPONSE_BYTES
} from '../scripts/telegram/webhook';

const asFetch = (
    implementation: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>
) => {
    return implementation as typeof fetch;
};

const successfulResponse = () => {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json'
        }
    });
};

test('Telegram helper rejects redirects and attaches a timeout signal', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImplementation = asFetch(async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return successfulResponse();
    });

    await callTelegramApi('getWebhookInfo', undefined, {
        botToken: '123456:test-token',
        fetchImplementation
    });

    assert.equal(
        requestUrl,
        'https://api.telegram.org/bot123456:test-token/getWebhookInfo'
    );
    assert.equal(requestInit?.method, 'GET');
    assert.equal(requestInit?.redirect, 'error');
    assert.equal(requestInit?.signal instanceof AbortSignal, true);
});

test('Telegram helper returns a validated getWebhookInfo result', async () => {
    const secretPath = '/telegram/princess-stable';
    const expectedWebhookUrl = `https://worker.example${secretPath}`;
    const botToken = '123456:test-token';
    const webhookInfo = {
        url: expectedWebhookUrl,
        has_custom_certificate: false,
        pending_update_count: 3,
        last_error_date: 1_784_098_000,
        last_error_message: `delivery failed for ${secretPath}`,
        last_synchronization_error_date: 1_784_098_001,
        max_connections: 1,
        allowed_updates: ['message'],
        ip_address: botToken,
        unexpected: {
            token: botToken,
            path: secretPath
        }
    };
    const fetchImplementation = asFetch(async () => {
        return new Response(
            JSON.stringify({
                ok: true,
                result: webhookInfo
            })
        );
    });

    const payload = await callTelegramApi('getWebhookInfo', undefined, {
        botToken,
        fetchImplementation
    });

    assert.deepEqual(payload.result, webhookInfo);
    const formattedWebhookInfo = formatTelegramWebhookInfo(
        payload,
        expectedWebhookUrl
    );

    assert.deepEqual(JSON.parse(formattedWebhookInfo), {
        event: 'telegram_webhook_info',
        urlConfigured: true,
        urlMatchesExpected: true,
        hasCustomCertificate: false,
        pendingUpdateCount: 3,
        lastErrorDate: 1_784_098_000,
        lastErrorMessagePresent: true,
        lastSynchronizationErrorDate: 1_784_098_001,
        maxConnections: 1,
        allowedUpdates: ['message']
    });
    assert.equal(formattedWebhookInfo.includes(secretPath), false);
    assert.equal(formattedWebhookInfo.includes(botToken), false);
    assert.equal(formattedWebhookInfo.includes('delivery failed'), false);
});

test('Telegram webhook info projection rejects malformed and arbitrary fields', () => {
    const secretPath = '/telegram/private-hook';
    const botToken = '987654:private-token';
    const formattedWebhookInfo = formatTelegramWebhookInfo(
        {
            ok: true,
            result: {
                url: `https://attacker.example${secretPath}`,
                has_custom_certificate: botToken,
                pending_update_count: secretPath,
                last_error_date: -1,
                last_error_message: botToken,
                last_synchronization_error_date: 1.5,
                max_connections: Number.MAX_SAFE_INTEGER + 1,
                allowed_updates: ['message', secretPath],
                nested: { botToken, secretPath }
            }
        },
        `https://worker.example${secretPath}`
    );

    assert.deepEqual(JSON.parse(formattedWebhookInfo), {
        event: 'telegram_webhook_info',
        urlConfigured: true,
        urlMatchesExpected: false,
        hasCustomCertificate: null,
        pendingUpdateCount: null,
        lastErrorDate: null,
        lastErrorMessagePresent: true,
        lastSynchronizationErrorDate: null,
        maxConnections: null,
        allowedUpdates: null
    });
    assert.equal(formattedWebhookInfo.includes(secretPath), false);
    assert.equal(formattedWebhookInfo.includes(botToken), false);
});

test('Telegram helper posts URL-encoded webhook parameters', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImplementation = asFetch(async (_input, init) => {
        requestInit = init;
        return successfulResponse();
    });
    const body = new URLSearchParams({ url: 'https://worker.example/hook' });

    await callTelegramApi('setWebhook', body, {
        botToken: '123456:test-token',
        fetchImplementation
    });

    assert.equal(requestInit?.method, 'POST');
    assert.deepEqual(requestInit?.headers, {
        'Content-Type': 'application/x-www-form-urlencoded'
    });
    assert.equal(requestInit?.body, body);
});

test('Telegram helper rejects an oversized declared response', async () => {
    const fetchImplementation = asFetch(async () => {
        return new Response('{"ok":true}', {
            headers: {
                'Content-Length': String(TELEGRAM_API_MAX_RESPONSE_BYTES + 1)
            }
        });
    });

    await assert.rejects(
        callTelegramApi('getWebhookInfo', undefined, {
            botToken: '123456:test-token',
            fetchImplementation
        }),
        /response exceeded the size limit/
    );
});

test('Telegram helper caps streamed responses without Content-Length', async () => {
    const fetchImplementation = asFetch(async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new Uint8Array(TELEGRAM_API_MAX_RESPONSE_BYTES)
                );
                controller.enqueue(new Uint8Array(1));
                controller.close();
            }
        });

        return new Response(body);
    });

    await assert.rejects(
        callTelegramApi('getWebhookInfo', undefined, {
            botToken: '123456:test-token',
            fetchImplementation
        }),
        /response exceeded the size limit/
    );
});

test('Telegram helper rejects malformed JSON responses', async () => {
    const fetchImplementation = asFetch(async () => {
        return new Response('{not-json');
    });

    await assert.rejects(
        callTelegramApi('getWebhookInfo', undefined, {
            botToken: '123456:test-token',
            fetchImplementation
        }),
        /returned invalid JSON/
    );
});

test('Telegram helper validates the Telegram response envelope', async () => {
    const fetchImplementation = asFetch(async () => {
        return new Response(JSON.stringify({ ok: 'yes' }));
    });

    await assert.rejects(
        callTelegramApi('getWebhookInfo', undefined, {
            botToken: '123456:test-token',
            fetchImplementation
        }),
        /returned an invalid response/
    );
});

test('Telegram helper aborts requests that exceed its timeout', async () => {
    const fetchImplementation = asFetch(async (_input, init) => {
        await new Promise<void>((_resolve, reject) => {
            assert.ok(init?.signal);
            init.signal.addEventListener(
                'abort',
                () => {
                    reject(new Error('aborted'));
                },
                { once: true }
            );
        });

        return successfulResponse();
    });

    await assert.rejects(
        callTelegramApi('getWebhookInfo', undefined, {
            botToken: '123456:test-token',
            fetchImplementation,
            timeoutMilliseconds: 5
        }),
        /timed out after 5ms/
    );
});
