import path from 'node:path';
import { pathToFileURL } from 'node:url';

import packageJson from '../../package.json';
import {
    loadOptionalEnvFile,
    type AppEnvTarget
} from '../cloudflare/runtime-env';

const BROADCAST_PATH = '/admin/release-broadcast';
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

const CREDENTIAL_KEYS = ['WORKER_BASE_URL', 'TELEGRAM_WEBHOOK_SECRET'] as const;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MILLISECONDS = 5_000;

export type BroadcastTarget = Extract<AppEnvTarget, 'production'>;

export const parseBroadcastTarget = (
    value: string | undefined
): BroadcastTarget => {
    if (value === 'production') {
        return value;
    }

    throw new Error('Usage: trigger-broadcast.ts <production>');
};

export const triggerReleaseBroadcast = async (
    workerBaseUrl: string,
    secret: string,
    fetchImplementation: typeof fetch = fetch
) => {
    const response = await fetchImplementation(
        `${workerBaseUrl.replace(/\/+$/, '')}${BROADCAST_PATH}`,
        {
            method: 'POST',
            headers: { [SECRET_HEADER]: secret },
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
        }
    );

    return {
        ok: response.ok,
        status: response.status,
        body: await response.text()
    };
};

export const resolveBroadcastCredentials = (
    target: BroadcastTarget,
    environment: Record<string, string | undefined> = process.env
) => {
    const readCredentials = () => {
        return {
            workerBaseUrl: environment.WORKER_BASE_URL,
            secret: environment.TELEGRAM_WEBHOOK_SECRET
        };
    };

    if (!readCredentials().workerBaseUrl || !readCredentials().secret) {
        loadOptionalEnvFile(target);
    }

    const { workerBaseUrl, secret } = readCredentials();

    if (!workerBaseUrl || !secret) {
        const missing = CREDENTIAL_KEYS.filter(key => !environment[key]);

        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`
        );
    }

    return { workerBaseUrl, secret };
};

const readReleaseVersion = (body: string) => {
    try {
        const parsed = JSON.parse(body) as {
            summary?: { releaseVersion?: unknown };
        };

        return parsed.summary?.releaseVersion;
    } catch {
        return undefined;
    }
};

export type BroadcastRunOptions = {
    workerBaseUrl: string;
    secret: string;
    expectedVersion?: string;
    maxAttempts?: number;
    retryDelayMilliseconds?: number;
    fetchImplementation?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    log?: (message: string) => void;
};

export const runReleaseBroadcast = async (options: BroadcastRunOptions) => {
    const {
        workerBaseUrl,
        secret,
        expectedVersion = packageJson.version,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        retryDelayMilliseconds = DEFAULT_RETRY_DELAY_MILLISECONDS,
        fetchImplementation = fetch,
        sleep = milliseconds => {
            return new Promise<void>(resolve => {
                setTimeout(resolve, milliseconds);
            });
        },
        log = console.log
    } = options;
    let lastReason = 'no attempt made';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await triggerReleaseBroadcast(
                workerBaseUrl,
                secret,
                fetchImplementation
            );

            if (result.status === 409) {
                log('Release broadcast is disabled (HTTP 409); skipping.');
                return 0;
            }

            if (result.status === 401 || result.status === 503) {
                log(result.body);
                log(`Release broadcast rejected with HTTP ${result.status}`);
                return 1;
            }

            if (result.ok) {
                const releaseVersion = readReleaseVersion(result.body);

                if (releaseVersion === expectedVersion) {
                    log(result.body);
                    return 0;
                }

                lastReason = `Worker reports release ${String(releaseVersion)}, expected ${expectedVersion}`;
            } else if (result.status === 404 || result.status >= 500) {
                lastReason = `HTTP ${result.status}`;
            } else {
                log(result.body);
                log(
                    `Release broadcast trigger failed with HTTP ${result.status}`
                );
                return 1;
            }
        } catch (error) {
            lastReason = `network error: ${error instanceof Error ? error.message : String(error)}`;
        }

        log(`Attempt ${attempt}/${maxAttempts} not ready: ${lastReason}`);

        if (attempt < maxAttempts) {
            await sleep(retryDelayMilliseconds);
        }
    }

    log(
        `Release broadcast gave up after ${maxAttempts} attempts: ${lastReason}`
    );
    return 1;
};

const run = async () => {
    const target = parseBroadcastTarget(process.argv[2]);
    const { workerBaseUrl, secret } = resolveBroadcastCredentials(target);

    process.exitCode = await runReleaseBroadcast({ workerBaseUrl, secret });
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    run().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
