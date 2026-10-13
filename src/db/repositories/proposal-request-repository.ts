import { and, eq, gte, lt } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AppDb } from '../client';
import { proposalRequests } from '../schema';

export const proposalTtlMinutes = 15;
export const proposalTtlMilliseconds = proposalTtlMinutes * 60 * 1000;

interface ProposalRequestKey {
    chatId: number;
    userId: number;
}

interface SaveProposalRequestInput extends ProposalRequestKey {
    promptMessageId: number;
    createdAt: Date;
}

const tryDb = <A>(execute: () => Promise<A>) => {
    return Effect.tryPromise({
        try: () => execute(),
        catch: cause => {
            return new Error(
                `Proposal request repository failure: ${String(cause)}`
            );
        }
    });
};

const getKeyCondition = ({ chatId, userId }: ProposalRequestKey) => {
    return and(
        eq(proposalRequests.chatId, chatId),
        eq(proposalRequests.userId, userId)
    );
};

interface ClaimProposalRequestInput extends ProposalRequestKey {
    promptMessageId: number;
    createdAfter: Date;
}

export const createProposalRequestRepository = (db: AppDb) => {
    return {
        saveRequest(input: SaveProposalRequestInput) {
            return tryDb(async () => {
                await db
                    .insert(proposalRequests)
                    .values(input)
                    .onConflictDoUpdate({
                        target: [
                            proposalRequests.chatId,
                            proposalRequests.userId
                        ],
                        set: {
                            promptMessageId: input.promptMessageId,
                            createdAt: input.createdAt
                        }
                    });
            });
        },
        replacePrompt(key: ProposalRequestKey, promptMessageId: number) {
            return tryDb(async () => {
                await db
                    .update(proposalRequests)
                    .set({ promptMessageId })
                    .where(getKeyCondition(key));
            });
        },
        claimRequest({
            chatId,
            userId,
            promptMessageId,
            createdAfter
        }: ClaimProposalRequestInput) {
            return tryDb(async () => {
                const [claimed] = await db
                    .delete(proposalRequests)
                    .where(
                        and(
                            getKeyCondition({ chatId, userId }),
                            eq(
                                proposalRequests.promptMessageId,
                                promptMessageId
                            ),
                            gte(proposalRequests.createdAt, createdAfter)
                        )
                    )
                    .returning();

                return claimed ?? null;
            });
        },
        findRequest(key: ProposalRequestKey) {
            return tryDb(async () => {
                const [request] = await db
                    .select()
                    .from(proposalRequests)
                    .where(getKeyCondition(key))
                    .limit(1);

                return request ?? null;
            });
        },
        deleteRequest(key: ProposalRequestKey) {
            return tryDb(async () => {
                await db.delete(proposalRequests).where(getKeyCondition(key));
            });
        },
        deleteCreatedBefore(createdBefore: Date) {
            return tryDb(async () => {
                const deleted = await db
                    .delete(proposalRequests)
                    .where(lt(proposalRequests.createdAt, createdBefore))
                    .returning({ id: proposalRequests.id });

                return deleted.length;
            });
        }
    };
};
