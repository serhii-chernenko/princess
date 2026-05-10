import {
    loadOptionalEnvFile,
    createWebhookUrl,
    requireEnv
} from '../cloudflare/runtime-env';

type WebhookAction = 'set' | 'info' | 'delete';
type EnvTarget = 'local' | 'production' | 'beta';

const parseAction = (value: string | undefined): WebhookAction => {
    if (value === 'set' || value === 'info' || value === 'delete') {
        return value;
    }

    throw new Error('Webhook action must be one of: set, info, delete');
};

const parseTarget = (value: string | undefined): EnvTarget => {
    if (value === 'local' || value === 'production' || value === 'beta') {
        return value;
    }

    throw new Error('Webhook target must be one of: local, production, beta');
};

const callTelegramApi = async (method: string, body?: URLSearchParams) => {
    const botToken = requireEnv('BOT_TOKEN');
    const requestInit: RequestInit = {
        method: body ? 'POST' : 'GET'
    };

    if (body) {
        requestInit.headers = {
            'Content-Type': 'application/x-www-form-urlencoded'
        };
        requestInit.body = body;
    }

    const response = await fetch(
        `https://api.telegram.org/bot${botToken}/${method}`,
        requestInit
    );

    const payload = (await response.json()) as {
        ok: boolean;
        description?: string;
    };

    if (!response.ok || !payload.ok) {
        throw new Error(
            `Telegram API ${method} failed: ${payload.description ?? response.statusText}`
        );
    }

    console.log(JSON.stringify(payload, null, 2));
};

const run = async () => {
    const action = parseAction(process.argv[2]);
    const target = parseTarget(process.argv[3]);

    loadOptionalEnvFile(target);

    if (action === 'info') {
        await callTelegramApi('getWebhookInfo');
        return;
    }

    if (action === 'delete') {
        await callTelegramApi('deleteWebhook', new URLSearchParams());
        return;
    }

    const webhookUrl = createWebhookUrl();
    const secretToken = requireEnv('TELEGRAM_WEBHOOK_SECRET');
    const params = new URLSearchParams({
        url: webhookUrl,
        secret_token: secretToken
    });

    await callTelegramApi('setWebhook', params);
};

void run();
