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

export const runScheduledTasks = async (
    controller: ScheduledController,
    _env: WorkerBindings,
    _ctx: ExecutionContext
) => {
    const taskNames = getScheduledTaskNames(controller.cron);

    console.log('scheduled worker scaffold invoked', {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        taskNames
    });
};
