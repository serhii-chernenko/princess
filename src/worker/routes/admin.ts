import type { WorkerApp } from '../app';
import { hasRequiredWorkerConfiguration, type WorkerBindings } from '../env';
import {
    runReleaseBroadcast,
    type ReleaseBroadcastSummary
} from '../scheduled/release-broadcast';
import {
    compareSecrets,
    TELEGRAM_SECRET_HEADER,
    type SecretMatcher
} from '../telegram-auth';

export const RELEASE_BROADCAST_ADMIN_PATH = '/admin/release-broadcast';

export interface AdminRouteDependencies {
    secretsMatch?: SecretMatcher;
    broadcastRelease?: (
        env: WorkerBindings
    ) => Promise<ReleaseBroadcastSummary | null>;
}

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

export const registerAdminRoutes = (
    app: WorkerApp,
    dependencies: AdminRouteDependencies = {}
) => {
    const secretsMatch = dependencies.secretsMatch ?? compareSecrets;
    const broadcastRelease =
        dependencies.broadcastRelease ?? runReleaseBroadcast;

    app.post(RELEASE_BROADCAST_ADMIN_PATH, async c => {
        if (!hasRequiredWorkerConfiguration(c.env)) {
            return c.json({ error: 'Admin endpoint is unavailable' }, 503);
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
                    event: 'worker_admin_auth_failed',
                    errorType: getErrorType(error)
                })
            );

            return c.json(
                { error: 'Admin authentication is unavailable' },
                503
            );
        }

        if (!authorized) {
            return c.json({ error: 'Invalid admin secret' }, 401);
        }

        if (c.env.ENABLE_RELEASE_BROADCAST !== 'true') {
            return c.json(
                {
                    error: 'Release broadcast is disabled',
                    enabled: false
                },
                409
            );
        }

        try {
            const summary = await broadcastRelease(c.env);

            return c.json({ enabled: true, summary });
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'release_broadcast_manual_trigger_failed',
                    botEnvironment: c.env.BOT_ENVIRONMENT,
                    errorType: getErrorType(error)
                })
            );

            return c.json({ error: 'Release broadcast failed' }, 500);
        }
    });
};
