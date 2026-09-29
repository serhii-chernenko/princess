import assert from 'node:assert/strict';
import {
    createHash,
    timingSafeEqual as nodeTimingSafeEqual
} from 'node:crypto';
import test from 'node:test';

import { Telegraf } from 'telegraf';

import { createApp } from '../src/worker/app';
import type { WorkerBindings } from '../src/worker/env';
import {
    compareSecrets,
    TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
    type SecretComparisonCrypto,
    type TelegramUpdateLedger
} from '../src/worker/routes/telegram';
import { runScheduledTasks } from '../src/worker/scheduled/tasks';
import {
    clearCachedBotInfo,
    handleUpdateWithPrincessBot
} from '../src/worker/routes/telegram';

class ReadinessPreparedStatement {
    constructor(private readonly readyValue: number | null) {}

    bind(..._values: unknown[]): D1PreparedStatement {
        return this;
    }

    first<T = unknown>(_columnName: string): Promise<T | null>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    async first<T>(): Promise<T | null> {
        return this.readyValue as T | null;
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        throw new Error('run is not used by readiness tests');
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        throw new Error('all is not used by readiness tests');
    }

    raw<T = unknown[]>(options: {
        columnNames: true;
    }): Promise<[string[], ...T[]]>;
    raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async raw(): Promise<never> {
        throw new Error('raw is not used by readiness tests');
    }
}

const createReadinessDatabase = (readyValue: number | null) => {
    const queries: string[] = [];
    const database = {
        prepare(query: string) {
            queries.push(query);
            return new ReadinessPreparedStatement(readyValue);
        },
        async batch<T = unknown>(): Promise<D1Result<T>[]> {
            return [];
        },
        async exec() {
            return {
                count: 0,
                duration: 0
            };
        },
        withSession() {
            throw new Error('sessions are not used by readiness tests');
        },
        async dump() {
            return new ArrayBuffer(0);
        }
    } satisfies D1Database;

    return {
        database,
        queries
    };
};

const createBindings = (
    DB: D1Database,
    botEnvironment: 'local' | 'stable' | 'beta' = 'local'
): WorkerBindings => {
    return {
        DB,
        BOT_ENVIRONMENT: botEnvironment,
        ENABLE_SCHEDULED_CLEANUP: botEnvironment === 'local' ? 'true' : 'false',
        ENABLE_RELEASE_BROADCAST: botEnvironment === 'local' ? 'false' : 'true',
        RELEASE_QUEUE: {} as WorkerBindings['RELEASE_QUEUE'],
        AUTHOR_TWITTER_LINK: 'https://twitter.com/giraffender',
        WISHLIST_TG_URL: 'https://t.me/wishlist_ua_bot',
        CHATGPT_GITHUB_REPO_URL:
            'https://github.com/serhii-chernenko/chatgpt-telegram-bot',
        TG_CHANNEL: 'https://t.me/serhii_chernenko',
        TG_GROUP: 'https://t.me/serhii_chernenko_chat',
        YT_CHANNEL: 'https://youtube.com/@serhii.chernenko',
        MAIL: 'contact@chernenko.digital',
        BOT_TOKEN: '123456:test-token',
        TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
        TELEGRAM_WEBHOOK_PATH: '/telegram/test'
    };
};

const withoutBinding = (
    bindings: WorkerBindings,
    key: 'BOT_TOKEN' | 'TELEGRAM_WEBHOOK_PATH' | 'TELEGRAM_WEBHOOK_SECRET'
) => {
    const incompleteBindings: Partial<WorkerBindings> = {
        ...bindings
    };

    delete incompleteBindings[key];

    return incompleteBindings as WorkerBindings;
};

const nodeSecretCrypto: SecretComparisonCrypto = {
    async digest(_algorithm, data) {
        const digest = Uint8Array.from(
            createHash('sha256').update(data).digest()
        );

        return digest.buffer;
    },
    timingSafeEqual(left, right) {
        return nodeTimingSafeEqual(new Uint8Array(left), new Uint8Array(right));
    }
};

const secretsMatch = (provided: string, expected: string) => {
    return compareSecrets(provided, expected, nodeSecretCrypto);
};

const createClaimingLedger = (
    overrides: Partial<TelegramUpdateLedger> = {}
): TelegramUpdateLedger => {
    return {
        async claimUpdate(_botKey, _updateId, leaseId) {
            return {
                state: 'claimed',
                leaseId,
                reclaimed: false
            };
        },
        async terminalizeUpdate() {
            return true;
        },
        ...overrides
    };
};

const ledgerRouteDependencies = {
    secretsMatch,
    createUpdateLedger: () => createClaimingLedger(),
    async deriveBotKey() {
        return 'a'.repeat(64);
    },
    createLeaseId: () => 'test-lease-id'
};

const createTelegramUpdateBody = (updateId: number) => {
    return JSON.stringify({
        update_id: updateId,
        message: {
            message_id: 7,
            date: 1_784_098_000,
            chat: {
                id: -100_000_000_001,
                type: 'supergroup'
            },
            text: 'test'
        }
    });
};

const createTelegramRequest = (
    path: string,
    body: string,
    secret = 'test-webhook-secret',
    contentType = 'application/json'
) => {
    return new Request(`https://worker.example${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': contentType,
            'X-Telegram-Bot-Api-Secret-Token': secret
        },
        body
    });
};

test('webhook accepts a validated update only on the exact configured path', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    const handledUpdateIds: number[] = [];
    const app = createApp({
        ...ledgerRouteDependencies,
        async handleUpdate(_env, update) {
            handledUpdateIds.push(update.update_id);
        }
    });

    const accepted = await app.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );
    const trailingSlash = await app.fetch(
        createTelegramRequest('/telegram/test/', createTelegramUpdateBody(43)),
        bindings
    );

    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
        accepted: true,
        updateId: 42
    });
    assert.equal(trailingSlash.status, 404);
    assert.deepEqual(handledUpdateIds, [42]);
});

test('webhook fails closed when any required secret or path is missing', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    let handledUpdates = 0;
    const app = createApp({
        ...ledgerRouteDependencies,
        async handleUpdate() {
            handledUpdates += 1;
        }
    });
    const requiredBindings = [
        'BOT_TOKEN',
        'TELEGRAM_WEBHOOK_PATH',
        'TELEGRAM_WEBHOOK_SECRET'
    ] as const;

    for (const binding of requiredBindings) {
        const response = await app.fetch(
            createTelegramRequest(
                '/telegram/test',
                createTelegramUpdateBody(42)
            ),
            withoutBinding(bindings, binding)
        );

        assert.equal(response.status, 503, binding);
    }

    assert.equal(handledUpdates, 0);
});

test('webhook rejects invalid secrets, media types, JSON, and update IDs', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    let handledUpdates = 0;
    const app = createApp({
        ...ledgerRouteDependencies,
        async handleUpdate() {
            handledUpdates += 1;
        }
    });
    const requests = [
        {
            request: createTelegramRequest(
                '/telegram/test',
                createTelegramUpdateBody(42),
                'wrong-secret'
            ),
            status: 401
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                createTelegramUpdateBody(42),
                'test-webhook-secret',
                'text/plain'
            ),
            status: 415
        },
        {
            request: createTelegramRequest('/telegram/test', '{'),
            status: 400
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                createTelegramUpdateBody(-1)
            ),
            status: 400
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                createTelegramUpdateBody(1.5)
            ),
            status: 400
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                createTelegramUpdateBody(Number.MAX_SAFE_INTEGER + 1)
            ),
            status: 400
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                '{"update_id":42,"my_chat_member":{}}'
            ),
            status: 200
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                '{"my_chat_member":{}}'
            ),
            status: 400
        },
        {
            request: createTelegramRequest(
                '/telegram/test',
                '{"update_id":42,"message":{}}'
            ),
            status: 400
        }
    ];

    for (const expectation of requests) {
        const response = await app.fetch(expectation.request, bindings);

        assert.equal(response.status, expectation.status);
    }

    assert.equal(handledUpdates, 0);
});

test('webhook caps authenticated JSON before parsing and authenticates first', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    let handledUpdates = 0;
    const app = createApp({
        ...ledgerRouteDependencies,
        async handleUpdate() {
            handledUpdates += 1;
        }
    });
    const oversizedBody = ' '.repeat(TELEGRAM_WEBHOOK_MAX_BODY_BYTES + 1);

    const authorized = await app.fetch(
        createTelegramRequest('/telegram/test', oversizedBody),
        bindings
    );
    const unauthorized = await app.fetch(
        createTelegramRequest('/telegram/test', oversizedBody, 'wrong-secret'),
        bindings
    );

    assert.equal(authorized.status, 413);
    assert.equal(unauthorized.status, 401);
    assert.equal(handledUpdates, 0);
});

test('webhook acknowledges processed duplicates and retries busy claims', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    let handledUpdates = 0;
    const duplicateApp = createApp({
        ...ledgerRouteDependencies,
        createUpdateLedger: () => {
            return createClaimingLedger({
                async claimUpdate() {
                    return {
                        state: 'duplicate'
                    };
                }
            });
        },
        async handleUpdate() {
            handledUpdates += 1;
        }
    });
    const busyApp = createApp({
        ...ledgerRouteDependencies,
        createUpdateLedger: () => {
            return createClaimingLedger({
                async claimUpdate() {
                    return {
                        state: 'busy'
                    };
                }
            });
        },
        async handleUpdate() {
            handledUpdates += 1;
        }
    });

    const duplicate = await duplicateApp.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );
    const busy = await busyApp.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );

    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), {
        accepted: true,
        duplicate: true,
        updateId: 42
    });
    assert.equal(busy.status, 503);
    assert.equal(handledUpdates, 0);
});

test('webhook logs a secret-safe warning when reclaiming a stale claim', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    const warnings: string[] = [];
    const app = createApp({
        ...ledgerRouteDependencies,
        createUpdateLedger: () => {
            return createClaimingLedger({
                async claimUpdate(_botKey, _updateId, leaseId) {
                    return {
                        state: 'claimed',
                        leaseId,
                        reclaimed: true
                    };
                }
            });
        },
        logWarning(message) {
            warnings.push(message);
        },
        async handleUpdate() {}
    });

    const response = await app.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
        warnings.map(message => JSON.parse(message) as unknown),
        [
            {
                event: 'telegram_update_claim_reclaimed',
                botEnvironment: 'local',
                updateId: 42
            }
        ]
    );
    assert.equal(warnings[0]?.includes('test-token'), false);
    assert.equal(warnings[0]?.includes('test-webhook-secret'), false);
});

test('failed dispatch is terminalized and cannot execute again on retry', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    const terminalizedLeases: string[] = [];
    let dispatchCalls = 0;
    let isTerminalized = false;
    const ledger = createClaimingLedger({
        async claimUpdate(_botKey, _updateId, leaseId) {
            if (isTerminalized) {
                return {
                    state: 'duplicate'
                };
            }

            return {
                state: 'claimed',
                leaseId,
                reclaimed: false
            };
        },
        async terminalizeUpdate(_botKey, _updateId, leaseId) {
            terminalizedLeases.push(leaseId);
            isTerminalized = true;
            return true;
        }
    });
    const failedHandlerApp = createApp({
        ...ledgerRouteDependencies,
        createUpdateLedger: () => ledger,
        async handleUpdate() {
            dispatchCalls += 1;
            throw new Error('expected handler failure');
        }
    });

    const failedDispatch = await failedHandlerApp.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );
    const automaticRetry = await failedHandlerApp.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );

    assert.equal(failedDispatch.status, 200);
    assert.deepEqual(await failedDispatch.json(), {
        accepted: true,
        updateId: 42
    });
    assert.equal(automaticRetry.status, 200);
    assert.deepEqual(await automaticRetry.json(), {
        accepted: true,
        duplicate: true,
        updateId: 42
    });
    assert.equal(dispatchCalls, 1);
    assert.deepEqual(terminalizedLeases, ['test-lease-id']);
});

test('webhook acknowledges uncertain dispatch state and fails closed before dispatch', async () => {
    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    let dispatchCalls = 0;
    const uncertainDispatchApp = createApp({
        ...ledgerRouteDependencies,
        createUpdateLedger: () => {
            return createClaimingLedger({
                async terminalizeUpdate() {
                    throw new Error('expected terminalization failure');
                }
            });
        },
        async handleUpdate() {
            dispatchCalls += 1;
            throw new Error('expected handler failure');
        }
    });
    const unavailableLedgerApp = createApp({
        ...ledgerRouteDependencies,
        createUpdateLedger: () => {
            return createClaimingLedger({
                async claimUpdate() {
                    throw new Error('expected ledger failure');
                }
            });
        }
    });

    const uncertainDispatch = await uncertainDispatchApp.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(42)),
        bindings
    );
    const unavailableLedger = await unavailableLedgerApp.fetch(
        createTelegramRequest('/telegram/test', createTelegramUpdateBody(43)),
        bindings
    );

    assert.equal(uncertainDispatch.status, 200);
    assert.deepEqual(await uncertainDispatch.json(), {
        accepted: true,
        updateId: 42
    });
    assert.equal(dispatchCalls, 1);
    assert.equal(unavailableLedger.status, 503);
});

test('health reports configuration and D1 readiness', async () => {
    const readyDatabase = createReadinessDatabase(1);
    const unavailableDatabase = createReadinessDatabase(null);
    const app = createApp({
        secretsMatch
    });
    const authorizedRequest = {
        headers: {
            'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'
        }
    };

    const readyResponse = await app.request(
        '/health',
        authorizedRequest,
        createBindings(readyDatabase.database)
    );
    const databaseUnavailableResponse = await app.request(
        '/health',
        authorizedRequest,
        createBindings(unavailableDatabase.database)
    );
    const configurationUnavailableResponse = await app.request(
        '/health',
        authorizedRequest,
        withoutBinding(createBindings(readyDatabase.database), 'BOT_TOKEN')
    );
    const unauthorizedResponse = await app.request(
        '/health',
        undefined,
        createBindings(readyDatabase.database)
    );

    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await readyResponse.json(), {
        service: 'princess',
        runtime: 'cloudflare-workers',
        ready: true,
        checks: {
            configuration: true,
            database: true
        }
    });
    assert.equal(databaseUnavailableResponse.status, 503);
    assert.equal(configurationUnavailableResponse.status, 503);
    assert.equal(unauthorizedResponse.status, 401);
    assert.deepEqual(readyDatabase.queries, ['SELECT 1 AS ready']);
    assert.deepEqual(unavailableDatabase.queries, ['SELECT 1 AS ready']);
});

test('scheduled cleanup remains gated by the environment flag', async () => {
    const { database } = createReadinessDatabase(1);
    const controller = {
        cron: '0 0 * * *',
        scheduledTime: Date.now(),
        noRetry() {}
    } satisfies ScheduledController;
    const context = {} as ExecutionContext;
    let cleanupCalls = 0;
    let abandonedLedgerPruneCalls = 0;
    let processedLedgerPruneCalls = 0;
    const dependencies = {
        async cleanupInactiveChannels() {
            cleanupCalls += 1;
            return 0;
        },
        async pruneProcessedTelegramUpdates() {
            processedLedgerPruneCalls += 1;
            return 3;
        },
        async pruneAbandonedTelegramUpdates() {
            abandonedLedgerPruneCalls += 1;
            return 2;
        }
    };

    await runScheduledTasks(
        controller,
        createBindings(database, 'stable'),
        context,
        dependencies
    );
    await runScheduledTasks(
        controller,
        createBindings(database, 'local'),
        context,
        dependencies
    );

    assert.equal(cleanupCalls, 1);
    assert.equal(abandonedLedgerPruneCalls, 1);
    assert.equal(processedLedgerPruneCalls, 1);
});

test('bot info is fetched once per bot key and reused by later updates', async () => {
    clearCachedBotInfo();

    const { database } = createReadinessDatabase(1);
    const bindings = createBindings(database);
    const update = JSON.parse(createTelegramUpdateBody(42)) as Parameters<
        typeof handleUpdateWithPrincessBot
    >[1];
    let getMeCalls = 0;
    const createBot = () => {
        const bot = new Telegraf('123456:test-token');

        bot.telegram.callApi = (async (method: string) => {
            if (method === 'getMe') {
                getMeCalls += 1;
            }

            return {
                id: 123456,
                is_bot: true,
                first_name: 'Princess',
                username: 'princess_test_bot'
            };
        }) as typeof bot.telegram.callApi;

        return bot;
    };

    await handleUpdateWithPrincessBot(
        bindings,
        update,
        'test-bot-key',
        createBot
    );
    await handleUpdateWithPrincessBot(
        bindings,
        update,
        'test-bot-key',
        createBot
    );

    assert.equal(getMeCalls, 1);
    clearCachedBotInfo();
});
