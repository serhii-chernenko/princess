import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    loadOptionalEnvFile,
    createWebhookUrl,
    requireEnv
} from '../cloudflare/runtime-env';
import {
    loadPreviewEnvironment,
    PreviewOperatorError,
    requirePreviewBot,
    runLocalCommand
} from './preview-environment';

type WebhookAction = 'set' | 'info' | 'delete';
type EnvTarget = 'local' | 'production' | 'preview';

export const TELEGRAM_API_MAX_RESPONSE_BYTES = 64 * 1024;
export const TELEGRAM_API_TIMEOUT_MILLISECONDS = 15_000;

export interface TelegramApiCallOptions {
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
    if (value === 'local' || value === 'production' || value === 'preview') {
        return value;
    }

    throw new Error(
        'Webhook target must be one of: local, production, preview'
    );
};

const dropPendingUpdatesFlagPrefix = '--drop-pending-updates=';
const urlFlag = '--url';
const urlFlagPrefix = `${urlFlag}=`;
const workersDevHostSuffix = '.workers.dev';
export const ACCOUNT_SUBDOMAIN = 'chernenko';
export const WORKER_NAME = 'princess';
export const PRODUCTION_WORKER_HOSTNAME = `${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}${workersDevHostSuffix}`;

export const parsePreviewBaseUrl = (value: string) => {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new Error('--url must be a valid absolute URL');
    }

    if (url.protocol !== 'https:') {
        throw new Error('--url must use https');
    }

    if (
        !url.hostname.endsWith(workersDevHostSuffix) ||
        url.hostname === workersDevHostSuffix.slice(1)
    ) {
        throw new Error(`--url host must end with ${workersDevHostSuffix}`);
    }

    if (url.hostname === PRODUCTION_WORKER_HOSTNAME) {
        throw new Error('--url must not be the production Worker origin');
    }

    if (
        url.username !== '' ||
        url.password !== '' ||
        url.port !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== ''
    ) {
        throw new Error(
            '--url must be a bare origin such as https://name.account.workers.dev'
        );
    }

    return url.origin;
};

export const parseWebhookArguments = (
    action: WebhookAction,
    target: EnvTarget,
    arguments_: string[]
) => {
    const flags = arguments_.filter(argument => argument !== '--');
    const remainingFlags: string[] = [];
    let baseUrlValue: string | undefined;

    for (let index = 0; index < flags.length; index += 1) {
        const flag = flags[index] as string;

        if (flag === urlFlag) {
            index += 1;
            baseUrlValue = flags[index];

            if (baseUrlValue === undefined || baseUrlValue.startsWith('--')) {
                throw new Error('--url requires a value');
            }
        } else if (flag.startsWith(urlFlagPrefix)) {
            baseUrlValue = flag.slice(urlFlagPrefix.length);
        } else {
            remainingFlags.push(flag);
        }
    }

    const dropPendingUpdates = parseDropPendingUpdates(
        action,
        target,
        remainingFlags
    );

    if (target !== 'preview') {
        if (baseUrlValue !== undefined) {
            throw new Error('--url is only supported for the preview target');
        }

        return { dropPendingUpdates, baseUrl: undefined };
    }

    if (action === 'delete') {
        if (baseUrlValue !== undefined) {
            throw new Error('Webhook delete does not accept --url');
        }

        return { dropPendingUpdates, baseUrl: undefined };
    }

    if (baseUrlValue === undefined) {
        throw new Error(
            `Webhook ${action} for preview requires --url https://<name>.<account>.workers.dev`
        );
    }

    return {
        dropPendingUpdates,
        baseUrl: parsePreviewBaseUrl(baseUrlValue)
    };
};

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

const readWebhookInfoResult = (payload: TelegramApiPayload) => {
    return typeof payload.result === 'object' &&
        payload.result !== null &&
        !Array.isArray(payload.result)
        ? (payload.result as Record<string, unknown>)
        : {};
};

const readConfiguredWebhookUrl = (payload: TelegramApiPayload) => {
    const { url } = readWebhookInfoResult(payload);

    return typeof url === 'string' && url.length > 0 ? url : null;
};

export const readConfiguredWebhookOrigin = (payload: TelegramApiPayload) => {
    const configuredUrl = readConfiguredWebhookUrl(payload);

    if (configuredUrl === null) {
        return null;
    }

    try {
        const { hostname, origin } = new URL(configuredUrl);

        return hostname.endsWith(workersDevHostSuffix) ? origin : null;
    } catch {
        return null;
    }
};

export const summarizeTelegramWebhookInfo = (
    payload: TelegramApiPayload,
    expectedWebhookUrl: string
) => {
    const result = readWebhookInfoResult(payload);
    const configuredUrl = readConfiguredWebhookUrl(payload);

    return {
        event: 'telegram_webhook_info',
        urlConfigured: configuredUrl !== null,
        urlMatchesExpected:
            configuredUrl !== null && configuredUrl === expectedWebhookUrl,
        hasCustomCertificate: readSafeBoolean(result, 'has_custom_certificate'),
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
    };
};

export const formatTelegramWebhookInfo = (
    payload: TelegramApiPayload,
    expectedWebhookUrl: string
) => {
    return JSON.stringify(
        summarizeTelegramWebhookInfo(payload, expectedWebhookUrl),
        null,
        2
    );
};

export const readWebhookInfo = (options: TelegramApiCallOptions = {}) => {
    return callTelegramApi('getWebhookInfo', undefined, options);
};

export const setTelegramWebhook = async (
    baseUrl: string | undefined,
    dropPendingUpdates: boolean | undefined,
    options: TelegramApiCallOptions = {}
) => {
    const webhookUrl = createWebhookUrl(baseUrl);
    const secretToken = requireEnv('TELEGRAM_WEBHOOK_SECRET');
    const params = createDropPendingUpdatesParameters(dropPendingUpdates);

    params.set('allowed_updates', JSON.stringify(['message']));
    params.set('max_connections', '1');
    params.set('url', webhookUrl);
    params.set('secret_token', secretToken);

    await callTelegramApi('setWebhook', params, options);

    return webhookUrl;
};

export interface WebhookRunDependencies {
    loadPreviewEnvironment: () => Promise<unknown>;
    loadOptionalEnvFile: (target: 'local' | 'production') => unknown;
    telegram: TelegramApiCallOptions;
}

export const runWebhookCommand = async (
    action: WebhookAction,
    target: EnvTarget,
    arguments_: string[],
    dependencies: WebhookRunDependencies
) => {
    const { dropPendingUpdates, baseUrl } = parseWebhookArguments(
        action,
        target,
        arguments_
    );

    if (target === 'preview') {
        await dependencies.loadPreviewEnvironment();
    } else {
        dependencies.loadOptionalEnvFile(target);
    }

    if (target === 'preview' && action !== 'info') {
        await requirePreviewBot(() => {
            return callTelegramApi('getMe', undefined, dependencies.telegram);
        });
    }

    if (action === 'info') {
        const expectedWebhookUrl = createWebhookUrl(baseUrl);
        const payload = await readWebhookInfo(dependencies.telegram);

        console.log(formatTelegramWebhookInfo(payload, expectedWebhookUrl));
        return;
    }

    if (action === 'delete') {
        await callTelegramApi(
            'deleteWebhook',
            createDropPendingUpdatesParameters(dropPendingUpdates),
            dependencies.telegram
        );
        return;
    }

    await setTelegramWebhook(
        baseUrl,
        dropPendingUpdates,
        dependencies.telegram
    );
};

const run = async () => {
    await runWebhookCommand(
        parseAction(process.argv[2]),
        parseTarget(process.argv[3]),
        process.argv.slice(4),
        {
            loadPreviewEnvironment: () => {
                return loadPreviewEnvironment({ runCommand: runLocalCommand });
            },
            loadOptionalEnvFile,
            telegram: {}
        }
    );
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
                errorType: error instanceof Error ? error.name : typeof error,
                ...(error instanceof PreviewOperatorError
                    ? { message: error.message }
                    : {})
            })
        );
        process.exitCode = 1;
    });
}
