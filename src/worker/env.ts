export interface WorkerBindings {
    DB: D1Database;
    BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_PATH?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    AUTHOR_TWITTER_LINK?: string;
    WISHLIST_TG_URL?: string;
    CHATGPT_GITHUB_REPO_URL?: string;
    TG_CHANNEL?: string;
    TG_GROUP?: string;
    YT_CHANNEL?: string;
    MAIL?: string;
}

export const DEFAULT_TELEGRAM_WEBHOOK_PATH = '/telegram';

export const getTelegramWebhookPath = (env: WorkerBindings) => {
    return env.TELEGRAM_WEBHOOK_PATH || DEFAULT_TELEGRAM_WEBHOOK_PATH;
};
