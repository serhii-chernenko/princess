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
const botUsername = 'princess_test_bot';

const createTelegramResult = (method: string, payload: unknown) => {
    if (method === 'getMe') {
        return {
            id: 123456,
            is_bot: true,
            first_name: 'Princess',
            username: botUsername
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

const createTelegramFetchStub = (
    calls: TelegramApiCall[],
    shouldFail: (method: string) => boolean
) => {
    return async (url: URL, init: { body?: unknown }) => {
        const method = url.pathname.split('/').pop() ?? '';
        const payload =
            typeof init.body === 'string' ? JSON.parse(init.body) : null;
        const result = createTelegramResult(method, payload);

        calls.push({ method, payload });

        if (shouldFail(method)) {
            const failure = {
                ok: false,
                error_code: 400,
                description: 'Bad Request: simulated failure'
            };

            return {
                status: 400,
                statusText: 'Bad Request',
                json: async () => failure
            };
        }

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

interface GroupUpdateOptions {
    entityLength?: number;
    extraMessageFields?: object;
}

const createGroupUpdate = (
    updateId: number,
    userId: number,
    text: string,
    options: GroupUpdateOptions = {}
) => {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 1_800_000_000,
            chat: { id: -1001, type: 'supergroup', title: 'Princesses' },
            from: { id: userId, is_bot: false, first_name: 'Ann' },
            text,
            entities: [
                {
                    type: 'bot_command',
                    offset: 0,
                    length: options.entityLength ?? text.length
                }
            ],
            ...options.extraMessageFields
        }
    };
};

const forwardedReplyFields = {
    forward_from: { id: 55, is_bot: false, first_name: 'Bob' },
    forward_date: 1_800_000_000,
    reply_to_message: {
        message_id: 1,
        date: 1_800_000_000,
        chat: { id: -1001, type: 'supergroup', title: 'Princesses' },
        from: { id: 55, is_bot: false, first_name: 'Bob' },
        text: 'hello'
    }
};

const createPrivateUpdate = (updateId: number, text: string) => {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 1_800_000_000,
            chat: { id: 77, type: 'private', first_name: 'Ann' },
            from: { id: 77, is_bot: false, first_name: 'Ann' },
            text,
            entities: [
                {
                    type: 'bot_command',
                    offset: 0,
                    length: (text.split(' ')[0] ?? text).length
                }
            ]
        }
    };
};

describe('Telegram webhook through the Worker on D1', () => {
    let harness: D1Harness;
    let worker: WorkerModule['default'];
    let apiCalls: TelegramApiCall[];
    let restoreRuntimePatches: (() => void) | undefined;
    let failingMethods: ReadonlySet<string> = new Set();

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
    const send = async (
        userId: number,
        command: string,
        options?: GroupUpdateOptions
    ) => {
        const response = await deliver(
            createGroupUpdate(nextUpdateId, userId, command, options)
        );

        nextUpdateId += 1;

        assert.equal(response.status, 200);
    };
    const sendPrivate = async (command: string) => {
        const response = await deliver(
            createPrivateUpdate(nextUpdateId, command)
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
            exports: createTelegramFetchStub(apiCalls, method => {
                return failingMethods.has(method);
            })
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
        failingMethods = new Set();
    });

    it('admin forget then restore works without a channel row and non-admins are refused', async () => {
        await send(77, '/start');
        await send(77, '/join');
        await send(78, '/join');

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_members'), 2);

        await send(79, `/forget@${botUsername}`);

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_snapshots'), 0);

        await send(77, `/forget@${botUsername}`);

        assert.equal(await countRows(harness, 'channels'), 0);
        assert.equal(await countRows(harness, 'channel_snapshots'), 1);

        await send(79, `/restore@${botUsername}`);

        assert.equal(await countRows(harness, 'channels'), 0);

        await send(77, `/restore@${botUsername}`);

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_members'), 2);
    });

    it('resumes a paused group for an admin /start and keeps it paused for a non-admin', async () => {
        await send(77, '/start');
        await send(77, '/join');
        await send(77, `/stop@${botUsername}`);

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
        await send(77, `/stop@${botUsername}`);

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
        await send(77, `/forget@${botUsername}`);

        assert.equal(await countRows(harness, 'channels'), 0);
        assert.deepEqual(await readPlayerUserIds(), []);

        await send(77, '/start');
        await send(81, '/join');
        await send(82, '/join');

        assert.deepEqual(await readPlayerUserIds(), [81, 82]);

        await send(77, `/restore@${botUsername}`);

        assert.equal(await countRows(harness, 'channels'), 1);
        assert.equal(await countRows(harness, 'channel_members'), 2);
        assert.deepEqual(await readPlayerUserIds(), [77, 78]);
        assert.equal(await countRows(harness, 'channel_snapshots'), 2);
    });

    describe('destructive commands in groups require the bot name', () => {
        const readHint = async (command: string) => {
            const LL = getMessages((await readChannel())?.language as never);

            return LL.groupCommandNeedsBotName({
                command,
                username: botUsername
            });
        };
        const seedGroup = async () => {
            await send(77, '/start');
            await send(77, '/join');
            await send(78, '/join');
            apiCalls.length = 0;
        };

        it('refuses a bare /forget from an admin with a hint and deletes nothing', async () => {
            await seedGroup();
            await send(77, '/forget');

            assert.equal(countSendMessageCalls(), 1);
            assert.equal(readLastReplyText(), await readHint('forget'));
            assert.equal(await countRows(harness, 'channels'), 1);
            assert.equal(await countRows(harness, 'channel_members'), 2);
            assert.equal(await countRows(harness, 'channel_snapshots'), 0);
        });

        it('accepts the bot name case-insensitively', async () => {
            await seedGroup();
            await send(77, '/forget@PRINCESS_Test_Bot');

            assert.equal(await countRows(harness, 'channels'), 0);
            assert.equal(await countRows(harness, 'channel_snapshots'), 1);

            await send(77, '/restore@Princess_TEST_bot');

            assert.equal(await countRows(harness, 'channels'), 1);
            assert.equal(await countRows(harness, 'channel_members'), 2);
        });

        it('ignores a command addressed to another bot without any reply', async () => {
            await seedGroup();
            await send(77, '/forget@someotherbot');
            await send(77, '/stop@someotherbot');
            await send(77, '/reset@someotherbot');
            await send(77, '/restore@someotherbot');

            assert.equal(apiCalls.length, 0);
            assert.equal(await countRows(harness, 'channels'), 1);
            assert.equal(await countRows(harness, 'channel_members'), 2);
            assert.equal(await countRows(harness, 'channel_snapshots'), 0);
            assert.equal((await readChannel())?.stoppedAt, null);
        });

        it('refuses bare /stop, /reset and /restore and keeps the state unchanged', async () => {
            await seedGroup();

            for (const command of ['stop', 'reset', 'restore']) {
                apiCalls.length = 0;
                await send(77, `/${command}`);

                assert.equal(countSendMessageCalls(), 1);
                assert.equal(readLastReplyText(), await readHint(command));
            }

            assert.equal((await readChannel())?.stoppedAt, null);
            assert.equal(await countRows(harness, 'channel_members'), 2);
            assert.equal(await countRows(harness, 'channel_snapshots'), 0);
        });

        it('refuses uppercase and empty-suffix spellings of a guarded command', async () => {
            await seedGroup();

            for (const text of ['/STOP', '/stop@']) {
                apiCalls.length = 0;
                await send(77, text);

                assert.equal(countSendMessageCalls(), 1);
                assert.equal(readLastReplyText(), await readHint('stop'));
            }

            assert.equal((await readChannel())?.stoppedAt, null);
        });

        it('refuses a guarded command followed by arguments when the entity covers only the command', async () => {
            await seedGroup();

            const cases = [
                { text: '/stop foo', entityLength: 5, command: 'stop' },
                { text: '/stop@', entityLength: 5, command: 'stop' },
                { text: '/forget now', entityLength: 7, command: 'forget' }
            ];

            for (const { text, entityLength, command } of cases) {
                apiCalls.length = 0;
                await send(77, text, { entityLength });

                assert.equal(countSendMessageCalls(), 1);
                assert.equal(readLastReplyText(), await readHint(command));
            }

            assert.equal((await readChannel())?.stoppedAt, null);
            assert.equal(await countRows(harness, 'channels'), 1);
            assert.equal(await countRows(harness, 'channel_members'), 2);
            assert.equal(await countRows(harness, 'channel_snapshots'), 0);
        });

        it('skips the guard for a forwarded reply and the handler ignores it without a hint', async () => {
            await seedGroup();

            for (const text of [
                '/forget',
                `/forget@${botUsername}`,
                '/stop',
                `/reset@${botUsername}`
            ]) {
                await send(77, text, {
                    extraMessageFields: forwardedReplyFields
                });
            }

            assert.equal(apiCalls.length, 0);
            assert.equal((await readChannel())?.stoppedAt, null);
            assert.equal(await countRows(harness, 'channels'), 1);
            assert.equal(await countRows(harness, 'channel_members'), 2);
            assert.equal(await countRows(harness, 'channel_snapshots'), 0);
        });

        it('swallows a failing hint send and still acknowledges the update', async () => {
            await seedGroup();
            failingMethods = new Set(['sendMessage']);
            await send(77, '/forget');

            assert.equal(countSendMessageCalls(), 1);
            assert.equal((await readChannel())?.stoppedAt, null);
            assert.equal(await countRows(harness, 'channels'), 1);
            assert.equal(await countRows(harness, 'channel_members'), 2);
            assert.equal(await countRows(harness, 'channel_snapshots'), 0);
            assert.deepEqual(
                await harness.env.DB.prepare(
                    'SELECT status FROM telegram_updates ORDER BY update_id DESC LIMIT 1'
                ).first(),
                { status: 'processed' }
            );
        });

        it('shows the real bot username in the /start note and the explicit form in reset and forget replies', async () => {
            await send(77, '/start');

            const LL = getMessages((await readChannel())?.language as never);

            assert.ok(
                readLastReplyText().includes(
                    LL.groupCommandsNote({ username: botUsername })
                )
            );
            assert.ok(readLastReplyText().includes(`/stop@${botUsername}`));

            await send(77, '/join');
            await send(77, `/reset@${botUsername}`);

            assert.equal(
                readLastReplyText(),
                LL.successReset({ username: botUsername })
            );
            assert.ok(readLastReplyText().includes(`/restore@${botUsername}`));

            await send(77, `/forget@${botUsername}`);

            assert.equal(
                readLastReplyText(),
                LL.successForget({ username: botUsername })
            );
            assert.ok(readLastReplyText().includes(`/restore@${botUsername}`));
        });

        it('refuses the bare form for non-admins too without running the admin check', async () => {
            await seedGroup();
            await send(nonAdminUserId, '/reset');

            assert.equal(readLastReplyText(), await readHint('reset'));
            assert.equal(
                apiCalls.some(call => call.method === 'getChatMember'),
                false
            );
        });

        it('keeps bare /join, /run and /top working in groups', async () => {
            await send(77, '/start');
            await send(77, '/join');
            await send(78, '/join');
            await send(81, '/join');
            await send(77, '/run');

            assert.equal(await countRows(harness, 'vote_wins'), 1);

            await send(77, '/top');

            const LL = getMessages((await readChannel())?.language as never);

            assert.ok(readLastReplyText().includes(LL.top()));
        });

        it('does not block bare guarded commands in a private chat', async () => {
            for (const command of ['stop', 'reset', 'forget', 'restore']) {
                apiCalls.length = 0;
                await sendPrivate(`/${command}`);

                assert.equal(countSendMessageCalls(), 1);
                assert.equal(
                    readLastReplyText(),
                    getMessages().greetingsError()
                );
            }
        });
    });

    describe('language in private chats and groups', () => {
        const readPlayerLanguage = (telegramUserId: number) => {
            return harness.env.DB.prepare(
                'SELECT language FROM players WHERE telegram_user_id = ?'
            )
                .bind(telegramUserId)
                .first<{ language: string | null }>();
        };

        const readStatsHeading = (locale: 'en' | 'ua') => {
            const statsMessage = getMessages(locale).stats({
                groups: 0,
                players: 0,
                youtube: '',
                mail: ''
            });

            return statsMessage.split('\n')[0] ?? statsMessage;
        };

        it('changes the language in a private chat without creating a channel', async () => {
            await sendPrivate('/lang en');

            assert.equal(countSendMessageCalls(), 1);
            assert.equal(
                readLastReplyText(),
                getMessages('en').lang.updatedPrivate({ language: 'en' })
            );
            assert.notEqual(readLastReplyText(), getMessages().hasNotData());
            assert.equal(await countRows(harness, 'channels'), 0);
            assert.equal((await readPlayerLanguage(77))?.language, 'en');
        });

        it('answers later private commands in the chosen language', async () => {
            await sendPrivate('/lang en');
            apiCalls.length = 0;
            await sendPrivate('/stats');

            assert.ok(readLastReplyText().startsWith(readStatsHeading('en')));

            await sendPrivate('/lang ua');
            apiCalls.length = 0;
            await sendPrivate('/stats');

            assert.ok(readLastReplyText().startsWith(readStatsHeading('ua')));
            assert.equal(await countRows(harness, 'channels'), 0);
        });

        it('lists the available languages for a bare private /lang without storing anything', async () => {
            await sendPrivate('/lang');

            assert.equal(countSendMessageCalls(), 1);
            assert.equal(readLastReplyText(), getMessages().lang.available());
            assert.equal(await countRows(harness, 'players'), 0);
        });

        it('rejects an unknown language code in a private chat', async () => {
            await sendPrivate('/lang xx');

            assert.equal(countSendMessageCalls(), 1);
            assert.ok(
                readLastReplyText().startsWith(
                    getMessages().lang.invalid({
                        language: 'xx',
                        languages: 'en, ua'
                    })
                )
            );
            assert.equal(await countRows(harness, 'players'), 0);
            assert.equal(await countRows(harness, 'channels'), 0);
        });

        it('keeps the private language independent from the group language', async () => {
            await send(77, '/start');
            await sendPrivate('/lang en');

            assert.equal((await readChannel())?.language, 'ua');
            assert.equal((await readPlayerLanguage(77))?.language, 'en');
        });

        it('still denies a group /lang to a non-admin and leaves the language unchanged', async () => {
            await send(77, '/start');
            const languageBefore = (await readChannel())?.language;
            apiCalls.length = 0;

            await send(nonAdminUserId, '/lang en', { entityLength: 5 });

            assert.equal(countSendMessageCalls(), 1);
            assert.ok(
                readLastReplyText().includes(
                    getMessages().accessDenied({ name: 'Ann' })
                )
            );
            assert.equal((await readChannel())?.language, languageBefore);
            assert.equal(
                (await readPlayerLanguage(nonAdminUserId))?.language ?? null,
                null
            );
        });

        it('lets a group admin change the group language as before', async () => {
            await send(77, '/start');
            apiCalls.length = 0;

            await send(77, '/lang en', { entityLength: 5 });

            assert.equal(
                readLastReplyText(),
                getMessages('en').lang.updated({ language: 'en' })
            );
            assert.equal((await readChannel())?.language, 'en');
            assert.equal(
                (await readPlayerLanguage(77))?.language ?? null,
                null
            );
        });
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
