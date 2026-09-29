import { and, eq, lt } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { telegramUpdates } from '../schema';

export const telegramUpdateLeaseMilliseconds = 5 * 60 * 1000;
export const telegramUpdateRetentionMilliseconds = 7 * 24 * 60 * 60 * 1000;
export const telegramAbandonedUpdateRetentionMilliseconds = 24 * 60 * 60 * 1000;

export type TelegramUpdateClaim =
    | {
          state: 'claimed';
          leaseId: string;
          reclaimed: boolean;
      }
    | {
          state: 'duplicate';
      }
    | {
          state: 'busy';
      };

const tryDb = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: cause => {
            return new Error(
                `Telegram update repository failure: ${String(cause)}`
            );
        }
    });
};

const getUpdateCondition = (botKey: string, updateId: number) => {
    return and(
        eq(telegramUpdates.botKey, botKey),
        eq(telegramUpdates.updateId, updateId)
    );
};

export const createTelegramUpdateRepository = (db: AppDb) => {
    return {
        claimUpdate(
            botKey: string,
            updateId: number,
            leaseId: string,
            startedAt: Date
        ) {
            return tryDb(async (): Promise<TelegramUpdateClaim> => {
                const staleBefore = new Date(
                    startedAt.getTime() - telegramUpdateLeaseMilliseconds
                );

                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const [inserted] = await db
                        .insert(telegramUpdates)
                        .values({
                            botKey,
                            updateId,
                            status: 'processing',
                            leaseId,
                            startedAt,
                            processedAt: null
                        })
                        .onConflictDoNothing({
                            target: [
                                telegramUpdates.botKey,
                                telegramUpdates.updateId
                            ]
                        })
                        .returning({
                            leaseId: telegramUpdates.leaseId
                        });

                    if (inserted) {
                        return {
                            state: 'claimed',
                            leaseId,
                            reclaimed: false
                        };
                    }

                    const [reclaimed] = await db
                        .update(telegramUpdates)
                        .set({
                            leaseId,
                            startedAt,
                            processedAt: null
                        })
                        .where(
                            and(
                                getUpdateCondition(botKey, updateId),
                                eq(telegramUpdates.status, 'processing'),
                                lt(telegramUpdates.startedAt, staleBefore)
                            )
                        )
                        .returning({
                            leaseId: telegramUpdates.leaseId
                        });

                    if (reclaimed) {
                        return {
                            state: 'claimed',
                            leaseId,
                            reclaimed: true
                        };
                    }

                    const [existing] = await db
                        .select({
                            status: telegramUpdates.status
                        })
                        .from(telegramUpdates)
                        .where(getUpdateCondition(botKey, updateId))
                        .limit(1);

                    if (existing?.status === 'processed') {
                        return {
                            state: 'duplicate'
                        };
                    }

                    if (existing?.status === 'processing') {
                        return {
                            state: 'busy'
                        };
                    }
                }

                throw new Error('Update claim changed while it was acquired');
            });
        },
        terminalizeUpdate(
            botKey: string,
            updateId: number,
            leaseId: string,
            processedAt: Date
        ) {
            return tryDb(async () => {
                const [terminalized] = await db
                    .update(telegramUpdates)
                    .set({
                        status: 'processed',
                        processedAt
                    })
                    .where(
                        and(
                            getUpdateCondition(botKey, updateId),
                            eq(telegramUpdates.status, 'processing'),
                            eq(telegramUpdates.leaseId, leaseId)
                        )
                    )
                    .returning({
                        updateId: telegramUpdates.updateId
                    });
                return terminalized !== undefined;
            });
        },
        deleteProcessedBefore(processedBefore: Date) {
            return tryDb(async () => {
                const deletedUpdates = await db
                    .delete(telegramUpdates)
                    .where(
                        and(
                            eq(telegramUpdates.status, 'processed'),
                            lt(telegramUpdates.processedAt, processedBefore)
                        )
                    )
                    .returning({
                        updateId: telegramUpdates.updateId
                    });

                return deletedUpdates.length;
            });
        },
        deleteAbandonedProcessingBefore(startedBefore: Date) {
            return tryDb(async () => {
                const deletedUpdates = await db
                    .delete(telegramUpdates)
                    .where(
                        and(
                            eq(telegramUpdates.status, 'processing'),
                            lt(telegramUpdates.startedAt, startedBefore)
                        )
                    )
                    .returning({
                        updateId: telegramUpdates.updateId
                    });

                return deletedUpdates.length;
            });
        }
    };
};
