import { and, count, countDistinct, eq, gte, lte, max } from 'drizzle-orm';

import { createDb } from '../../db/client';
import { channelMembers, channels } from '../../db/schema';
import type { WorkerBindings } from '../env';

export interface BotStateSnapshot {
    registeredChats: number;
    activeChats: number;
    activeUsers: number;
    activeMemberships: number;
    recentlyVotingChats: number;
    topScore: number;
}

/** Aggregate only; Telegram identities and display names never leave D1. */
export const readBotStateSnapshot = async (
    env: WorkerBindings,
    asOf: Date
): Promise<BotStateSnapshot> => {
    const db = createDb(env);
    const [registered, active, recentlyVoting] = await Promise.all([
        db.select({ value: count() }).from(channels),
        db
            .select({
                activeChats: countDistinct(channelMembers.channelId),
                activeUsers: countDistinct(channelMembers.playerId),
                activeMemberships: count(),
                topScore: max(channelMembers.score)
            })
            .from(channelMembers)
            .where(eq(channelMembers.isActive, true)),
        db
            .select({ value: count() })
            .from(channels)
            .where(
                and(
                    gte(
                        channels.lastVoteAt,
                        new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000)
                    ),
                    lte(channels.lastVoteAt, asOf)
                )
            )
    ]);

    return {
        registeredChats: registered[0]?.value ?? 0,
        activeChats: active[0]?.activeChats ?? 0,
        activeUsers: active[0]?.activeUsers ?? 0,
        activeMemberships: active[0]?.activeMemberships ?? 0,
        recentlyVotingChats: recentlyVoting[0]?.value ?? 0,
        topScore: active[0]?.topScore ?? 0
    };
};
