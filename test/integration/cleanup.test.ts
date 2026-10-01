import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Effect } from 'effect';

import { createGameService } from '../../src/bot/services/game-service';
import {
    countRows,
    createD1Harness,
    seedGeneratedPlayers,
    type D1Harness
} from './d1-harness';

const playerCount = 250;
const sharedPlayerCount = 30;
const cutoff = new Date(1_700_000_000_000);
const staleVoteAt = cutoff.getTime() - 1000;
const freshVoteAt = cutoff.getTime() + 1000;

describe('Inactive channel cleanup on D1', () => {
    let harness: D1Harness;

    const seedChannelWithMembers = (
        telegramChatId: number,
        lastVoteAt: number | null,
        memberLimit: number
    ) => {
        return harness.env.DB.batch([
            harness.env.DB.prepare(
                "INSERT INTO channels (telegram_chat_id, release_version, last_vote_at, created_at) VALUES (?, '4.0.1', ?, 0)"
            ).bind(telegramChatId, lastVoteAt),
            harness.env.DB.prepare(
                `INSERT INTO channel_members (channel_id, player_id, created_at, updated_at)
                SELECT c.id, p.id, 0, 0
                FROM channels c, players p
                WHERE c.telegram_chat_id = ? AND p.telegram_user_id <= ?`
            ).bind(telegramChatId, memberLimit)
        ]);
    };

    before(async () => {
        harness = await createD1Harness();
        await harness.applyMigrations();
    });

    after(async () => {
        await harness.dispose();
    });

    beforeEach(async () => {
        await harness.clearApplicationTables();
        await seedGeneratedPlayers(harness, playerCount);
    });

    it('deletes stale channels, cascades members and removes only orphaned players across chunks', async () => {
        await seedChannelWithMembers(-1, staleVoteAt, playerCount);
        await seedChannelWithMembers(-2, freshVoteAt, sharedPlayerCount);
        await seedChannelWithMembers(-3, null, 5);

        const cleaned = await createGameService(
            harness.env
        ).cleanupInactiveChannels(cutoff);

        assert.equal(cleaned, 1);
        assert.equal(await countRows(harness, 'channels'), 2);
        assert.equal(
            await countRows(harness, 'channel_members'),
            sharedPlayerCount + 5
        );
        assert.equal(await countRows(harness, 'players'), sharedPlayerCount);
    });

    it('keeps paused channels even when their last vote is stale', async () => {
        await seedChannelWithMembers(-1, staleVoteAt, 5);
        await seedChannelWithMembers(-2, staleVoteAt, 5);
        await harness.env.DB.prepare(
            'UPDATE channels SET stopped_at = ? WHERE telegram_chat_id = -1'
        )
            .bind(staleVoteAt)
            .run();

        const cleaned = await createGameService(
            harness.env
        ).cleanupInactiveChannels(cutoff);
        const { results } = await harness.env.DB.prepare(
            'SELECT telegram_chat_id AS telegramChatId FROM channels'
        ).all<{ telegramChatId: number }>();

        assert.equal(cleaned, 1);
        assert.deepEqual(results, [{ telegramChatId: -1 }]);
        assert.equal(await countRows(harness, 'channel_members'), 5);
        assert.equal(await countRows(harness, 'players'), playerCount);
    });

    it('deletes orphaned players across multiple chunks and spares members', async () => {
        const memberCount = 100;

        await seedChannelWithMembers(-1, freshVoteAt, memberCount);

        const candidates = await harness.env.DB.prepare(
            'SELECT id FROM players'
        ).all<{ id: number }>();
        const deleted = await Effect.runPromise(
            harness.repositories.players.deleteOrphanedPlayers(
                candidates.results.map(candidate => candidate.id)
            )
        );

        assert.equal(candidates.results.length, playerCount);
        assert.equal(deleted, playerCount - memberCount);
        assert.equal(await countRows(harness, 'players'), memberCount);
        assert.equal(await countRows(harness, 'channel_members'), memberCount);
    });
});
