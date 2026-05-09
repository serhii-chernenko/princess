import { Hono } from 'hono';

import type { WorkerBindings } from './env';
import { registerHealthRoutes } from './routes/health';
import { registerTelegramRoutes } from './routes/telegram';

export type WorkerApp = Hono<{ Bindings: WorkerBindings }>;

export const createApp = () => {
    const app = new Hono<{ Bindings: WorkerBindings }>();

    app.get('/', c =>
        c.json({
            service: 'princess',
            runtime: 'cloudflare-workers',
            phase: 2,
            status: 'bootstrapped'
        })
    );

    registerHealthRoutes(app);
    registerTelegramRoutes(app);

    return app;
};
