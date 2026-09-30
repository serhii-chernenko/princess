import { and, desc, eq, gt, lte, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Effect } from 'effect';

import {
    channelSnapshotMaxPerChat,
    type ChannelSnapshotPayload
} from '../channel-snapshot-payload';
import type { AppDb } from '../client';
import {
    channelMembers,
    channelSnapshots,
    channels,
    players,
    voteWins
} from '../schema';

const D1_BOUND_PARAMETER_CEILING = 100;

const PLAYER_INSERT_COLUMN_COUNT = 4;
const MEMBER_INSERT_BOUND_PARAMETER_COUNT = 7;
const VOTE_WIN_INSERT_BOUND_PARAMETER_COUNT = 5;

export type NewChannelSnapshot = Pick<
    typeof channelSnapshots.$inferInsert,
    'telegramChatId' | 'reason' | 'payload' | 'createdAt' | 'expiresAt'
>;

interface SnapshotWriteInput {
    channelId: number;
    snapshot: NewChannelSnapshot;
}

interface RestoreChannelInput {
    telegramChatId: number;
    payload: ChannelSnapshotPayload;
    releaseVersion: string;
    safetySnapshot: NewChannelSnapshot | null;
    now: Date;
}

const FAILURE_DETAIL_MAX_LENGTH = 200;

const toSanitizedFailure = (cause: unknown) => {
    const driverError =
        cause instanceof Error && cause.cause instanceof Error
            ? cause.cause
            : cause;
    const detail =
        driverError instanceof Error
            ? `${driverError.name}: ${driverError.message}`.slice(
                  0,
                  FAILURE_DETAIL_MAX_LENGTH
              )
            : typeof driverError;

    return new Error(`Channel snapshot repository failure: ${detail}`, {
        cause: driverError instanceof Error ? driverError : undefined
    });
};

const tryDb = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: toSanitizedFailure
    });
};

const chunkRows = <T>(rows: readonly T[], boundParametersPerRow: number) => {
    const size = Math.floor(D1_BOUND_PARAMETER_CEILING / boundParametersPerRow);
    const chunks: T[][] = [];

    for (let index = 0; index < rows.length; index += size) {
        chunks.push(rows.slice(index, index + size));
    }

    return chunks;
};

export const createChannelSnapshotRepository = (db: AppDb) => {
    const deleteExpiredStatement = (now: Date) => {
        return db
            .delete(channelSnapshots)
            .where(lte(channelSnapshots.expiresAt, now))
            .returning({ id: channelSnapshots.id });
    };

    const insertSnapshotStatements = (snapshot: NewChannelSnapshot) => {
        const newestSnapshotIds = db
            .select({ id: channelSnapshots.id })
            .from(channelSnapshots)
            .where(eq(channelSnapshots.telegramChatId, snapshot.telegramChatId))
            .orderBy(
                desc(channelSnapshots.createdAt),
                desc(channelSnapshots.id)
            )
            .limit(channelSnapshotMaxPerChat);

        return [
            db.insert(channelSnapshots).values(snapshot),
            db
                .delete(channelSnapshots)
                .where(
                    and(
                        eq(
                            channelSnapshots.telegramChatId,
                            snapshot.telegramChatId
                        ),
                        notInArray(channelSnapshots.id, newestSnapshotIds)
                    )
                )
        ] as const;
    };

    return {
        findLatestActiveSnapshot(telegramChatId: number, now: Date) {
            return tryDb(async () => {
                const [snapshot] = await db
                    .select()
                    .from(channelSnapshots)
                    .where(
                        and(
                            eq(channelSnapshots.telegramChatId, telegramChatId),
                            gt(channelSnapshots.expiresAt, now)
                        )
                    )
                    .orderBy(
                        desc(channelSnapshots.createdAt),
                        desc(channelSnapshots.id)
                    )
                    .limit(1);

                return snapshot ?? null;
            });
        },
        deleteExpiredSnapshots(now: Date) {
            return tryDb(async () => {
                const deleted = await deleteExpiredStatement(now);

                return deleted.length;
            });
        },
        resetChannelWithSnapshot({ channelId, snapshot }: SnapshotWriteInput) {
            return tryDb(() => {
                return db.batch([
                    deleteExpiredStatement(snapshot.createdAt),
                    ...insertSnapshotStatements(snapshot),
                    db
                        .update(channelMembers)
                        .set({
                            score: 0,
                            updatedAt: snapshot.createdAt
                        })
                        .where(eq(channelMembers.channelId, channelId)),
                    db
                        .update(channels)
                        .set({ lastVoteAt: null })
                        .where(eq(channels.id, channelId))
                ]);
            });
        },
        forgetChannelWithSnapshot({ channelId, snapshot }: SnapshotWriteInput) {
            return tryDb(() => {
                return db.batch([
                    deleteExpiredStatement(snapshot.createdAt),
                    ...insertSnapshotStatements(snapshot),
                    db.delete(channels).where(eq(channels.id, channelId))
                ]);
            });
        },
        restoreChannelFromSnapshot({
            telegramChatId,
            payload,
            releaseVersion,
            safetySnapshot,
            now
        }: RestoreChannelInput) {
            return tryDb(() => {
                const channelIdSubselect = sql<number>`(select ${channels.id} from ${channels} where ${channels.telegramChatId} = ${telegramChatId})`;
                const playerIdSubselect = (telegramUserId: number) => {
                    return sql<number>`(select ${players.id} from ${players} where ${players.telegramUserId} = ${telegramUserId})`;
                };
                const statements: BatchItem<'sqlite'>[] = [];

                if (safetySnapshot) {
                    statements.push(
                        ...insertSnapshotStatements(safetySnapshot)
                    );
                }

                statements.push(
                    db
                        .delete(channels)
                        .where(eq(channels.telegramChatId, telegramChatId))
                );

                for (const memberChunk of chunkRows(
                    payload.members,
                    PLAYER_INSERT_COLUMN_COUNT
                )) {
                    statements.push(
                        db
                            .insert(players)
                            .values(
                                memberChunk.map(member => {
                                    return {
                                        telegramUserId: member.telegramUserId,
                                        displayName: member.displayName,
                                        createdAt: now,
                                        updatedAt: now
                                    };
                                })
                            )
                            .onConflictDoNothing({
                                target: players.telegramUserId
                            })
                    );
                }

                statements.push(
                    db.insert(channels).values({
                        telegramChatId,
                        language: payload.channel.language,
                        releaseVersion,
                        lastVoteAt:
                            payload.channel.lastVoteAt === null
                                ? null
                                : new Date(payload.channel.lastVoteAt),
                        stoppedAt: null,
                        createdAt: new Date(payload.channel.createdAt)
                    })
                );

                for (const memberChunk of chunkRows(
                    payload.members,
                    MEMBER_INSERT_BOUND_PARAMETER_COUNT
                )) {
                    statements.push(
                        db.insert(channelMembers).values(
                            memberChunk.map(member => {
                                return {
                                    channelId: channelIdSubselect,
                                    playerId: playerIdSubselect(
                                        member.telegramUserId
                                    ),
                                    score: member.score,
                                    isActive: member.isActive,
                                    isAutoJoined: member.isAutoJoined,
                                    createdAt: new Date(member.createdAt),
                                    updatedAt: new Date(member.updatedAt)
                                };
                            })
                        )
                    );
                }

                for (const winChunk of chunkRows(
                    payload.voteWins,
                    VOTE_WIN_INSERT_BOUND_PARAMETER_COUNT
                )) {
                    statements.push(
                        db.insert(voteWins).values(
                            winChunk.map(win => {
                                return {
                                    channelId: channelIdSubselect,
                                    playerId: playerIdSubselect(
                                        win.telegramUserId
                                    ),
                                    wonAt: new Date(win.wonAt),
                                    mode: win.mode,
                                    eligibleCount: win.eligibleCount
                                };
                            })
                        )
                    );
                }

                return db.batch([deleteExpiredStatement(now), ...statements]);
            });
        }
    };
};
