import { Hono } from 'hono';

import type { WorkerBindings } from './env';
import {
    registerAdminRoutes,
    type AdminRouteDependencies
} from './routes/admin';
import { registerHealthRoutes } from './routes/health';
import {
    registerTelegramRoutes,
    type TelegramRouteDependencies
} from './routes/telegram';

export type WorkerApp = Hono<{ Bindings: WorkerBindings }>;

export const createApp = (
    telegramDependencies: TelegramRouteDependencies = {},
    adminDependencies: AdminRouteDependencies = {}
) => {
    const app = new Hono<{ Bindings: WorkerBindings }>();

    app.get('/', c => {
        return c.json({
            service: 'princess',
            runtime: 'cloudflare-workers',
            phase: 5,
            status: 'runtime-ready'
        });
    });

    registerHealthRoutes(app, telegramDependencies);
    registerAdminRoutes(app, {
        ...(telegramDependencies.secretsMatch && {
            secretsMatch: telegramDependencies.secretsMatch
        }),
        ...adminDependencies
    });
    registerTelegramRoutes(app, telegramDependencies);

    return app;
};
