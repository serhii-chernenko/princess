import { and, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';
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
export const createChannelRepository = (db: AppDb) => {
    return {
        createChannel(telegramChatId: number, releaseVersion: string) {
            return try_db(async () => {
                const [channel] = await db
                    .insert(channels)
                    .values({
                        telegramChatId,
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
        findInactiveChannels(cutoff: Date) {
            return try_db(() => {
                return db
                    .select()
                    .from(channels)
                    .where(
                        and(
                            isNotNull(channels.lastVoteAt),
                            lt(channels.lastVoteAt, cutoff)
                        )
                    );
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
