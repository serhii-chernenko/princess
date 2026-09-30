import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { getMessages } from '../../src/bot/content/messages';
import {
    createD1Harness,
    createWorkerEnv,
    countRows,
    type D1Harness
} from './d1-harness';

const botToken = '123456:integration-test-token';
const webhookSecret = 'integration-webhook-secret';
const webhookPath = '/telegram/integration-path';
const botEnvironment = 'local';
const secretHeader = 'X-Telegram-Bot-Api-Secret-Token';

interface TelegramApiCall {
    method: string;
    payload: unknown;
}

type WorkerModule = typeof import('../../src/worker/index');

const nodeFetchModulePath = () => {
    return require.resolve('node-fetch', {
        paths: [require.resolve('telegraf')]
    });
};

const nonAdminUserId = 79;

const createTelegramResult = (method: string, payload: unknown) => {
    if (method === 'getMe') {
        return {
            id: 123456,
            is_bot: true,
            first_name: 'Princess',
            username: 'princess_test_bot'
        };
    }

    if (method === 'getChatMember') {
        const userId = (payload as { user_id: number }).user_id;

        return {
            status: userId === nonAdminUserId ? 'member' : 'creator',
            user: { id: userId, is_bot: false, first_name: 'Ann' }
        };
    }

    return { message_id: 1, date: 0, chat: { id: 1, type: 'private' } };
};

const createTelegramFetchStub = (calls: TelegramApiCall[]) => {
    return async (url: URL, init: { body?: unknown }) => {
        const method = url.pathname.split('/').pop() ?? '';
        const payload =
            typeof init.body === 'string' ? JSON.parse(init.body) : null;
        const result = createTelegramResult(method, payload);

        calls.push({ method, payload });

        return {
            status: 200,
            statusText: 'OK',
            json: async () => ({ ok: true, result })
        };
    };
};

const createStartUpdate = (updateId: number) => {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 1_800_000_000,
            chat: { id: 77, type: 'private', first_name: 'Ann' },
            from: { id: 77, is_bot: false, first_name: 'Ann' },
            text: '/start',
            entities: [{ type: 'bot_command', offset: 0, length: 6 }]
        }
    };
};

const createGroupUpdate = (updateId: number, userId: number, text: string) => {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 1_800_000_000,
            chat: { id: -1001, type: 'supergroup', title: 'Princesses' },
            from: { id: userId, is_bot: false, first_name: 'Ann' },
            text,
            entities: [{ type: 'bot_command', offset: 0, length: text.length }]
        }
    };
};

describe('Telegram webhook through the Worker on D1', () => {
    let harness: D1Harness;
    let worker: WorkerModule['default'];
    let apiCalls: TelegramApiCall[];
    let restoreRuntimePatches: (() => void) | undefined;

    const deliver = (update: object, secret = webhookSecret) => {
        return worker.fetch(
            new Request(`https://example.test${webhookPath}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    [secretHeader]: secret
                },
                body: JSON.stringify(update)
            }),
            createWorkerEnv(harness, {
                BOT_TOKEN: botToken,
                TELEGRAM_WEBHOOK_SECRET: webhookSecret,
                TELEGRAM_WEBHOOK_PATH: webhookPath
            }),
            { waitUntil() {}, passThroughOnException() {} } as never
        );
    };
    const countSendMessageCalls = () => {
        return apiCalls.filter(call => call.method === 'sendMessage').length;
    };
    let nextUpdateId = 9000;
    const send = async (userId: number, command: string) => {
        const response = await deliver(
            createGroupUpdate(nextUpdateId, userId, command)
        );

        nextUpdateId += 1;

        assert.equal(response.status, 200);
    };
    const readLastReplyText = () => {
        const reply = apiCalls
            .filter(call => call.method === 'sendMessage')
            .at(-1);

        return (reply?.payload as { text: string } | undefined)?.text ?? '';
    };
    const readChannel = () => {
        return harness.env.DB.prepare(
            'SELECT stopped_at AS stoppedAt, last_vote_at AS lastVoteAt, language FROM channels'
        ).first<{
            stoppedAt: number | null;
            lastVoteAt: number | null;
            language: string;
        }>();
    };
    const readPlayerUserIds = async () => {
        const { results } = await harness.env.DB.prepare(
            'SELECT telegram_user_id AS telegramUserId FROM players ORDER BY telegram_user_id'
        ).all<{ telegramUserId: number }>();

        return results.map(row => {
            return row.telegramUserId;
        });
    };

    before(async () => {
        harness = await createD1Harness();
        await harness.applyMigrations();
        apiCalls = [];

        const fetchModulePath = nodeFetchModulePath();
        const originalFetchModule = require.cache[fetchModulePath];
        const subtle = crypto.subtle as unknown as Record<string, unknown>;
        const originalTimingSafeEqual = subtle.timingSafeEqual;

        require.cache[fetchModulePath] = {
            id: fetchModulePath,
            filename: fetchModulePath,
            loaded: true,
            exports: createTelegramFetchStub(apiCalls)
        } as never;
        subtle.timingSafeEqual = (left: ArrayBuffer, right: ArrayBuffer) => {
            return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
        };
        restoreRuntimePatches = () => {
            if (originalFetchModule) {
                require.cache[fetchModulePath] = originalFetchModule;
            } else {
                delete require.cache[fetchModulePath];
            }

            subtle.timingSafeEqual = originalTimingSafeEqual;
        };

        worker = (await import('../../src/worker/index')).default;
    });

    after(async () => {
        restoreRuntimePatches?.();
        await harness.dispose();
    });

    beforeEach(async () => {
        await harness.clearApplicationTables();
        apiCalls.length = 0;
    });

    it('admin forget then restore works without a channel row and non-admins are refused', async () => {
        await send(77, '/start');
        await send(77, '/join');
        await send(78, '/join');

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_members'), 2);

        await send(79, '/forget');

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_snapshots'), 0);

        await send(77, '/forget');

        assert.equal(await countRows(harness, 'channels'), 0);
        assert.equal(await countRows(harness, 'channel_snapshots'), 1);

        await send(79, '/restore');

        assert.equal(await countRows(harness, 'channels'), 0);

        await send(77, '/restore');

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_members'), 2);
    });

    it('resumes a paused group for an admin /start and keeps it paused for a non-admin', async () => {
        await send(77, '/start');
        await send(77, '/join');
        await send(77, '/stop');

        const pausedChannel = await readChannel();
        const LL = getMessages(pausedChannel?.language as never);

        assert.notEqual(pausedChannel?.stoppedAt, null);
        assert.equal(readLastReplyText(), LL.successStop());

        await send(nonAdminUserId, '/start');

        assert.notEqual((await readChannel())?.stoppedAt, null);
        assert.ok(readLastReplyText().includes(LL.gameStopped()));
        assert.equal(readLastReplyText().includes(LL.successResume()), false);

        await send(77, '/start');

        assert.equal((await readChannel())?.stoppedAt, null);
        assert.ok(readLastReplyText().includes(LL.successResume()));
        assert.equal(readLastReplyText().includes(LL.gameStopped()), false);
    });

    it('refuses /run after /stop without drawing a winner', async () => {
        await send(77, '/start');
        await send(77, '/join');
        await send(78, '/join');
        await send(77, '/stop');

        const LL = getMessages((await readChannel())?.language as never);

        await send(77, '/run');

        assert.equal(readLastReplyText(), LL.gameStopped());
        assert.equal((await readChannel())?.lastVoteAt, null);
        assert.equal(await countRows(harness, 'vote_wins'), 0);
    });

    it('restore over a different current roster removes the orphaned extra players', async () => {
        await send(77, '/start');
        await send(77, '/join');
        await send(78, '/join');
        await send(77, '/forget');

        assert.equal(await countRows(harness, 'channels'), 0);
        assert.deepEqual(await readPlayerUserIds(), []);

        await send(77, '/start');
        await send(81, '/join');
        await send(82, '/join');

        assert.deepEqual(await readPlayerUserIds(), [81, 82]);

        await send(77, '/restore');

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_members'), 2);
        assert.deepEqual(await readPlayerUserIds(), [77, 78]);
        assert.equal(await countRows(harness, 'channel_snapshots'), 2);
    });

    it('rejects a wrong secret without touching the ledger or Telegram', async () => {
        const response = await deliver(createStartUpdate(1), 'wrong-secret');

        assert.equal(response.status, 401);
        assert.equal(await countRows(harness, 'telegram_updates'), 0);
        assert.equal(apiCalls.length, 0);
    });

    it('claims an authenticated update, dispatches it once and acknowledges a duplicate delivery without re-dispatch', async () => {
        const expectedBotKey = createHash('sha256')
            .update(`${botEnvironment}:${botToken}`)
            .digest('hex');
        const first = await deliver(createStartUpdate(5001));

        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), {
            accepted: true,
            updateId: 5001
        });
        assert.equal(countSendMessageCalls(), 1);
        assert.deepEqual(
            await harness.env.DB.prepare(
                'SELECT bot_key AS botKey, update_id AS updateId, status FROM telegram_updates'
            ).first(),
            {
                botKey: expectedBotKey,
                updateId: 5001,
                status: 'processed'
            }
        );

        const second = await deliver(createStartUpdate(5001));

        assert.equal(second.status, 200);
        assert.deepEqual(await second.json(), {
            accepted: true,
            duplicate: true,
            updateId: 5001
        });
        assert.equal(countSendMessageCalls(), 1);
        assert.equal(await countRows(harness, 'telegram_updates'), 1);
    });

    it('dispatches concurrent deliveries of the same update at most once', async () => {
        const responses = await Promise.all(
            Array.from({ length: 8 }, () => {
                return deliver(createStartUpdate(6001));
            })
        );
        const statuses = responses.map(response => response.status);

        assert.equal(countSendMessageCalls(), 1);
        assert.ok(statuses.every(status => status === 200 || status === 503));
        assert.ok(statuses.includes(200));
        assert.equal(await countRows(harness, 'telegram_updates'), 1);
    });
});
