import { Effect } from 'effect';

import { createGameService } from '../../bot/services/game-service';
import { createDb } from '../../db/client';
import { createRepositories } from '../../db/repositories';
import {
    telegramAbandonedUpdateRetentionMilliseconds,
    telegramUpdateRetentionMilliseconds
} from '../../db/repositories/telegram-update-repository';
import type { WorkerBindings } from '../env';

const TASKS = {
    cleanup: 'maintenance:cleanup',
    releases: 'maintenance:releases'
} as const;

const getScheduledTaskNames = (cron: string) => {
    if (cron.includes('0 0')) {
        return [TASKS.cleanup, TASKS.releases];
    }

    return [TASKS.cleanup];
};

interface ScheduledTaskDependencies {
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
}

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
    _ctx: ExecutionContext,
    dependencies: ScheduledTaskDependencies = {}
) => {
    const taskNames = getScheduledTaskNames(controller.cron);

    if (env.BOT_ENVIRONMENT === 'stable') {
        const pruneProcessed =
            dependencies.pruneProcessedTelegramUpdates ??
            pruneProcessedTelegramUpdates;
        const pruneAbandoned =
            dependencies.pruneAbandonedTelegramUpdates ??
            pruneAbandonedTelegramUpdates;

        try {
            const prunedProcessedTelegramUpdates = await pruneProcessed(
                env,
                new Date(Date.now() - telegramUpdateRetentionMilliseconds)
            );
            const prunedAbandonedTelegramUpdates = await pruneAbandoned(
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
                const cleanedChannels = await cleanup(
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
};
