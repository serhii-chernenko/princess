import { createApp } from './app';
import type { WorkerBindings } from './env';
import type { ReleaseAnnouncementJob } from './queues/release-announcement-job';
import { handleReleaseAnnouncementQueue } from './queues/release-announcements-handler';
import { runScheduledTasks } from './scheduled/tasks';

const app = createApp();

export default {
    fetch(request, env, ctx) {
        return app.fetch(request, env, ctx);
    },
    scheduled(controller, env, ctx) {
        return runScheduledTasks(controller, env, ctx);
    },
    queue(batch, env) {
        return handleReleaseAnnouncementQueue(batch, env);
    }
} satisfies ExportedHandler<WorkerBindings, ReleaseAnnouncementJob>;
