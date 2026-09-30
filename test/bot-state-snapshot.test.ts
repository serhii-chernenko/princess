import assert from 'node:assert/strict';
import test from 'node:test';

import { readBotStateSnapshot } from '../src/worker/scheduled/bot-state-snapshot';
import {
    createD1Harness,
    seedGeneratedPlayers
} from './integration/d1-harness';

test('bot state snapshot counts active people and chats without exporting identities', async () => {
    const harness = await createD1Harness();

    try {
        await harness.applyMigrations();
        await seedGeneratedPlayers(harness, 3);
        await harness.env.DB.prepare(
            `INSERT INTO channels
                (telegram_chat_id, language, release_version, last_vote_at, created_at)
             VALUES (101, 'en', 'test', 1700000000000, 0),
                    (102, 'en', 'test', 1700172800000, 0),
                    (103, 'en', 'test', NULL, 0)`
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
                registeredChats: 3,
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
