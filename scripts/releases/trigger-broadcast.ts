import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    loadOptionalEnvFile,
    requireEnv,
    type AppEnvTarget
} from '../cloudflare/runtime-env';

const BROADCAST_PATH = '/admin/release-broadcast';
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

export type BroadcastTarget = Extract<AppEnvTarget, 'production' | 'beta'>;

export const parseBroadcastTarget = (value: string | undefined) => {
    if (value === 'production' || value === 'beta') {
        return value satisfies BroadcastTarget;
    }

    throw new Error('Usage: trigger-broadcast.ts <production|beta>');
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

const run = async () => {
    const target = parseBroadcastTarget(process.argv[2]);

    loadOptionalEnvFile(target);

    const result = await triggerReleaseBroadcast(
        requireEnv('WORKER_BASE_URL'),
        requireEnv('TELEGRAM_WEBHOOK_SECRET')
    );

    console.log(result.body);

    if (!result.ok) {
        console.error(
            `Release broadcast trigger failed with HTTP ${result.status}`
        );
        process.exitCode = 1;
    }
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
