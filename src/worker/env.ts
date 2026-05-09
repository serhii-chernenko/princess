export interface WorkerBindings {
    BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_PATH?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
}

export const DEFAULT_TELEGRAM_WEBHOOK_PATH = '/telegram';

export const getTelegramWebhookPath = (env: WorkerBindings) => {
    return env.TELEGRAM_WEBHOOK_PATH || DEFAULT_TELEGRAM_WEBHOOK_PATH;
};
