import type { Context } from 'hono';
import type { Update } from 'telegraf/types';

import { createPrincessBot } from '../../bot';
import type { WorkerApp } from '../app';
import { getTelegramWebhookPath } from '../env';

const hasExpectedSecret = (c: Context) => {
    const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET;

    if (!expectedSecret) {
        return true;
    }

    const providedSecret =
        c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';

    return providedSecret === expectedSecret;
};

export const registerTelegramRoutes = (app: WorkerApp) => {
    app.post('*', async c => {
        const expectedPath = getTelegramWebhookPath(c.env);
        const pathname = new URL(c.req.url).pathname;

        if (pathname !== expectedPath) {
            return c.notFound();
        }

        if (!hasExpectedSecret(c)) {
            return c.json(
                {
                    error: 'Invalid Telegram webhook secret'
                },
                401
            );
        }

        if (!c.env.BOT_TOKEN) {
            return c.json(
                {
                    error: 'BOT_TOKEN is not configured'
                },
                500
            );
        }

        const update = (await c.req.json()) as Update;
        const bot = createPrincessBot(c.env);

        await bot.handleUpdate(update);

        return c.json(
            {
                accepted: true,
                updateId: update.update_id ?? null
            },
            200
        );
    });
};
