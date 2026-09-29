import { and, eq, inArray, lt, ne, notExists, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { channels, releaseAnnouncements } from '../schema';

export const D1_BOUND_PARAMETER_CEILING = 100;

export const RELEASE_ANNOUNCEMENT_INSERT_COLUMN_COUNT = 6;
export const RELEASE_ANNOUNCEMENT_INSERT_CHUNK_SIZE = Math.floor(
    D1_BOUND_PARAMETER_CEILING / RELEASE_ANNOUNCEMENT_INSERT_COLUMN_COUNT
);
const deleteChunkSize = D1_BOUND_PARAMETER_CEILING - 10;

const tryDb = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: cause => {
            return new Error(
                `Release announcement repository failure: ${String(cause)}`
            );
        }
    });
};

const chunk = <T>(items: readonly T[], size: number) => {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
};

export const createReleaseAnnouncementRepository = (db: AppDb) => {
    return {
        listChannelsWithoutAnnouncement(releaseVersion: string) {
            return tryDb(() => {
                return db
                    .select({
                        id: channels.id,
                        releaseVersion: channels.releaseVersion
                    })
                    .from(channels)
                    .where(
                        and(
                            ne(channels.releaseVersion, releaseVersion),
                            notExists(
                                db
                                    .select({ one: sql`1` })
                                    .from(releaseAnnouncements)
                                    .where(
                                        and(
                                            eq(
                                                releaseAnnouncements.channelId,
                                                channels.id
                                            ),
                                            eq(
                                                releaseAnnouncements.releaseVersion,
                                                releaseVersion
                                            )
                                        )
                                    )
                            )
                        )
                    );
            });
        },
        insertQueuedAnnouncements(
            releaseVersion: string,
            channelIds: readonly number[],
            now: Date
        ) {
            return tryDb(async () => {
                const insertedChannelIds: number[] = [];

                for (const channelIdChunk of chunk(
                    channelIds,
                    RELEASE_ANNOUNCEMENT_INSERT_CHUNK_SIZE
                )) {
                    const inserted = await db
                        .insert(releaseAnnouncements)
                        .values(
                            channelIdChunk.map(channelId => {
                                return {
                                    releaseVersion,
                                    channelId,
                                    status: 'queued' as const,
                                    attempts: 0,
                                    createdAt: now,
                                    updatedAt: now
                                };
                            })
                        )
                        .onConflictDoNothing({
                            target: [
                                releaseAnnouncements.releaseVersion,
                                releaseAnnouncements.channelId
                            ]
                        })
                        .returning({
                            channelId: releaseAnnouncements.channelId
                        });

                    insertedChannelIds.push(
                        ...inserted.map(row => {
                            return row.channelId;
                        })
                    );
                }

                return insertedChannelIds;
            });
        },
        deleteQueuedAnnouncements(
            releaseVersion: string,
            channelIds: readonly number[]
        ) {
            return tryDb(async () => {
                for (const channelIdChunk of chunk(
                    channelIds,
                    deleteChunkSize
                )) {
                    await db
                        .delete(releaseAnnouncements)
                        .where(
                            and(
                                eq(
                                    releaseAnnouncements.releaseVersion,
                                    releaseVersion
                                ),
                                eq(releaseAnnouncements.status, 'queued'),
                                inArray(
                                    releaseAnnouncements.channelId,
                                    channelIdChunk
                                )
                            )
                        );
                }
            });
        },
        findAnnouncement(releaseVersion: string, channelId: number) {
            return tryDb(async () => {
                const [announcement] = await db
                    .select()
                    .from(releaseAnnouncements)
                    .where(
                        and(
                            eq(
                                releaseAnnouncements.releaseVersion,
                                releaseVersion
                            ),
                            eq(releaseAnnouncements.channelId, channelId)
                        )
                    )
                    .limit(1);

                return announcement ?? null;
            });
        },
        markSent(
            announcementId: number,
            channelId: number,
            releaseVersion: string,
            now: Date
        ) {
            return tryDb(() => {
                return db.batch([
                    db
                        .update(releaseAnnouncements)
                        .set({
                            status: 'sent',
                            attempts: sql`${releaseAnnouncements.attempts} + 1`,
                            lastErrorCode: null,
                            updatedAt: now
                        })
                        .where(eq(releaseAnnouncements.id, announcementId)),
                    db
                        .update(channels)
                        .set({ releaseVersion })
                        .where(eq(channels.id, channelId))
                ]);
            });
        },
        claimForSending(announcementId: number, now: Date) {
            return tryDb(async () => {
                const claimed = await db
                    .update(releaseAnnouncements)
                    .set({ status: 'sending', updatedAt: now })
                    .where(
                        and(
                            eq(releaseAnnouncements.id, announcementId),
                            eq(releaseAnnouncements.status, 'queued')
                        )
                    )
                    .returning({ id: releaseAnnouncements.id });

                return claimed.length > 0;
            });
        },
        markSkipped(
            announcementId: number,
            channelId: number,
            releaseVersion: string,
            errorCode: number | null,
            now: Date
        ) {
            return tryDb(() => {
                return db.batch([
                    db
                        .update(releaseAnnouncements)
                        .set({
                            status: 'skipped',
                            attempts: sql`${releaseAnnouncements.attempts} + 1`,
                            lastErrorCode: errorCode,
                            updatedAt: now
                        })
                        .where(eq(releaseAnnouncements.id, announcementId)),
                    db
                        .update(channels)
                        .set({ releaseVersion })
                        .where(eq(channels.id, channelId))
                ]);
            });
        },
        releaseToQueue(
            announcementId: number,
            errorCode: number | null,
            countAttempt: boolean,
            now: Date
        ) {
            return tryDb(() => {
                return db
                    .update(releaseAnnouncements)
                    .set({
                        status: 'queued',
                        attempts: countAttempt
                            ? sql`${releaseAnnouncements.attempts} + 1`
                            : releaseAnnouncements.attempts,
                        lastErrorCode: errorCode,
                        updatedAt: now
                    })
                    .where(eq(releaseAnnouncements.id, announcementId));
            });
        },
        markFailed(
            announcementId: number,
            errorCode: number | null,
            now: Date
        ) {
            return tryDb(() => {
                return db
                    .update(releaseAnnouncements)
                    .set({
                        status: 'failed',
                        attempts: sql`${releaseAnnouncements.attempts} + 1`,
                        lastErrorCode: errorCode,
                        updatedAt: now
                    })
                    .where(eq(releaseAnnouncements.id, announcementId));
            });
        },
        migrateChannelChatId(channelId: number, newTelegramChatId: number) {
            return tryDb(async () => {
                const migrated = await db
                    .update(channels)
                    .set({ telegramChatId: newTelegramChatId })
                    .where(
                        and(
                            eq(channels.id, channelId),
                            notExists(
                                db
                                    .select({ one: sql`1` })
                                    .from(channels)
                                    .where(
                                        eq(
                                            channels.telegramChatId,
                                            newTelegramChatId
                                        )
                                    )
                            )
                        )
                    )
                    .returning({ id: channels.id });

                return migrated.length > 0;
            });
        },
        requeueStaleQueued(releaseVersion: string, cutoff: Date, now: Date) {
            return tryDb(async () => {
                const requeued = await db
                    .update(releaseAnnouncements)
                    .set({ updatedAt: now })
                    .where(
                        and(
                            eq(
                                releaseAnnouncements.releaseVersion,
                                releaseVersion
                            ),
                            eq(releaseAnnouncements.status, 'queued'),
                            lt(releaseAnnouncements.updatedAt, cutoff)
                        )
                    )
                    .returning({ channelId: releaseAnnouncements.channelId });

                return requeued.map(row => {
                    return row.channelId;
                });
            });
        },
        skipStuckSending(releaseVersion: string, cutoff: Date, now: Date) {
            return tryDb(async () => {
                const stuck = await db
                    .select({ channelId: releaseAnnouncements.channelId })
                    .from(releaseAnnouncements)
                    .where(
                        and(
                            eq(
                                releaseAnnouncements.releaseVersion,
                                releaseVersion
                            ),
                            eq(releaseAnnouncements.status, 'sending'),
                            lt(releaseAnnouncements.updatedAt, cutoff)
                        )
                    );
                const stuckChannelIds = stuck.map(row => {
                    return row.channelId;
                });

                for (const channelIdChunk of chunk(
                    stuckChannelIds,
                    deleteChunkSize
                )) {
                    await db.batch([
                        db
                            .update(releaseAnnouncements)
                            .set({
                                status: 'skipped',
                                attempts: sql`${releaseAnnouncements.attempts} + 1`,
                                lastErrorCode: null,
                                updatedAt: now
                            })
                            .where(
                                and(
                                    eq(
                                        releaseAnnouncements.releaseVersion,
                                        releaseVersion
                                    ),
                                    eq(releaseAnnouncements.status, 'sending'),
                                    inArray(
                                        releaseAnnouncements.channelId,
                                        channelIdChunk
                                    )
                                )
                            ),
                        db
                            .update(channels)
                            .set({ releaseVersion })
                            .where(inArray(channels.id, channelIdChunk))
                    ]);
                }

                return stuckChannelIds.length;
            });
        }
    };
};
