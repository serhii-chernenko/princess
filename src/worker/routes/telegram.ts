import type { Update, UserFromGetMe } from 'telegraf/types';
import { Effect } from 'effect';

import { createPrincessBot } from '../../bot';
import { createDb } from '../../db/client';
import { createRepositories } from '../../db/repositories';
import type { TelegramUpdateClaim } from '../../db/repositories/telegram-update-repository';
import type { WorkerApp } from '../app';
import {
    getTelegramWebhookPath,
    hasRequiredWorkerConfiguration,
    type WorkerBindings
} from '../env';
import {
    compareSecrets,
    TELEGRAM_SECRET_HEADER,
    type SecretComparisonCrypto,
    type SecretMatcher
} from '../telegram-auth';

export { compareSecrets, type SecretComparisonCrypto } from '../telegram-auth';

export type RuntimeTelegramUpdate = Update;

export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export interface TelegramRouteDependencies {
    handleUpdate?: (
        env: WorkerBindings,
        update: RuntimeTelegramUpdate,
        botKey: string
    ) => Promise<void>;
    secretsMatch?: SecretMatcher;
    createUpdateLedger?: (env: WorkerBindings) => TelegramUpdateLedger;
    deriveBotKey?: (env: WorkerBindings) => Promise<string>;
    createLeaseId?: () => string;
    now?: () => Date;
    logWarning?: (message: string) => void;
}

export interface TelegramUpdateLedger {
    claimUpdate(
        botKey: string,
        updateId: number,
        leaseId: string,
        startedAt: Date
    ): Promise<TelegramUpdateClaim>;
    terminalizeUpdate(
        botKey: string,
        updateId: number,
        leaseId: string,
        processedAt: Date
    ): Promise<boolean>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isNonNegativeSafeInteger = (value: unknown): value is number => {
    return Number.isSafeInteger(value) && Number(value) >= 0;
};

const isTelegramChatType = (value: unknown) => {
    return (
        value === 'private' ||
        value === 'group' ||
        value === 'supergroup' ||
        value === 'channel'
    );
};

const isRuntimeTelegramMessage = (value: unknown) => {
    if (!isRecord(value) || !isRecord(value.chat)) {
        return false;
    }

    return (
        isNonNegativeSafeInteger(value.message_id) &&
        isNonNegativeSafeInteger(value.date) &&
        Number.isSafeInteger(value.chat.id) &&
        isTelegramChatType(value.chat.type)
    );
};

export const isRuntimeTelegramUpdate = (
    value: unknown
): value is RuntimeTelegramUpdate => {
    return (
        isRecord(value) &&
        isNonNegativeSafeInteger(value.update_id) &&
        isRuntimeTelegramMessage(value.message)
    );
};

export const isIgnorableTelegramUpdate = (
    value: unknown
): value is { update_id: number } => {
    return (
        isRecord(value) &&
        isNonNegativeSafeInteger(value.update_id) &&
        value.message === undefined
    );
};

type LimitedJsonBodyResult =
    | {
          state: 'parsed';
          payload: unknown;
      }
    | {
          state: 'malformed';
      }
    | {
          state: 'too-large';
      };

const cancelReaderIgnoringFailure = async (
    reader: ReadableStreamDefaultReader<Uint8Array>
) => {
    try {
        await reader.cancel();
    } catch {
        return;
    }
};

const readLimitedJsonBody = async (
    request: Request
): Promise<LimitedJsonBodyResult> => {
    const contentLength = request.headers.get('Content-Length');

    if (contentLength !== null) {
        if (!/^\d+$/.test(contentLength)) {
            return {
                state: 'malformed'
            };
        }

        const declaredBytes = Number(contentLength);

        if (
            !Number.isSafeInteger(declaredBytes) ||
            declaredBytes > TELEGRAM_WEBHOOK_MAX_BODY_BYTES
        ) {
            return {
                state: 'too-large'
            };
        }
    }

    if (!request.body) {
        return {
            state: 'malformed'
        };
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const chunk = await reader.read();

            if (chunk.done) {
                break;
            }

            totalBytes += chunk.value.byteLength;

            if (totalBytes > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
                await cancelReaderIgnoringFailure(reader);

                return {
                    state: 'too-large'
                };
            }

            chunks.push(chunk.value);
        }
    } catch {
        return {
            state: 'malformed'
        };
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    try {
        return {
            state: 'parsed',
            payload: JSON.parse(new TextDecoder().decode(body)) as unknown
        };
    } catch {
        return {
            state: 'malformed'
        };
    }
};

const bytesToHex = (bytes: Uint8Array) => {
    return Array.from(bytes, byte => {
        return byte.toString(16).padStart(2, '0');
    }).join('');
};

export const deriveTelegramBotKey = async (
    env: Pick<WorkerBindings, 'BOT_ENVIRONMENT' | 'BOT_TOKEN'>,
    subtle: Pick<SecretComparisonCrypto, 'digest'> = crypto.subtle
) => {
    const digest = await subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${env.BOT_ENVIRONMENT}:${env.BOT_TOKEN}`)
    );

    return bytesToHex(new Uint8Array(digest));
};

const createD1UpdateLedger = (env: WorkerBindings): TelegramUpdateLedger => {
    const repository = createRepositories(createDb(env)).telegramUpdates;

    return {
        claimUpdate(botKey, updateId, leaseId, startedAt) {
            return Effect.runPromise(
                repository.claimUpdate(botKey, updateId, leaseId, startedAt)
            );
        },
        terminalizeUpdate(botKey, updateId, leaseId, processedAt) {
            return Effect.runPromise(
                repository.terminalizeUpdate(
                    botKey,
                    updateId,
                    leaseId,
                    processedAt
                )
            );
        }
    };
};

type PrincessBot = Pick<
    ReturnType<typeof createPrincessBot>,
    'handleUpdate'
> & {
    botInfo?: UserFromGetMe;
};

const botInfoByBotKey = new Map<string, UserFromGetMe>();

export const clearCachedBotInfo = () => {
    botInfoByBotKey.clear();
};

export const handleUpdateWithPrincessBot = async (
    env: WorkerBindings,
    update: RuntimeTelegramUpdate,
    botKey: string,
    createBot: (env: WorkerBindings) => PrincessBot = createPrincessBot
) => {
    const bot = createBot(env);
    const cachedBotInfo = botInfoByBotKey.get(botKey);

    if (cachedBotInfo) {
        bot.botInfo = cachedBotInfo;
    }

    await bot.handleUpdate(update);

    if (!cachedBotInfo && bot.botInfo) {
        botInfoByBotKey.set(botKey, bot.botInfo);
    }
};

const isJsonRequest = (contentType: string | undefined) => {
    return (
        contentType?.split(';', 1)[0]?.trim().toLowerCase() ===
        'application/json'
    );
};

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

export const registerTelegramRoutes = (
    app: WorkerApp,
    dependencies: TelegramRouteDependencies = {}
) => {
    const handleUpdate =
        dependencies.handleUpdate ?? handleUpdateWithPrincessBot;
    const secretsMatch = dependencies.secretsMatch ?? compareSecrets;
    const createUpdateLedger =
        dependencies.createUpdateLedger ?? createD1UpdateLedger;
    const deriveBotKey = dependencies.deriveBotKey ?? deriveTelegramBotKey;
    const createLeaseId =
        dependencies.createLeaseId ?? (() => crypto.randomUUID());
    const now = dependencies.now ?? (() => new Date());
    const logWarning = dependencies.logWarning ?? console.warn;

    app.post('*', async c => {
        if (!hasRequiredWorkerConfiguration(c.env)) {
            return c.json(
                {
                    error: 'Telegram webhook is unavailable'
                },
                503
            );
        }

        const expectedPath = getTelegramWebhookPath(c.env);
        const pathname = new URL(c.req.url).pathname;

        if (expectedPath === null || pathname !== expectedPath) {
            return c.notFound();
        }

        const providedSecret = c.req.header(TELEGRAM_SECRET_HEADER) ?? '';

        if (
            !(await secretsMatch(providedSecret, c.env.TELEGRAM_WEBHOOK_SECRET))
        ) {
            return c.json(
                {
                    error: 'Invalid Telegram webhook secret'
                },
                401
            );
        }

        if (!isJsonRequest(c.req.header('Content-Type'))) {
            return c.json(
                {
                    error: 'Content-Type must be application/json'
                },
                415
            );
        }

        const body = await readLimitedJsonBody(c.req.raw);

        if (body.state === 'too-large') {
            return c.json(
                {
                    error: 'Telegram update payload is too large'
                },
                413
            );
        }

        if (body.state === 'malformed') {
            return c.json(
                {
                    error: 'Malformed JSON payload'
                },
                400
            );
        }

        const payload = body.payload;

        if (isIgnorableTelegramUpdate(payload)) {
            return c.json({
                ignored: true,
                updateId: payload.update_id
            });
        }

        if (!isRuntimeTelegramUpdate(payload)) {
            return c.json(
                {
                    error: 'Invalid Telegram update payload'
                },
                400
            );
        }

        let botKey: string;
        let leaseId: string;
        let ledger: TelegramUpdateLedger;
        let claim: TelegramUpdateClaim;

        try {
            botKey = await deriveBotKey(c.env);
            leaseId = createLeaseId();
            ledger = createUpdateLedger(c.env);
            claim = await ledger.claimUpdate(
                botKey,
                payload.update_id,
                leaseId,
                now()
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'telegram_update_ledger_unavailable',
                    errorType: getErrorType(error),
                    phase: 'claim',
                    updateId: payload.update_id
                })
            );

            return c.json(
                {
                    error: 'Telegram update ledger is unavailable'
                },
                503
            );
        }

        if (claim.state === 'duplicate') {
            return c.json(
                {
                    accepted: true,
                    duplicate: true,
                    updateId: payload.update_id
                },
                200
            );
        }

        if (claim.state === 'busy') {
            return c.json(
                {
                    error: 'Telegram update is already processing'
                },
                503
            );
        }

        if (claim.reclaimed) {
            logWarning(
                JSON.stringify({
                    event: 'telegram_update_claim_reclaimed',
                    botEnvironment: c.env.BOT_ENVIRONMENT,
                    updateId: payload.update_id
                })
            );
        }

        let dispatchFailed = false;
        let dispatchError: unknown;

        try {
            await handleUpdate(c.env, payload, botKey);
        } catch (error) {
            dispatchFailed = true;
            dispatchError = error;
        }

        let terminalized: boolean;

        try {
            terminalized = await ledger.terminalizeUpdate(
                botKey,
                payload.update_id,
                claim.leaseId,
                now()
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'telegram_update_terminalization_failed',
                    dispatchErrorType: dispatchFailed
                        ? getErrorType(dispatchError)
                        : null,
                    dispatchOutcome: dispatchFailed ? 'failed' : 'succeeded',
                    errorType: getErrorType(error),
                    updateId: payload.update_id
                })
            );

            return c.json(
                {
                    accepted: true,
                    updateId: payload.update_id
                },
                200
            );
        }

        if (!terminalized) {
            console.error(
                JSON.stringify({
                    event: 'telegram_update_lease_lost',
                    dispatchErrorType: dispatchFailed
                        ? getErrorType(dispatchError)
                        : null,
                    dispatchOutcome: dispatchFailed ? 'failed' : 'succeeded',
                    updateId: payload.update_id
                })
            );

            return c.json(
                {
                    accepted: true,
                    updateId: payload.update_id
                },
                200
            );
        }

        if (dispatchFailed) {
            console.error(
                JSON.stringify({
                    event: 'telegram_update_dispatch_failed',
                    dispatchOutcome: 'failed',
                    errorType: getErrorType(dispatchError),
                    ledgerState: 'processed',
                    updateId: payload.update_id
                })
            );

            return c.json(
                {
                    accepted: true,
                    updateId: payload.update_id
                },
                200
            );
        }

        return c.json(
            {
                accepted: true,
                updateId: payload.update_id
            },
            200
        );
    });
};
