import type { WorkerBindings } from '../env';
import { createGameService } from '../../bot/services/game-service';

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

export const runScheduledTasks = async (
    controller: ScheduledController,
    env: WorkerBindings,
    _ctx: ExecutionContext
) => {
    const taskNames = getScheduledTaskNames(controller.cron);

    if (taskNames.includes(TASKS.cleanup)) {
        const game = createGameService(env);
        const cleanedChannels = await game.cleanupInactiveChannels(
            new Date(Date.now() - 30 * 24 * 3600 * 1000)
        );

        console.log('scheduled cleanup completed', {
            cron: controller.cron,
            cleanedChannels
        });
    }

    console.log('scheduled worker scaffold invoked', {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        taskNames
    });
};
