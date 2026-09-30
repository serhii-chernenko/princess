import { Effect } from 'effect';

import type { AppDb } from '../client';
import { voteWins } from '../schema';

type NewVoteWin = Pick<
    typeof voteWins.$inferInsert,
    'channelId' | 'playerId' | 'wonAt' | 'mode' | 'eligibleCount'
>;

export const createVoteWinRepository = (db: AppDb) => {
    return {
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
