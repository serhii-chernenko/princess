import { Effect } from 'effect';

import { createGameService } from '../../bot/services/game-service';
import { createDb } from '../../db/client';
import { createRepositories } from '../../db/repositories';
import {
    telegramAbandonedUpdateRetentionMilliseconds,
    telegramUpdateRetentionMilliseconds
} from '../../db/repositories/telegram-update-repository';
import type { WorkerBindings } from '../env';
import { emitTelemetryEvent } from '../telemetry';
import {
    refreshBotAdminStatuses,
    readBotStateSnapshot,
    type BotStateSnapshot
} from './bot-state-snapshot';
import { runReleaseBroadcast } from './release-broadcast';

const TASKS = {
    cleanup: 'maintenance:cleanup',
    releases: 'maintenance:releases',
    releaseBroadcast: 'release:broadcast'
} as const;

const DAILY_CRON = '0 0 * * *';
export const RELEASE_BROADCAST_CRON = '*/10 * * * *';

const getScheduledTaskNames = (cron: string): string[] => {
    if (cron === RELEASE_BROADCAST_CRON) {
        return [TASKS.releaseBroadcast];
    }

    if (cron === DAILY_CRON) {
        return [TASKS.cleanup, TASKS.releases];
    }

    return [TASKS.cleanup];
};

interface ScheduledTaskDependencies {
    broadcastRelease?: (env: WorkerBindings) => Promise<unknown>;
    cleanupInactiveChannels?: (
        env: WorkerBindings,
        inactiveSince: Date
    ) => Promise<number>;
    pruneProcessedTelegramUpdates?: (
        env: WorkerBindings,
        processedBefore: Date
    ) => Promise<number>;
    pruneAbandonedTelegramUpdates?: (
        env: WorkerBindings,
        startedBefore: Date
    ) => Promise<number>;
    readBotStateSnapshot?: (
        env: WorkerBindings,
        asOf: Date
    ) => Promise<BotStateSnapshot>;
    refreshBotAdminStatuses?: (
        env: WorkerBindings,
        asOf: Date
    ) => Promise<void>;
}

export interface ScheduledTasksSummary {
    taskNames: string[];
    cleanedChannels: number;
    prunedProcessedTelegramUpdates: number;
    prunedAbandonedTelegramUpdates: number;
}

const isReleaseBroadcastSummary = (
    value: unknown
): value is {
    releaseVersion: string;
    candidates: number;
    inserted: number;
    enqueued: number;
} => {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>).releaseVersion === 'string' &&
        typeof (value as Record<string, unknown>).candidates === 'number' &&
        typeof (value as Record<string, unknown>).inserted === 'number' &&
        typeof (value as Record<string, unknown>).enqueued === 'number'
    );
};

const cleanupInactiveChannels = async (
    env: WorkerBindings,
    inactiveSince: Date
) => {
    const game = createGameService(env);

    return game.cleanupInactiveChannels(inactiveSince);
};

const pruneProcessedTelegramUpdates = (
    env: WorkerBindings,
    processedBefore: Date
) => {
    const repository = createRepositories(createDb(env)).telegramUpdates;

    return Effect.runPromise(repository.deleteProcessedBefore(processedBefore));
};

const pruneAbandonedTelegramUpdates = (
    env: WorkerBindings,
    startedBefore: Date
) => {
    const repository = createRepositories(createDb(env)).telegramUpdates;

    return Effect.runPromise(
        repository.deleteAbandonedProcessingBefore(startedBefore)
    );
};

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

export const runScheduledTasks = async (
    controller: ScheduledController,
    env: WorkerBindings,
    ctx: ExecutionContext,
    dependencies: ScheduledTaskDependencies = {}
) => {
    const taskNames = getScheduledTaskNames(controller.cron);
    let cleanedChannels = 0;
    let prunedProcessedTelegramUpdates = 0;
    let prunedAbandonedTelegramUpdates = 0;

    if (env.BOT_ENVIRONMENT === 'production') {
        const asOf = new Date(controller.scheduledTime);

        try {
            await (
                dependencies.refreshBotAdminStatuses ?? refreshBotAdminStatuses
            )(env, asOf);
        } catch {
            // Permission refreshes must never block the scheduled work or release cron.
        }

        try {
            const snapshot = await (
                dependencies.readBotStateSnapshot ?? readBotStateSnapshot
            )(env, asOf);

            emitTelemetryEvent(env, ctx, {
                event: 'bot_state_snapshot',
                cron: controller.cron,
                outcome: 'success',
                ...snapshot
            });
            for (const [adminStatus, groupCount] of [
                ['admin', snapshot.adminChats],
                ['nonAdmin', snapshot.nonAdminChats],
                ['unknown', snapshot.unknownAdminChats]
            ] as const) {
                emitTelemetryEvent(env, ctx, {
                    event: 'bot_admin_status_count',
                    adminStatus,
                    groupCount,
                    outcome: 'success'
                });
            }
        } catch (error) {
            emitTelemetryEvent(env, ctx, {
                event: 'bot_state_snapshot_failed',
                cron: controller.cron,
                outcome: 'error',
                errorType: getErrorType(error)
            });
        }
    }

    if (taskNames.includes(TASKS.releaseBroadcast)) {
        const broadcastRelease =
            dependencies.broadcastRelease ?? runReleaseBroadcast;

        try {
            const summary = await broadcastRelease(env);

            if (isReleaseBroadcastSummary(summary)) {
                emitTelemetryEvent(env, ctx, {
                    event: 'release_broadcast_completed',
                    cron: controller.cron,
                    outcome: 'success',
                    releaseVersion: summary.releaseVersion,
                    candidates: summary.candidates,
                    inserted: summary.inserted,
                    enqueued: summary.enqueued
                });
            }
        } catch (error) {
            emitTelemetryEvent(env, ctx, {
                event: 'release_broadcast_failed',
                cron: controller.cron,
                outcome: 'error',
                errorType: getErrorType(error)
            });
            console.error(
                JSON.stringify({
                    event: 'release_broadcast_failed',
                    botEnvironment: env.BOT_ENVIRONMENT,
                    cron: controller.cron,
                    errorType: getErrorType(error)
                })
            );
            throw error;
        }
    }

    if (
        env.BOT_ENVIRONMENT === 'production' &&
        !taskNames.includes(TASKS.releaseBroadcast)
    ) {
        const pruneProcessed =
            dependencies.pruneProcessedTelegramUpdates ??
            pruneProcessedTelegramUpdates;
        const pruneAbandoned =
            dependencies.pruneAbandonedTelegramUpdates ??
            pruneAbandonedTelegramUpdates;

        try {
            prunedProcessedTelegramUpdates = await pruneProcessed(
                env,
                new Date(Date.now() - telegramUpdateRetentionMilliseconds)
            );
            prunedAbandonedTelegramUpdates = await pruneAbandoned(
                env,
                new Date(
                    Date.now() - telegramAbandonedUpdateRetentionMilliseconds
                )
            );

            console.log(
                JSON.stringify({
                    event: 'telegram_update_ledger_pruned',
                    botEnvironment: env.BOT_ENVIRONMENT,
                    cron: controller.cron,
                    prunedAbandonedTelegramUpdates,
                    prunedProcessedTelegramUpdates
                })
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'telegram_update_ledger_prune_failed',
                    botEnvironment: env.BOT_ENVIRONMENT,
                    cron: controller.cron,
                    errorType: getErrorType(error)
                })
            );
            throw error;
        }
    }

    if (taskNames.includes(TASKS.cleanup)) {
        if (env.ENABLE_SCHEDULED_CLEANUP !== 'true') {
            console.log(
                JSON.stringify({
                    event: 'scheduled_cleanup_skipped',
                    botEnvironment: env.BOT_ENVIRONMENT,
                    cron: controller.cron,
                    reason: 'disabled'
                })
            );
        } else {
            const cleanup =
                dependencies.cleanupInactiveChannels ?? cleanupInactiveChannels;

            try {
                cleanedChannels = await cleanup(
                    env,
                    new Date(Date.now() - 30 * 24 * 3600 * 1000)
                );

                console.log(
                    JSON.stringify({
                        event: 'scheduled_cleanup_completed',
                        botEnvironment: env.BOT_ENVIRONMENT,
                        cron: controller.cron,
                        cleanedChannels
                    })
                );
            } catch (error) {
                console.error(
                    JSON.stringify({
                        event: 'scheduled_cleanup_failed',
                        botEnvironment: env.BOT_ENVIRONMENT,
                        cron: controller.cron,
                        errorType: getErrorType(error)
                    })
                );
                throw error;
            }
        }
    }

    console.log(
        JSON.stringify({
            event: 'scheduled_worker_invoked',
            botEnvironment: env.BOT_ENVIRONMENT,
            cron: controller.cron,
            scheduledTime: controller.scheduledTime,
            taskNames
        })
    );

    return {
        taskNames,
        cleanedChannels,
        prunedProcessedTelegramUpdates,
        prunedAbandonedTelegramUpdates
    } satisfies ScheduledTasksSummary;
};
