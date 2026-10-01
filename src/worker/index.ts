import { createApp } from './app';
import type { WorkerBindings } from './env';
import type { ReleaseAnnouncementJob } from './queues/release-announcement-job';
import { handleReleaseAnnouncementQueue } from './queues/release-announcements-handler';
import { runScheduledTasks } from './scheduled/tasks';
import { emitHttpRequestTelemetry, emitTelemetryEvent } from './telemetry';

const app = createApp();

export default {
    async fetch(request, env, ctx) {
        const startedAt = Date.now();

        try {
            const response = await app.fetch(request, env, ctx);

            emitHttpRequestTelemetry(request, response, env, ctx, startedAt);
            return response;
        } catch (error) {
            emitTelemetryEvent(env, ctx, {
                event: 'http_request_failed',
                method: request.method,
                path: '/unknown',
                status: 500,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome: 'error',
                errorType: error instanceof Error ? error.name : typeof error
            });
            throw error;
        }
    },
    async scheduled(controller, env, ctx) {
        const startedAt = Date.now();

        try {
            const summary = await runScheduledTasks(controller, env, ctx);

            emitTelemetryEvent(env, ctx, {
                event: 'scheduled_run_completed',
                cron: controller.cron,
                taskNames: summary.taskNames,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome: 'success',
                cleanedChannels: summary.cleanedChannels,
                prunedProcessedTelegramUpdates:
                    summary.prunedProcessedTelegramUpdates,
                prunedAbandonedTelegramUpdates:
                    summary.prunedAbandonedTelegramUpdates,
                prunedChannelSnapshots: summary.prunedChannelSnapshots
            });
        } catch (error) {
            emitTelemetryEvent(env, ctx, {
                event: 'scheduled_run_failed',
                cron: controller.cron,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome: 'error',
                errorType: error instanceof Error ? error.name : typeof error
            });
            throw error;
        }
    },
    async queue(batch, env, ctx) {
        const startedAt = Date.now();

        try {
            await handleReleaseAnnouncementQueue(batch, env, ctx);
            emitTelemetryEvent(env, ctx, {
                event: 'release_announcement_queue_batch_completed',
                messageCount: batch.messages.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome: 'success'
            });
        } catch (error) {
            emitTelemetryEvent(env, ctx, {
                event: 'release_announcement_queue_batch_failed',
                messageCount: batch.messages.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome: 'error',
                errorType: error instanceof Error ? error.name : typeof error
            });
            throw error;
        }
    }
} satisfies ExportedHandler<WorkerBindings, ReleaseAnnouncementJob>;
