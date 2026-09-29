import type { ReleaseAnnouncementJob } from './queues/release-announcement-job';

export type WorkerBindings = Omit<Env, 'RELEASE_QUEUE' | 'BOT_ENVIRONMENT'> & {
    BOT_ENVIRONMENT: Env['BOT_ENVIRONMENT'] | 'preview';
    RELEASE_QUEUE: Queue<ReleaseAnnouncementJob>;
};

const requiredStringBindings = [
    'BOT_TOKEN',
    'TELEGRAM_WEBHOOK_PATH',
    'TELEGRAM_WEBHOOK_SECRET'
] as const satisfies readonly (keyof WorkerBindings)[];

type RuntimeConfiguration = Partial<
    Record<
        | (typeof requiredStringBindings)[number]
        | 'BOT_ENVIRONMENT'
        | 'ENABLE_SCHEDULED_CLEANUP',
        unknown
    >
>;

const isNonEmptyString = (value: unknown): value is string => {
    return typeof value === 'string' && value.trim().length > 0;
};

const isTelegramWebhookPath = (value: unknown): value is string => {
    return (
        isNonEmptyString(value) &&
        value === value.trim() &&
        value.startsWith('/') &&
        !value.includes('?') &&
        !value.includes('#')
    );
};

export const getTelegramWebhookPath = (env: RuntimeConfiguration) => {
    if (!isTelegramWebhookPath(env.TELEGRAM_WEBHOOK_PATH)) {
        return null;
    }

    return env.TELEGRAM_WEBHOOK_PATH;
};

export const hasRequiredWorkerConfiguration = (env: RuntimeConfiguration) => {
    const hasRequiredStrings = requiredStringBindings.every(binding => {
        return isNonEmptyString(env[binding]);
    });
    const hasValidEnvironment =
        env.BOT_ENVIRONMENT === 'local' ||
        env.BOT_ENVIRONMENT === 'production' ||
        env.BOT_ENVIRONMENT === 'beta' ||
        env.BOT_ENVIRONMENT === 'preview';
    const hasValidCleanupFlag =
        env.ENABLE_SCHEDULED_CLEANUP === 'true' ||
        env.ENABLE_SCHEDULED_CLEANUP === 'false';

    return (
        hasRequiredStrings &&
        getTelegramWebhookPath(env) !== null &&
        hasValidEnvironment &&
        hasValidCleanupFlag
    );
};
