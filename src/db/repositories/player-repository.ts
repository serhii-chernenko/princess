import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { channelMembers, players } from '../schema';

export const d1BoundParameterSafetyLimit = 90;

export const chunkPlayerIdsForD1 = (
    candidatePlayerIds: number[]
): number[][] => {
    const uniquePlayerIds = Array.from(new Set(candidatePlayerIds));
    const playerIdChunks: number[][] = [];

    for (
        let index = 0;
        index < uniquePlayerIds.length;
        index += d1BoundParameterSafetyLimit
    ) {
        playerIdChunks.push(
            uniquePlayerIds.slice(index, index + d1BoundParameterSafetyLimit)
        );
    }

    return playerIdChunks;
};

const try_db = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: cause => {
            return new Error(`Player repository failure: ${String(cause)}`);
        }
    });
};

export const createPlayerRepository = (db: AppDb) => {
    return {
        createPlayer(telegramUserId: number, displayName: string) {
            return try_db(async () => {
                const [player] = await db
                    .insert(players)
                    .values({
                        telegramUserId,
                        displayName
                    })
                    .returning();

                return player ?? null;
            });
        },
        findPlayerByTelegramUserId(telegramUserId: number) {
            return try_db(async () => {
                const [player] = await db
                    .select()
                    .from(players)
                    .where(eq(players.telegramUserId, telegramUserId))
                    .limit(1);

                return player ?? null;
            });
        },
        updateDisplayName(playerId: number, displayName: string) {
            return try_db(() => {
                return db
                    .update(players)
                    .set({
                        displayName,
                        updatedAt: new Date()
                    })
                    .where(eq(players.id, playerId));
            });
        },
        countPlayers() {
            return try_db(async () => {
                const [result] = await db
                    .select({
                        count: sql<number>`count(*)`
                    })
                    .from(players);

                return Number(result?.count ?? 0);
            });
        },
        deleteOrphanedPlayers(candidatePlayerIds: number[]) {
            return try_db(async () => {
                let deletedPlayerCount = 0;

                for (const playerIdChunk of chunkPlayerIdsForD1(
                    candidatePlayerIds
                )) {
                    const deletedPlayers = await db
                        .delete(players)
                        .where(
                            and(
                                inArray(players.id, playerIdChunk),
                                notExists(
                                    db
                                        .select({
                                            playerId: channelMembers.playerId
                                        })
                                        .from(channelMembers)
                                        .where(
                                            eq(
                                                channelMembers.playerId,
                                                players.id
                                            )
                                        )
                                )
                            )
                        )
                        .returning({
                            id: players.id
                        });

                    deletedPlayerCount += deletedPlayers.length;
                }

                return deletedPlayerCount;
            });
        }
    };
};
