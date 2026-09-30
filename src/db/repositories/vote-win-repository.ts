import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { players, voteWins } from '../schema';

type NewVoteWin = Pick<
    typeof voteWins.$inferInsert,
    'channelId' | 'playerId' | 'wonAt' | 'mode' | 'eligibleCount'
>;

export const createVoteWinRepository = (db: AppDb) => {
    return {
        listWinsForChannel(channelId: number) {
            return Effect.tryPromise({
                try: () => {
                    return db
                        .select({
                            win: voteWins,
                            telegramUserId: players.telegramUserId
                        })
                        .from(voteWins)
                        .innerJoin(players, eq(voteWins.playerId, players.id))
                        .where(eq(voteWins.channelId, channelId))
                        .orderBy(voteWins.wonAt, voteWins.id);
                },
                catch: cause => {
                    return new Error(
                        `Vote win repository failure: ${String(cause)}`
                    );
                }
            });
        },
        recordWin(win: NewVoteWin) {
            return Effect.tryPromise({
                try: async () => {
                    const [row] = await db
                        .insert(voteWins)
                        .values(win)
                        .returning();

                    return row ?? null;
                },
                catch: cause => {
                    return new Error(
                        `Vote win repository failure: ${String(cause)}`
                    );
                }
            });
        }
    };
};
