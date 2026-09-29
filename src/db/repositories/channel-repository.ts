import { and, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { channelMembers, channels } from '../schema';

const try_db = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: cause => {
            return new Error(`Channel repository failure: ${String(cause)}`);
        }
    });
};

const getInactiveChannelCondition = (cutoff: Date) => {
    return and(isNotNull(channels.lastVoteAt), lt(channels.lastVoteAt, cutoff));
};

const getLastVoteAtCondition = (lastVoteAt: Date | null) => {
    if (lastVoteAt === null) {
        return isNull(channels.lastVoteAt);
    }

    return eq(channels.lastVoteAt, lastVoteAt);
};

export const createChannelRepository = (db: AppDb) => {
    return {
        createChannel(
            telegramChatId: number,
            releaseVersion: string,
            language = 'ua'
        ) {
            return try_db(async () => {
                const [channel] = await db
                    .insert(channels)
                    .values({
                        telegramChatId,
                        language,
                        releaseVersion
                    })
                    .returning();

                return channel ?? null;
            });
        },
        findChannelByTelegramChatId(telegramChatId: number) {
            return try_db(async () => {
                const [channel] = await db
                    .select()
                    .from(channels)
                    .where(eq(channels.telegramChatId, telegramChatId))
                    .limit(1);

                return channel ?? null;
            });
        },
        listChannelsWithOutdatedRelease(currentReleaseVersion: string) {
            return try_db(() => {
                return db
                    .select()
                    .from(channels)
                    .where(ne(channels.releaseVersion, currentReleaseVersion));
            });
        },
        markChannelRelease(telegramChatId: number, releaseVersion: string) {
            return try_db(() => {
                return db
                    .update(channels)
                    .set({
                        releaseVersion
                    })
                    .where(eq(channels.telegramChatId, telegramChatId));
            });
        },
        updateChannelLanguage(telegramChatId: number, language: string) {
            return try_db(() => {
                return db
                    .update(channels)
                    .set({
                        language
                    })
                    .where(eq(channels.telegramChatId, telegramChatId));
            });
        },
        touchChannelRun(channelId: number, lastVoteAt: Date) {
            return try_db(() => {
                return db
                    .update(channels)
                    .set({
                        lastVoteAt
                    })
                    .where(eq(channels.id, channelId));
            });
        },
        claimChannelRun(
            channelId: number,
            expectedLastVoteAt: Date | null,
            claimedLastVoteAt: Date
        ) {
            return try_db(async () => {
                const [channel] = await db
                    .update(channels)
                    .set({
                        lastVoteAt: claimedLastVoteAt
                    })
                    .where(
                        and(
                            eq(channels.id, channelId),
                            getLastVoteAtCondition(expectedLastVoteAt)
                        )
                    )
                    .returning();

                return channel ?? null;
            });
        },
        restoreClaimedChannelRun(
            channelId: number,
            claimedLastVoteAt: Date,
            previousLastVoteAt: Date | null
        ) {
            return try_db(async () => {
                const [channel] = await db
                    .update(channels)
                    .set({
                        lastVoteAt: previousLastVoteAt
                    })
                    .where(
                        and(
                            eq(channels.id, channelId),
                            eq(channels.lastVoteAt, claimedLastVoteAt)
                        )
                    )
                    .returning();

                return channel ?? null;
            });
        },
        resetChannelRun(channelId: number) {
            return try_db(() => {
                return db
                    .update(channels)
                    .set({
                        lastVoteAt: null
                    })
                    .where(eq(channels.id, channelId));
            });
        },
        countChannels() {
            return try_db(async () => {
                const [result] = await db
                    .select({
                        count: sql<number>`count(*)`
                    })
                    .from(channels);

                return Number(result?.count ?? 0);
            });
        },
        findInactiveChannelPlayerIds(cutoff: Date) {
            return try_db(() => {
                return db
                    .selectDistinct({
                        playerId: channelMembers.playerId
                    })
                    .from(channelMembers)
                    .innerJoin(
                        channels,
                        eq(channelMembers.channelId, channels.id)
                    )
                    .where(getInactiveChannelCondition(cutoff));
            });
        },
        deleteInactiveChannels(cutoff: Date) {
            return try_db(() => {
                return db
                    .delete(channels)
                    .where(getInactiveChannelCondition(cutoff))
                    .returning({
                        id: channels.id
                    });
            });
        },
        deleteChannel(channelId: number) {
            return try_db(() => {
                return db.delete(channels).where(eq(channels.id, channelId));
            });
        },
        listChannelMembers(channelId: number) {
            return try_db(() => {
                return db
                    .select()
                    .from(channelMembers)
                    .where(eq(channelMembers.channelId, channelId));
            });
        }
    };
};
