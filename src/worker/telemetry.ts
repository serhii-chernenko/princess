import { createRequestLogger, type WideEvent } from 'evlog';
import { createAxiomDrain } from 'evlog/axiom';
import { initWorkersLogger } from 'evlog/workers';

import { getTelegramWebhookPath, type WorkerBindings } from './env';

initWorkersLogger({
    env: {
        service: 'princess',
        environment: 'cloudflare-workers'
    },
    pretty: false,
    stringify: true,
    redact: true
});

export type TelemetryContext =
    | {
          waitUntil(promise: Promise<unknown>): void;
      }
    | undefined;

type TelemetryFields = {
    event: string;
    method?: string;
    path?: string;
    status?: number;
    durationMs?: number;
    outcome?: string;
    errorType?: string;
    cron?: string;
    taskNames?: readonly string[];
    messageCount?: number;
    commandCategory?: string;
    idempotencyOutcome?: string;
    rejectionReason?: string;
    candidates?: number;
    inserted?: number;
    enqueued?: number;
    cleanedChannels?: number;
    prunedProcessedTelegramUpdates?: number;
    prunedAbandonedTelegramUpdates?: number;
    releaseVersion?: string;
    errorCode?: number | null;
    delaySeconds?: number;
    attempts?: number;
    reason?: string;
    mode?: 'auto' | 'manual' | 'sudo';
    eligibleCount?: number;
};

const knownPaths = new Set(['/', '/health', '/admin/release-broadcast']);

const commandCategories = new Set([
    'start',
    'help',
    'join',
    'leave',
    'players',
    'top',
    'run',
    'sudorun',
    'sudo',
    'reset',
    'stats',
    'releases',
    'lang'
]);

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

/** Never place the configured Telegram route, arbitrary routes, or query data in telemetry. */
export const normalizeTelemetryPath = (
    path: string,
    telegramWebhookPath: string | null
) => {
    if (
        path === telegramWebhookPath ||
        path.startsWith('/telegram/') ||
        path === '/telegram'
    ) {
        return '/telegram/webhook';
    }

    return knownPaths.has(path) ? path : '/unknown';
};

export const getTelegramCommandCategory = (payload: unknown) => {
    if (
        typeof payload !== 'object' ||
        payload === null ||
        !('message' in payload) ||
        typeof payload.message !== 'object' ||
        payload.message === null ||
        !('text' in payload.message) ||
        typeof payload.message.text !== 'string'
    ) {
        return 'nonCommand';
    }

    const match = /^\/([a-z]+)(?:@[^\s]+)?(?:\s|$)/i.exec(
        payload.message.text.trim()
    );

    if (!match?.[1]) {
        return 'message';
    }

    const command = match[1].toLowerCase();

    return commandCategories.has(command) ? command : 'otherCommand';
};

const shipToAxiom = (
    event: WideEvent,
    env: Pick<WorkerBindings, 'AXIOM_TOKEN' | 'AXIOM_DATASET'>,
    context: TelemetryContext
) => {
    if (!env.AXIOM_TOKEN || !env.AXIOM_DATASET) {
        return;
    }

    const delivery = Promise.resolve()
        .then(() => {
            const drain = createAxiomDrain({
                apiKey: env.AXIOM_TOKEN,
                dataset: env.AXIOM_DATASET,
                edgeUrl: 'https://us-east-1.aws.edge.axiom.co'
            });

            return drain({ event });
        })
        .catch(error => {
            console.warn(
                JSON.stringify({
                    event: 'axiom_drain_failed',
                    errorType: getErrorType(error)
                })
            );
        });

    if (context) {
        context.waitUntil(delivery);
        return;
    }

    void delivery;
};

export const toPrincessAttributes = (
    fields: TelemetryFields,
    botEnvironment: WorkerBindings['BOT_ENVIRONMENT']
) => {
    return {
        attributes: {
            princess: {
                ...fields,
                botEnvironment
            }
        }
    };
};

export const emitTelemetryEvent = (
    env: WorkerBindings,
    context: TelemetryContext,
    fields: TelemetryFields
) => {
    try {
        const loggerOptions = {
            method: fields.method ?? 'WORKER',
            path: fields.path ?? '/internal/worker'
        };
        const logger = context
            ? createRequestLogger({
                  ...loggerOptions,
                  waitUntil: context.waitUntil.bind(context)
              })
            : createRequestLogger(loggerOptions);
        logger.set(toPrincessAttributes(fields, env.BOT_ENVIRONMENT));
        const event = logger.emit({
            environment: env.BOT_ENVIRONMENT,
            ...(fields.status === undefined ? {} : { status: fields.status })
        });

        if (event) {
            shipToAxiom(event, env, context);
        }
    } catch (error) {
        console.warn(
            JSON.stringify({
                event: 'telemetry_emit_failed',
                errorType: getErrorType(error)
            })
        );
    }
};

export const emitHttpRequestTelemetry = (
    request: Request,
    response: Response,
    env: WorkerBindings,
    context: ExecutionContext,
    startedAt: number
) => {
    const pathname = new URL(request.url).pathname;

    emitTelemetryEvent(env, context, {
        event: 'http_request_completed',
        method: request.method,
        path: normalizeTelemetryPath(pathname, getTelegramWebhookPath(env)),
        status: response.status,
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome: response.status >= 500 ? 'error' : 'success'
    });
};
