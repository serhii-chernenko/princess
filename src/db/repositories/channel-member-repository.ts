import { and, eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { channelMembers, players } from '../schema';

const try_db = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: cause => {
            return new Error(
                `Channel member repository failure: ${String(cause)}`
            );
        }
    });
};

export const createChannelMemberRepository = (db: AppDb) => {
    return {
        createMember(channelId: number, playerId: number) {
            return try_db(async () => {
                const [member] = await db
                    .insert(channelMembers)
                    .values({
                        channelId,
                        playerId
                    })
                    .returning();

                return member ?? null;
            });
        },
        findMember(channelId: number, playerId: number) {
            return try_db(async () => {
                const [member] = await db
                    .select()
                    .from(channelMembers)
                    .where(
                        and(
                            eq(channelMembers.channelId, channelId),
                            eq(channelMembers.playerId, playerId)
                        )
                    )
                    .limit(1);

                return member ?? null;
            });
        },
        listMembersForChannel(channelId: number) {
            return try_db(() => {
                return db
                    .select({
                        member: channelMembers,
                        player: players
                    })
                    .from(channelMembers)
                    .innerJoin(players, eq(channelMembers.playerId, players.id))
                    .where(eq(channelMembers.channelId, channelId));
            });
        },
        updateMemberState(
            memberId: number,
            values: Partial<{
                isActive: boolean;
                isAutoJoined: boolean;
                score: number;
            }>
        ) {
            return try_db(() => {
                return db
                    .update(channelMembers)
                    .set({
                        ...values,
                        updatedAt: new Date()
                    })
                    .where(eq(channelMembers.id, memberId));
            });
        },
        incrementMemberScore(memberId: number) {
            return try_db(async () => {
                const [member] = await db
                    .update(channelMembers)
                    .set({
                        score: sql`${channelMembers.score} + 1`,
                        updatedAt: new Date()
                    })
                    .where(eq(channelMembers.id, memberId))
                    .returning();

                return member ?? null;
            });
        },
        resetScoresForChannel(channelId: number) {
            return try_db(() => {
                return db
                    .update(channelMembers)
                    .set({
                        score: 0,
                        updatedAt: new Date()
                    })
                    .where(eq(channelMembers.channelId, channelId));
            });
        },
        deleteMembersForChannel(channelId: number) {
            return try_db(() => {
                return db
                    .delete(channelMembers)
                    .where(eq(channelMembers.channelId, channelId));
            });
        },
        findActiveMemberWithPlayer(channelId: number, playerId: number) {
            return try_db(async () => {
                const [row] = await db
                    .select({
                        member: channelMembers,
                        player: players
                    })
                    .from(channelMembers)
                    .innerJoin(players, eq(channelMembers.playerId, players.id))
                    .where(
                        and(
                            eq(channelMembers.channelId, channelId),
                            eq(channelMembers.playerId, playerId)
                        )
                    )
                    .limit(1);

                return row ?? null;
            });
        }
    };
};
