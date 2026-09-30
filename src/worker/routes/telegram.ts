import type { Update, UserFromGetMe } from 'telegraf/types';
import { Effect } from 'effect';

import { createPrincessBot } from '../../bot';
import type { PrincessBotTelemetry } from '../../bot/telegraf/bot';
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
import {
    emitTelemetryEvent,
    getTelegramCommandCategory,
    type TelemetryContext
} from '../telemetry';

export { compareSecrets, type SecretComparisonCrypto } from '../telegram-auth';

export type RuntimeTelegramUpdate = Update;

export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export interface TelegramRouteDependencies {
    handleUpdate?: (
        env: WorkerBindings,
        update: RuntimeTelegramUpdate,
        botKey: string,
        context?: TelemetryContext
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
    createBot: (
        env: WorkerBindings,
        telemetry?: PrincessBotTelemetry
    ) => PrincessBot = createPrincessBot,
    context?: TelemetryContext
) => {
    const bot = createBot(env, {
        voteCompleted(input) {
            emitTelemetryEvent(env, context, {
                event: 'vote_completed',
                outcome: 'success',
                ...input
            });
        },
        internalFailure(input) {
            emitTelemetryEvent(env, context, {
                ...input,
                outcome: 'error'
            });
        }
    });
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
        dependencies.handleUpdate ??
        ((env, update, botKey, context) => {
            return handleUpdateWithPrincessBot(
                env,
                update,
                botKey,
                createPrincessBot,
                context
            );
        });
    const secretsMatch = dependencies.secretsMatch ?? compareSecrets;
    const createUpdateLedger =
        dependencies.createUpdateLedger ?? createD1UpdateLedger;
    const deriveBotKey = dependencies.deriveBotKey ?? deriveTelegramBotKey;
    const createLeaseId =
        dependencies.createLeaseId ?? (() => crypto.randomUUID());
    const now = dependencies.now ?? (() => new Date());
    const logWarning = dependencies.logWarning ?? console.warn;

    app.post('*', async c => {
        const startedAt = Date.now();
        let commandCategory = 'notParsed';
        const getTelemetryContext = () => {
            try {
                return c.executionCtx;
            } catch {
                return undefined;
            }
        };
        const respond = (
            response: Response,
            outcome: string,
            idempotencyOutcome: string,
            rejectionReason?: string
        ) => {
            emitTelemetryEvent(c.env, getTelemetryContext(), {
                event: 'telegram_webhook_completed',
                method: 'POST',
                path: '/telegram/webhook',
                status: response.status,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome,
                commandCategory,
                idempotencyOutcome,
                ...(rejectionReason === undefined ? {} : { rejectionReason })
            });
            return response;
        };

        if (!hasRequiredWorkerConfiguration(c.env)) {
            return respond(
                c.json(
                    {
                        error: 'Telegram webhook is unavailable'
                    },
                    503
                ),
                'rejected',
                'notClaimed',
                'configuration'
            );
        }

        const expectedPath = getTelegramWebhookPath(c.env);
        const pathname = new URL(c.req.url).pathname;

        if (expectedPath === null || pathname !== expectedPath) {
            return respond(
                await c.notFound(),
                'rejected',
                'notClaimed',
                'path'
            );
        }

        const providedSecret = c.req.header(TELEGRAM_SECRET_HEADER) ?? '';

        if (
            !(await secretsMatch(providedSecret, c.env.TELEGRAM_WEBHOOK_SECRET))
        ) {
            return respond(
                c.json(
                    {
                        error: 'Invalid Telegram webhook secret'
                    },
                    401
                ),
                'rejected',
                'notClaimed',
                'authentication'
            );
        }

        if (!isJsonRequest(c.req.header('Content-Type'))) {
            return respond(
                c.json(
                    {
                        error: 'Content-Type must be application/json'
                    },
                    415
                ),
                'rejected',
                'notClaimed',
                'contentType'
            );
        }

        const body = await readLimitedJsonBody(c.req.raw);

        if (body.state === 'too-large') {
            return respond(
                c.json(
                    {
                        error: 'Telegram update payload is too large'
                    },
                    413
                ),
                'rejected',
                'notClaimed',
                'payloadTooLarge'
            );
        }

        if (body.state === 'malformed') {
            return respond(
                c.json(
                    {
                        error: 'Malformed JSON payload'
                    },
                    400
                ),
                'rejected',
                'notClaimed',
                'malformedPayload'
            );
        }

        const payload = body.payload;
        commandCategory = getTelegramCommandCategory(payload);

        if (isIgnorableTelegramUpdate(payload)) {
            return respond(
                c.json({
                    ignored: true,
                    updateId: payload.update_id
                }),
                'ignored',
                'notClaimed'
            );
        }

        if (!isRuntimeTelegramUpdate(payload)) {
            return respond(
                c.json(
                    {
                        error: 'Invalid Telegram update payload'
                    },
                    400
                ),
                'rejected',
                'notClaimed',
                'invalidUpdate'
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
            emitTelemetryEvent(c.env, getTelemetryContext(), {
                event: 'telegram_update_ledger_unavailable',
                outcome: 'error',
                errorType: getErrorType(error)
            });
            console.error(
                JSON.stringify({
                    event: 'telegram_update_ledger_unavailable',
                    errorType: getErrorType(error),
                    phase: 'claim'
                })
            );

            return respond(
                c.json(
                    {
                        error: 'Telegram update ledger is unavailable'
                    },
                    503
                ),
                'error',
                'unavailable',
                'ledger'
            );
        }

        if (claim.state === 'duplicate') {
            return respond(
                c.json(
                    {
                        accepted: true,
                        duplicate: true,
                        updateId: payload.update_id
                    },
                    200
                ),
                'accepted',
                'duplicate'
            );
        }

        if (claim.state === 'busy') {
            return respond(
                c.json(
                    {
                        error: 'Telegram update is already processing'
                    },
                    503
                ),
                'rejected',
                'busy',
                'processing'
            );
        }

        if (claim.reclaimed) {
            logWarning(
                JSON.stringify({
                    event: 'telegram_update_claim_reclaimed',
                    botEnvironment: c.env.BOT_ENVIRONMENT,
                    webhook: 'telegram'
                })
            );
        }

        let dispatchFailed = false;
        let dispatchError: unknown;

        try {
            await handleUpdate(c.env, payload, botKey, getTelemetryContext());
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
            emitTelemetryEvent(c.env, getTelemetryContext(), {
                event: 'telegram_update_terminalization_failed',
                outcome: dispatchFailed
                    ? 'dispatchFailed'
                    : 'dispatchSucceeded',
                errorType: getErrorType(error)
            });
            console.error(
                JSON.stringify({
                    event: 'telegram_update_terminalization_failed',
                    dispatchErrorType: dispatchFailed
                        ? getErrorType(dispatchError)
                        : null,
                    dispatchOutcome: dispatchFailed ? 'failed' : 'succeeded',
                    errorType: getErrorType(error),
                    phase: 'terminalize'
                })
            );

            return respond(
                c.json(
                    {
                        accepted: true,
                        updateId: payload.update_id
                    },
                    200
                ),
                'accepted',
                'uncertain'
            );
        }

        if (!terminalized) {
            emitTelemetryEvent(c.env, getTelemetryContext(), {
                event: 'telegram_update_lease_lost',
                outcome: dispatchFailed
                    ? 'dispatchFailed'
                    : 'dispatchSucceeded',
                ...(dispatchFailed
                    ? { errorType: getErrorType(dispatchError) }
                    : {})
            });
            console.error(
                JSON.stringify({
                    event: 'telegram_update_lease_lost',
                    dispatchErrorType: dispatchFailed
                        ? getErrorType(dispatchError)
                        : null,
                    dispatchOutcome: dispatchFailed ? 'failed' : 'succeeded',
                    phase: 'leaseLost'
                })
            );

            return respond(
                c.json(
                    {
                        accepted: true,
                        updateId: payload.update_id
                    },
                    200
                ),
                'accepted',
                'leaseLost'
            );
        }

        if (dispatchFailed) {
            emitTelemetryEvent(c.env, getTelemetryContext(), {
                event: 'telegram_update_dispatch_failed',
                outcome: 'error',
                errorType: getErrorType(dispatchError)
            });
            console.error(
                JSON.stringify({
                    event: 'telegram_update_dispatch_failed',
                    dispatchOutcome: 'failed',
                    errorType: getErrorType(dispatchError),
                    ledgerState: 'processed',
                    phase: 'dispatch'
                })
            );

            return respond(
                c.json(
                    {
                        accepted: true,
                        updateId: payload.update_id
                    },
                    200
                ),
                'error',
                'processed'
            );
        }

        return respond(
            c.json(
                {
                    accepted: true,
                    updateId: payload.update_id
                },
                200
            ),
            'accepted',
            'processed'
        );
    });
};
