import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyBotAdminStatus,
    readBotStateSnapshot,
    refreshBotAdminStatuses
} from '../src/worker/scheduled/bot-state-snapshot';
import {
    createD1Harness,
    seedGeneratedPlayers
} from './integration/d1-harness';

test('bot admin status classifies Telegram administrator and creator roles', () => {
    assert.equal(classifyBotAdminStatus({ status: 'administrator' }), 'admin');
    assert.equal(classifyBotAdminStatus({ status: 'creator' }), 'admin');
    assert.equal(classifyBotAdminStatus({ status: 'member' }), 'nonAdmin');
    assert.equal(classifyBotAdminStatus({ status: 'left' }), 'nonAdmin');
});

test('bot state snapshot counts active people and fresh admin adoption without exporting identities', async () => {
    const harness = await createD1Harness();

    try {
        await harness.applyMigrations();
        await seedGeneratedPlayers(harness, 3);
        await harness.env.DB.prepare(
            `INSERT INTO channels
                (telegram_chat_id, language, release_version, last_vote_at, bot_admin_status, bot_admin_checked_at, created_at)
             VALUES (101, 'en', 'test', 1700000000000, 'admin', 1700086400000, 0),
                    (102, 'en', 'test', 1700172800000, 'nonAdmin', 1699913600000, 0),
                    (103, 'en', 'test', NULL, 'unavailable', 1700086400000, 0),
                    (104, 'en', 'test', NULL, 'admin', 1699827200000, 0)`
        ).run();
        await harness.env.DB.prepare(
            `INSERT INTO channel_members
                (channel_id, player_id, score, is_active, is_auto_joined, created_at, updated_at)
             VALUES (1, 1, 7, 1, 0, 0, 0),
                    (1, 2, 3, 1, 0, 0, 0),
                    (2, 1, 4, 1, 0, 0, 0),
                    (2, 3, 99, 0, 0, 0, 0)`
        ).run();

        assert.deepEqual(
            await readBotStateSnapshot(
                harness.env,
                new Date(1700000000000 + 24 * 60 * 60 * 1000)
            ),
            {
                registeredChats: 4,
                adminChats: 1,
                nonAdminChats: 1,
                unknownAdminChats: 2,
                activeChats: 2,
                activeUsers: 2,
                activeMemberships: 3,
                recentlyVotingChats: 1,
                topScore: 7
            }
        );
    } finally {
        await harness.dispose();
    }
});

test('bot admin refresh checks at most ten stale groups with one bot lookup', async () => {
    const harness = await createD1Harness();

    try {
        await harness.applyMigrations();
        await harness.env.DB.prepare(
            `INSERT INTO channels
                (telegram_chat_id, language, release_version, created_at)
             VALUES ${Array.from({ length: 11 }, (_, index) => {
                 return `(${index + 1}, 'en', 'test', 0)`;
             }).join(', ')}`
        ).run();

        let getMeCalls = 0;
        const checkedChatIds: number[] = [];
        await refreshBotAdminStatuses(harness.env, new Date(1700086400000), {
            createTelegram() {
                return {
                    async getMe() {
                        getMeCalls += 1;
                        return {
                            id: 900,
                            is_bot: true,
                            first_name: 'Princess'
                        };
                    },
                    async getChatMember(chatId) {
                        checkedChatIds.push(Number(chatId));

                        if (chatId === 3) {
                            throw new Error('Telegram API failure');
                        }

                        return {
                            status:
                                Number(chatId) % 2 === 0
                                    ? 'administrator'
                                    : 'member'
                        };
                    }
                };
            }
        });

        const { results } = await harness.env.DB.prepare(
            'SELECT telegram_chat_id, bot_admin_status, bot_admin_checked_at FROM channels ORDER BY telegram_chat_id'
        ).all<{
            telegram_chat_id: number;
            bot_admin_status: string | null;
            bot_admin_checked_at: number | null;
        }>();

        assert.equal(getMeCalls, 1);
        assert.deepEqual(checkedChatIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert.deepEqual(
            results.map(row => row.bot_admin_status),
            [
                'nonAdmin',
                'admin',
                'unavailable',
                'admin',
                'nonAdmin',
                'admin',
                'nonAdmin',
                'admin',
                'nonAdmin',
                'admin',
                null
            ]
        );
        assert.ok(
            results.slice(0, 10).every(row => {
                return row.bot_admin_checked_at === 1700086400000;
            })
        );
        assert.equal(results[10]?.bot_admin_checked_at, null);
    } finally {
        await harness.dispose();
    }
});
