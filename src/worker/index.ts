import { createApp } from './app';
import { runScheduledTasks } from './scheduled/tasks';

const app = createApp();

export default {
    fetch(request, env, ctx) {
        return app.fetch(request, env, ctx);
    },
    scheduled(controller, env, ctx) {
        return runScheduledTasks(controller, env, ctx);
    }
} satisfies ExportedHandler<Env>;
