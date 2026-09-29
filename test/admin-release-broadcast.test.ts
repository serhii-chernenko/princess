import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseBroadcastTarget,
    resolveBroadcastCredentials,
    runReleaseBroadcast,
    triggerReleaseBroadcast
} from '../scripts/releases/trigger-broadcast';
import { createApp } from '../src/worker/app';
import type { WorkerBindings } from '../src/worker/env';

const SECRET = 'test-webhook-secret';
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

const createBindings = (
    enableBroadcast: 'true' | 'false' = 'true',
    botEnvironment: WorkerBindings['BOT_ENVIRONMENT'] = 'beta'
) => {
    const touched: string[] = [];
    const guard = (name: string) => {
        return new Proxy(
            {},
            {
                get: () => {
                    touched.push(name);
                    throw new Error(`${name} must not be touched`);
                }
            }
        );
    };
    const env = {
        DB: guard('DB'),
        RELEASE_QUEUE: guard('RELEASE_QUEUE'),
        BOT_ENVIRONMENT: botEnvironment,
        ENABLE_SCHEDULED_CLEANUP: 'false',
        ENABLE_RELEASE_BROADCAST: enableBroadcast,
        BOT_TOKEN: '123456:test-token',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_WEBHOOK_PATH: '/telegram/test'
    } as unknown as WorkerBindings;

    return { env, touched };
};

const secretsMatch = async (provided: string, expected: string) => {
    return provided === expected;
};

const summary = {
    releaseVersion: '5.0.0',
    candidates: 2,
    inserted: 2,
    enqueued: 2
};

const postAdmin = (
    app: ReturnType<typeof createApp>,
    env: WorkerBindings,
    headers: Record<string, string> = {}
) => {
    return app.request(
        '/admin/release-broadcast',
        { method: 'POST', headers },
        env
    );
};

test('admin broadcast rejects missing and wrong secrets without touching D1 or queue', async () => {
    const { env, touched } = createBindings();
    let broadcasts = 0;
    const app = createApp(
        { secretsMatch },
        {
            broadcastRelease: async () => {
                broadcasts += 1;
                return summary;
            }
        }
    );

    assert.equal((await postAdmin(app, env)).status, 401);
    assert.equal(
        (await postAdmin(app, env, { [SECRET_HEADER]: 'wrong' })).status,
        401
    );
    assert.equal(broadcasts, 0);
    assert.deepEqual(touched, []);
});

test('admin broadcast answers 503 when configuration is missing', async () => {
    const { env } = createBindings();
    const app = createApp({ secretsMatch });
    const response = await postAdmin(
        app,
        { ...env, TELEGRAM_WEBHOOK_SECRET: '' } as WorkerBindings,
        { [SECRET_HEADER]: SECRET }
    );

    assert.equal(response.status, 503);
});

test('admin broadcast answers 409 when the broadcast is disabled', async () => {
    const { env } = createBindings('false');
    let broadcasts = 0;
    const app = createApp(
        { secretsMatch },
        {
            broadcastRelease: async () => {
                broadcasts += 1;
                return summary;
            }
        }
    );
    const response = await postAdmin(app, env, { [SECRET_HEADER]: SECRET });
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 409);
    assert.match(body.error, /disabled/);
    assert.equal(broadcasts, 0);
});

test('admin broadcast answers 409 for the preview environment without touching bindings', async () => {
    const { env, touched } = createBindings('false', 'preview');
    let broadcasts = 0;
    const app = createApp(
        { secretsMatch },
        {
            broadcastRelease: async () => {
                broadcasts += 1;
                return summary;
            }
        }
    );
    const response = await postAdmin(app, env, { [SECRET_HEADER]: SECRET });

    assert.equal(response.status, 409);
    assert.equal(broadcasts, 0);
    assert.deepEqual(touched, []);
});

test('admin broadcast returns the summary from the injected broadcast', async () => {
    const { env } = createBindings();
    const app = createApp(
        { secretsMatch },
        {
            broadcastRelease: async () => {
                return summary;
            }
        }
    );
    const response = await postAdmin(app, env, { [SECRET_HEADER]: SECRET });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: true, summary });
});

test('admin route does not swallow the Telegram webhook route', async () => {
    const { env } = createBindings();
    const handled: unknown[] = [];
    const app = createApp({
        secretsMatch,
        handleUpdate: async (_env, update) => {
            handled.push(update);
        },
        createUpdateLedger: () => {
            return {
                claimUpdate: async () => {
                    return { status: 'claimed' } as never;
                },
                terminalizeUpdate: async () => true
            };
        },
        deriveBotKey: async () => 'bot-key'
    });

    const unknown = await app.request(
        '/somewhere-else',
        { method: 'POST', headers: { [SECRET_HEADER]: SECRET } },
        env
    );
    const webhook = await app.request(
        '/telegram/test',
        { method: 'POST', headers: { [SECRET_HEADER]: 'wrong' } },
        env
    );

    assert.equal(unknown.status, 404);
    assert.equal(webhook.status, 401);
});

test('broadcast script validates its target argument', () => {
    assert.equal(parseBroadcastTarget('production'), 'production');
    assert.equal(parseBroadcastTarget('beta'), 'beta');
    assert.throws(() => parseBroadcastTarget('local'), /Usage/);
    assert.throws(() => parseBroadcastTarget(undefined), /Usage/);
});

test('broadcast script posts the secret header to the admin path', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const result = await triggerReleaseBroadcast(
        'https://worker.example.com/',
        SECRET,
        (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
            url = String(input);
            init = requestInit;
            return new Response('{"enabled":true}', { status: 200 });
        }) as typeof fetch
    );

    assert.equal(url, 'https://worker.example.com/admin/release-broadcast');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(init?.headers, { [SECRET_HEADER]: SECRET });
    assert.equal(result.ok, true);
});

test('broadcast script reports non-2xx responses as failures', async () => {
    const result = await triggerReleaseBroadcast(
        'https://worker.example.com',
        SECRET,
        (async () => {
            return new Response('{"error":"x"}', { status: 401 });
        }) as typeof fetch
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

const EXPECTED_VERSION = '5.0.0';
const summaryBody = (releaseVersion: string) => {
    return JSON.stringify({ enabled: true, summary: { releaseVersion } });
};

const runWithResponses = async (responses: Array<Response | Error>) => {
    const queue = [...responses];
    const logs: string[] = [];
    let calls = 0;
    const exitCode = await runReleaseBroadcast({
        workerBaseUrl: 'https://worker.example.com',
        secret: SECRET,
        expectedVersion: EXPECTED_VERSION,
        maxAttempts: 3,
        retryDelayMilliseconds: 0,
        sleep: async () => {},
        log: message => {
            logs.push(message);
        },
        fetchImplementation: (async () => {
            calls += 1;
            const next = queue.shift() ?? new Error('no more responses');

            if (next instanceof Error) {
                throw next;
            }

            return next;
        }) as typeof fetch
    });

    return { exitCode, logs, calls };
};

test('broadcast credentials prefer process environment over env files', () => {
    const credentials = resolveBroadcastCredentials('production', {
        WORKER_BASE_URL: 'https://env.example.com',
        TELEGRAM_WEBHOOK_SECRET: 'env-secret'
    });

    assert.deepEqual(credentials, {
        workerBaseUrl: 'https://env.example.com',
        secret: 'env-secret'
    });
});

test('broadcast credentials name missing variables without values', () => {
    assert.throws(() => {
        return resolveBroadcastCredentials('beta', {
            WORKER_BASE_URL: 'https://env.example.com'
        });
    }, /TELEGRAM_WEBHOOK_SECRET/);
});

test('broadcast retries on version mismatch then succeeds', async () => {
    const { exitCode, calls } = await runWithResponses([
        new Response(summaryBody('4.9.0'), { status: 200 }),
        new Response('', { status: 502 }),
        new Response(summaryBody(EXPECTED_VERSION), { status: 200 })
    ]);

    assert.equal(exitCode, 0);
    assert.equal(calls, 3);
});

test('broadcast exits 0 when the broadcast is disabled', async () => {
    const { exitCode, logs, calls } = await runWithResponses([
        new Response('{"error":"disabled"}', { status: 409 })
    ]);

    assert.equal(exitCode, 0);
    assert.equal(calls, 1);
    assert.match(logs.join('\n'), /disabled/);
});

test('broadcast fails immediately on 401', async () => {
    const { exitCode, calls } = await runWithResponses([
        new Response('{"error":"unauthorized"}', { status: 401 }),
        new Response(summaryBody(EXPECTED_VERSION), { status: 200 })
    ]);

    assert.equal(exitCode, 1);
    assert.equal(calls, 1);
});

test('broadcast fails after exhausting retries', async () => {
    const { exitCode, calls } = await runWithResponses([
        new Response(summaryBody('4.9.0'), { status: 200 }),
        new Error('connection reset'),
        new Response('', { status: 404 })
    ]);

    assert.equal(exitCode, 1);
    assert.equal(calls, 3);
});
