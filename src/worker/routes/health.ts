import type { WorkerApp } from '../app';

export const registerHealthRoutes = (app: WorkerApp) => {
    app.get('/health', c => {
        return c.json({
            service: 'princess',
            runtime: 'cloudflare-workers',
            ready: true
        });
    });
};
