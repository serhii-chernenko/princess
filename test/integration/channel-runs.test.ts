import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Effect } from 'effect';

import { createD1Harness, type D1Harness } from './d1-harness';

const racerCount = 15;
const incrementCount = 20;

describe('Daily vote state on D1', () => {
    let harness: D1Harness;

    const createChannel = async () => {
        const channel = await Effect.runPromise(
            harness.repositories.channels.createChannel(-1001, '4.0.1')
        );

        return channel!;
    };
    const createMember = async (channelId: number) => {
        const player = await Effect.runPromise(
            harness.repositories.players.createPlayer(42, "O'Brien")
        );
        const member = await Effect.runPromise(
            harness.repositories.channelMembers.createMember(
                channelId,
                player!.id
            )
        );

        return member!;
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
    });

    it('lets exactly one concurrent claim win the first daily run', async () => {
        const channel = await createChannel();
        const claims = await Promise.all(
            Array.from({ length: racerCount }, (_, index) => {
                return Effect.runPromise(
                    harness.repositories.channels.claimChannelRun(
                        channel.id,
                        null,
                        new Date(1_800_000_000_000 + index)
                    )
                );
            })
        );
        const winners = claims.filter(claimed => claimed !== null);
        const stored = await Effect.runPromise(
            harness.repositories.channels.findChannelByTelegramChatId(-1001)
        );

        assert.equal(winners.length, 1);
        assert.equal(
            stored?.lastVoteAt?.getTime(),
            winners[0]?.lastVoteAt?.getTime()
        );
    });

    it('lets exactly one concurrent claim win against an existing timestamp and supports restore and reset', async () => {
        const channel = await createChannel();
        const previous = new Date(1_700_000_000_000);
        const channels = harness.repositories.channels;

        await Effect.runPromise(channels.touchChannelRun(channel.id, previous));

        const claims = await Promise.all(
            Array.from({ length: racerCount }, (_, index) => {
                return Effect.runPromise(
                    channels.claimChannelRun(
                        channel.id,
                        previous,
                        new Date(1_800_000_000_000 + index)
                    )
                );
            })
        );
        const winner = claims.find(claimed => claimed !== null);

        assert.equal(claims.filter(claimed => claimed !== null).length, 1);

        const restoredWithWrongClaim = await Effect.runPromise(
            channels.restoreClaimedChannelRun(channel.id, new Date(1), previous)
        );
        const restored = await Effect.runPromise(
            channels.restoreClaimedChannelRun(
                channel.id,
                winner!.lastVoteAt!,
                previous
            )
        );

        assert.equal(restoredWithWrongClaim, null);
        assert.equal(restored?.lastVoteAt?.getTime(), previous.getTime());

        await Effect.runPromise(channels.resetChannelRun(channel.id));
        const reset = await Effect.runPromise(
            channels.findChannelByTelegramChatId(-1001)
        );

        assert.equal(reset?.lastVoteAt, null);
    });

    it('applies concurrent score increments atomically', async () => {
        const channel = await createChannel();
        const member = await createMember(channel.id);

        await Promise.all(
            Array.from({ length: incrementCount }, () => {
                return Effect.runPromise(
                    harness.repositories.channelMembers.incrementMemberScore(
                        member.id
                    )
                );
            })
        );

        const stored = await Effect.runPromise(
            harness.repositories.channelMembers.findMember(
                channel.id,
                member.playerId
            )
        );

        assert.equal(stored?.score, incrementCount);
    });

    it('enforces the non-negative score constraint and duplicate membership uniqueness', async () => {
        const channel = await createChannel();
        const member = await createMember(channel.id);
        const members = harness.repositories.channelMembers;

        await assert.rejects(
            Effect.runPromise(
                members.updateMemberState(member.id, { score: -1 })
            ),
            /Failed query/
        );
        await assert.rejects(
            Effect.runPromise(
                members.createMember(channel.id, member.playerId)
            ),
            /Failed query/
        );

        const stored = await Effect.runPromise(
            members.findMember(channel.id, member.playerId)
        );

        assert.equal(stored?.score, 0);
    });
});
