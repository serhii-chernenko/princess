import type { WorkerApp } from '../app';
import { hasRequiredWorkerConfiguration } from '../env';
import {
    compareSecrets,
    TELEGRAM_SECRET_HEADER,
    type SecretMatcher
} from '../telegram-auth';

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

export interface HealthRouteDependencies {
    secretsMatch?: SecretMatcher;
}

export const registerHealthRoutes = (
    app: WorkerApp,
    dependencies: HealthRouteDependencies = {}
) => {
    const secretsMatch = dependencies.secretsMatch ?? compareSecrets;

    app.get('/health', async c => {
        const configurationReady = hasRequiredWorkerConfiguration(c.env);

        if (!configurationReady) {
            return c.json(
                {
                    service: 'princess',
                    runtime: 'cloudflare-workers',
                    ready: false,
                    checks: {
                        configuration: false,
                        database: false
                    }
                },
                503
            );
        }

        const providedSecret = c.req.header(TELEGRAM_SECRET_HEADER) ?? '';
        let authorized = false;

        try {
            authorized = await secretsMatch(
                providedSecret,
                c.env.TELEGRAM_WEBHOOK_SECRET
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'worker_readiness_auth_failed',
                    errorType: getErrorType(error)
                })
            );

            return c.json(
                {
                    error: 'Readiness authentication is unavailable'
                },
                503
            );
        }

        if (!authorized) {
            return c.json(
                {
                    error: 'Invalid readiness secret'
                },
                401
            );
        }

        let databaseReady = false;

        try {
            const readyValue =
                await c.env.DB.prepare('SELECT 1 AS ready').first<number>(
                    'ready'
                );

            databaseReady = readyValue === 1;
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'worker_readiness_check_failed',
                    check: 'database',
                    errorType: getErrorType(error)
                })
            );
        }

        const ready = databaseReady;

        return c.json(
            {
                service: 'princess',
                runtime: 'cloudflare-workers',
                ready,
                checks: {
                    configuration: configurationReady,
                    database: databaseReady
                }
            },
            ready ? 200 : 503
        );
    });
};
