import { Hono } from 'hono';

import type { WorkerBindings } from './env';
import { registerHealthRoutes } from './routes/health';
import { registerTelegramRoutes } from './routes/telegram';

export type WorkerApp = Hono<{ Bindings: WorkerBindings }>;

export const createApp = () => {
    const app = new Hono<{ Bindings: WorkerBindings }>();

    app.get('/', c => {
        return c.json({
            service: 'princess',
            runtime: 'cloudflare-workers',
            phase: 5,
            status: 'runtime-ready'
        });
    });

    registerHealthRoutes(app);
    registerTelegramRoutes(app);

    return app;
};
