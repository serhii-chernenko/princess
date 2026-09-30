import {
    and,
    count,
    countDistinct,
    eq,
    gte,
    isNull,
    lt,
    lte,
    max,
    or
} from 'drizzle-orm';
import { Telegram } from 'telegraf';

import { createDb } from '../../db/client';
import { channelMembers, channels } from '../../db/schema';
import type { WorkerBindings } from '../env';

export interface BotStateSnapshot {
    registeredChats: number;
    adminChats: number;
    nonAdminChats: number;
    unknownAdminChats: number;
    activeChats: number;
    activeUsers: number;
    activeMemberships: number;
    recentlyVotingChats: number;
    topScore: number;
}

export type BotAdminStatus = 'admin' | 'nonAdmin' | 'unavailable';

export const botAdminStatusRefreshMilliseconds = 24 * 60 * 60 * 1000;
const botAdminStatusSnapshotFreshnessMilliseconds = 48 * 60 * 60 * 1000;
const botAdminStatusRefreshLimit = 10;

export const classifyBotAdminStatus = (member: { status: string }) => {
    return member.status === 'administrator' || member.status === 'creator'
        ? 'admin'
        : 'nonAdmin';
};

interface TelegramBotAdminApi {
    getMe(): Promise<{ id: number }>;
    getChatMember(
        chatId: string | number,
        userId: number
    ): Promise<{ status: string }>;
}

interface BotAdminStatusDependencies {
    createTelegram?: (token: string) => TelegramBotAdminApi;
}

/** Refresh a bounded number of group bot permissions without exporting Telegram identities. */
export const refreshBotAdminStatuses = async (
    env: WorkerBindings,
    asOf: Date,
    dependencies: BotAdminStatusDependencies = {}
) => {
    const db = createDb(env);
    const staleBefore = new Date(
        asOf.getTime() - botAdminStatusRefreshMilliseconds
    );
    const candidates = await db
        .select({
            id: channels.id,
            telegramChatId: channels.telegramChatId
        })
        .from(channels)
        .where(
            or(
                isNull(channels.botAdminCheckedAt),
                lt(channels.botAdminCheckedAt, staleBefore)
            )
        )
        .orderBy(channels.botAdminCheckedAt, channels.id)
        .limit(botAdminStatusRefreshLimit);

    if (candidates.length === 0) {
        return;
    }

    const createTelegram =
        dependencies.createTelegram ??
        (token => {
            return new Telegram(token);
        });
    const telegram = createTelegram(env.BOT_TOKEN);
    let botId: number | null = null;

    try {
        botId = (await telegram.getMe()).id;
    } catch {
        // The unavailable state is recorded below without retaining failure details.
    }

    for (const candidate of candidates) {
        let botAdminStatus: BotAdminStatus = 'unavailable';

        if (botId !== null) {
            try {
                botAdminStatus = classifyBotAdminStatus(
                    await telegram.getChatMember(
                        candidate.telegramChatId,
                        botId
                    )
                );
            } catch {
                // Telegram errors are intentionally represented only by the aggregate state.
            }
        }

        await db
            .update(channels)
            .set({ botAdminStatus, botAdminCheckedAt: asOf })
            .where(eq(channels.id, candidate.id));
    }
};

/** Aggregate only; Telegram identities and display names never leave D1. */
export const readBotStateSnapshot = async (
    env: WorkerBindings,
    asOf: Date
): Promise<BotStateSnapshot> => {
    const db = createDb(env);
    const adminStatusFreshAfter = new Date(
        asOf.getTime() - botAdminStatusSnapshotFreshnessMilliseconds
    );
    const [registered, admin, nonAdmin, active, recentlyVoting] =
        await Promise.all([
            db.select({ value: count() }).from(channels),
            db
                .select({ value: count() })
                .from(channels)
                .where(
                    and(
                        eq(channels.botAdminStatus, 'admin'),
                        gte(channels.botAdminCheckedAt, adminStatusFreshAfter),
                        lte(channels.botAdminCheckedAt, asOf)
                    )
                ),
            db
                .select({ value: count() })
                .from(channels)
                .where(
                    and(
                        eq(channels.botAdminStatus, 'nonAdmin'),
                        gte(channels.botAdminCheckedAt, adminStatusFreshAfter),
                        lte(channels.botAdminCheckedAt, asOf)
                    )
                ),
            db
                .select({
                    activeChats: countDistinct(channelMembers.channelId),
                    activeUsers: countDistinct(channelMembers.playerId),
                    activeMemberships: count(),
                    topScore: max(channelMembers.score)
                })
                .from(channelMembers)
                .where(eq(channelMembers.isActive, true)),
            db
                .select({ value: count() })
                .from(channels)
                .where(
                    and(
                        gte(
                            channels.lastVoteAt,
                            new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000)
                        ),
                        lte(channels.lastVoteAt, asOf)
                    )
                )
        ]);

    return {
        registeredChats: registered[0]?.value ?? 0,
        adminChats: admin[0]?.value ?? 0,
        nonAdminChats: nonAdmin[0]?.value ?? 0,
        unknownAdminChats:
            (registered[0]?.value ?? 0) -
            (admin[0]?.value ?? 0) -
            (nonAdmin[0]?.value ?? 0),
        activeChats: active[0]?.activeChats ?? 0,
        activeUsers: active[0]?.activeUsers ?? 0,
        activeMemberships: active[0]?.activeMemberships ?? 0,
        recentlyVotingChats: recentlyVoting[0]?.value ?? 0,
        topScore: active[0]?.topScore ?? 0
    };
};
