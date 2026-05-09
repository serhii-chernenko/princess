import { eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { players } from '../schema';

const try_db = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => {
            return execute();
        },
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
        deletePlayer(playerId: number) {
            return try_db(() => {
                return db.delete(players).where(eq(players.id, playerId));
            });
        }
    };
};
