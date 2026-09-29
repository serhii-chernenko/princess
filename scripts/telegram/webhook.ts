import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    loadOptionalEnvFile,
    createWebhookUrl,
    requireEnv
} from '../cloudflare/runtime-env';

type WebhookAction = 'set' | 'info' | 'delete';
type EnvTarget = 'local' | 'production' | 'beta';

export const TELEGRAM_API_MAX_RESPONSE_BYTES = 64 * 1024;
export const TELEGRAM_API_TIMEOUT_MILLISECONDS = 15_000;

interface TelegramApiCallOptions {
    botToken?: string;
    fetchImplementation?: typeof fetch;
    timeoutMilliseconds?: number;
}

export interface TelegramApiPayload {
    ok: boolean;
    description?: string;
    result?: unknown;
}

const safeAllowedUpdateTypes = new Set([
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
    'guest_message',
    'message_reaction',
    'message_reaction_count',
    'inline_query',
    'chosen_inline_result',
    'callback_query',
    'shipping_query',
    'pre_checkout_query',
    'purchased_paid_media',
    'poll',
    'poll_answer',
    'my_chat_member',
    'chat_member',
    'chat_join_request',
    'chat_boost',
    'removed_chat_boost',
    'managed_bot',
    'subscription'
]);

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

const dropPendingUpdatesFlagPrefix = '--drop-pending-updates=';

export const parseDropPendingUpdates = (
    action: WebhookAction,
    target: EnvTarget,
    flags: string[]
) => {
    if (action === 'info') {
        if (flags.length > 0) {
            throw new Error('Webhook info does not accept flags');
        }

        return undefined;
    }

    const [flag, ...extraFlags] = flags;

    if (extraFlags.length > 0) {
        throw new Error('Only --drop-pending-updates=true|false is supported');
    }

    if (flag === undefined) {
        if (target === 'local') {
            return undefined;
        }

        throw new Error(
            `Webhook ${action} for ${target} requires an explicit --drop-pending-updates=true|false`
        );
    }

    const value = flag.startsWith(dropPendingUpdatesFlagPrefix)
        ? flag.slice(dropPendingUpdatesFlagPrefix.length)
        : undefined;

    if (value !== 'true' && value !== 'false') {
        throw new Error('Use --drop-pending-updates=true or =false');
    }

    return value === 'true';
};

export const createDropPendingUpdatesParameters = (
    dropPendingUpdates: boolean | undefined
) => {
    const parameters = new URLSearchParams();

    if (dropPendingUpdates !== undefined) {
        parameters.set('drop_pending_updates', String(dropPendingUpdates));
    }

    return parameters;
};

const readBoundedResponseText = async (response: Response) => {
    const declaredLengthValue = response.headers.get('content-length');

    if (declaredLengthValue !== null) {
        const declaredLength = Number(declaredLengthValue);

        if (
            !/^\d+$/.test(declaredLengthValue) ||
            !Number.isSafeInteger(declaredLength)
        ) {
            throw new Error('Telegram API returned an invalid Content-Length');
        }

        if (declaredLength > TELEGRAM_API_MAX_RESPONSE_BYTES) {
            throw new Error('Telegram API response exceeded the size limit');
        }
    }

    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            byteLength += value.byteLength;

            if (byteLength > TELEGRAM_API_MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined);

                throw new Error(
                    'Telegram API response exceeded the size limit'
                );
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const responseBytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
        responseBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: false
    }).decode(responseBytes);
};

const parseTelegramApiPayload = (
    responseText: string,
    method: string
): TelegramApiPayload => {
    let payload: unknown;

    try {
        payload = JSON.parse(responseText);
    } catch {
        throw new Error(`Telegram API ${method} returned invalid JSON`);
    }

    if (
        typeof payload !== 'object' ||
        payload === null ||
        !('ok' in payload) ||
        typeof payload.ok !== 'boolean' ||
        ('description' in payload &&
            payload.description !== undefined &&
            typeof payload.description !== 'string')
    ) {
        throw new Error(`Telegram API ${method} returned an invalid response`);
    }

    return payload as TelegramApiPayload;
};

export const callTelegramApi = async (
    method: string,
    body?: URLSearchParams,
    options: TelegramApiCallOptions = {}
) => {
    const botToken = options.botToken ?? requireEnv('BOT_TOKEN');
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const timeoutMilliseconds =
        options.timeoutMilliseconds ?? TELEGRAM_API_TIMEOUT_MILLISECONDS;
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        abortController.abort();
    }, timeoutMilliseconds);
    const requestInit: RequestInit = {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: abortController.signal
    };

    if (body) {
        requestInit.headers = {
            'Content-Type': 'application/x-www-form-urlencoded'
        };
        requestInit.body = body;
    }

    try {
        const response = await fetchImplementation(
            `https://api.telegram.org/bot${botToken}/${method}`,
            requestInit
        );
        const responseText = await readBoundedResponseText(response);
        const payload = parseTelegramApiPayload(responseText, method);

        if (!response.ok || !payload.ok) {
            throw new Error(
                `Telegram API ${method} failed: ${payload.description ?? response.statusText}`
            );
        }

        console.log(
            JSON.stringify({
                event: 'telegram_api_request_succeeded',
                method
            })
        );

        return payload;
    } catch (error) {
        if (abortController.signal.aborted) {
            throw new Error(
                `Telegram API ${method} timed out after ${timeoutMilliseconds}ms`,
                { cause: error }
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
};

const readSafeInteger = (result: Record<string, unknown>, key: string) => {
    const value = result[key];

    return Number.isSafeInteger(value) && Number(value) >= 0
        ? Number(value)
        : null;
};

const readSafeBoolean = (result: Record<string, unknown>, key: string) => {
    const value = result[key];

    return typeof value === 'boolean' ? value : null;
};

const readSafeAllowedUpdates = (result: Record<string, unknown>) => {
    const value = result.allowed_updates;

    if (
        !Array.isArray(value) ||
        !value.every(updateType => {
            return (
                typeof updateType === 'string' &&
                safeAllowedUpdateTypes.has(updateType)
            );
        })
    ) {
        return null;
    }

    return value as string[];
};

export const formatTelegramWebhookInfo = (
    payload: TelegramApiPayload,
    expectedWebhookUrl: string
) => {
    const result =
        typeof payload.result === 'object' &&
        payload.result !== null &&
        !Array.isArray(payload.result)
            ? (payload.result as Record<string, unknown>)
            : {};
    const configuredUrl =
        typeof result.url === 'string' && result.url.length > 0
            ? result.url
            : null;

    return JSON.stringify(
        {
            event: 'telegram_webhook_info',
            urlConfigured: configuredUrl !== null,
            urlMatchesExpected:
                configuredUrl !== null && configuredUrl === expectedWebhookUrl,
            hasCustomCertificate: readSafeBoolean(
                result,
                'has_custom_certificate'
            ),
            pendingUpdateCount: readSafeInteger(result, 'pending_update_count'),
            lastErrorDate: readSafeInteger(result, 'last_error_date'),
            lastErrorMessagePresent:
                typeof result.last_error_message === 'string' &&
                result.last_error_message.length > 0,
            lastSynchronizationErrorDate: readSafeInteger(
                result,
                'last_synchronization_error_date'
            ),
            maxConnections: readSafeInteger(result, 'max_connections'),
            allowedUpdates: readSafeAllowedUpdates(result)
        },
        null,
        2
    );
};

const run = async () => {
    const action = parseAction(process.argv[2]);
    const target = parseTarget(process.argv[3]);
    const dropPendingUpdates = parseDropPendingUpdates(
        action,
        target,
        process.argv.slice(4)
    );

    loadOptionalEnvFile(target);

    if (action === 'info') {
        const expectedWebhookUrl = createWebhookUrl();
        const payload = await callTelegramApi('getWebhookInfo');

        console.log(formatTelegramWebhookInfo(payload, expectedWebhookUrl));
        return;
    }

    if (action === 'delete') {
        await callTelegramApi(
            'deleteWebhook',
            createDropPendingUpdatesParameters(dropPendingUpdates)
        );
        return;
    }

    const webhookUrl = createWebhookUrl();
    const secretToken = requireEnv('TELEGRAM_WEBHOOK_SECRET');
    const params = createDropPendingUpdatesParameters(dropPendingUpdates);

    params.set('allowed_updates', JSON.stringify(['message']));
    params.set('max_connections', '1');
    params.set('url', webhookUrl);
    params.set('secret_token', secretToken);

    await callTelegramApi('setWebhook', params);
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    void run().catch((error: unknown) => {
        console.error(
            JSON.stringify({
                event: 'telegram_webhook_command_failed',
                errorType: error instanceof Error ? error.name : typeof error
            })
        );
        process.exitCode = 1;
    });
}
