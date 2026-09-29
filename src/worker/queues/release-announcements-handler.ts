import { Effect } from 'effect';
import { Telegram } from 'telegraf';

import {
    getLatestReleaseVersion,
    getReleases,
    renderReleaseAnnouncement
} from '../../bot/content/releases';
import { createDb } from '../../db/client';
import { createRepositories } from '../../db/repositories';
import type { WorkerBindings } from '../env';
import type { ReleaseAnnouncementJob } from './release-announcement-job';
import {
    processReleaseAnnouncementBatch,
    type ReleaseAnnouncementConsumerDependencies
} from './release-announcements';

export const createReleaseAnnouncementDependencies = (
    env: WorkerBindings
): ReleaseAnnouncementConsumerDependencies => {
    const repositories = createRepositories(createDb(env));
    const telegram = new Telegram(env.BOT_TOKEN);

    return {
        isBroadcastEnabled: () => env.ENABLE_RELEASE_BROADCAST === 'true',
        getCurrentReleaseVersion: getLatestReleaseVersion,
        findAnnouncement(releaseVersion, channelId) {
            return Effect.runPromise(
                repositories.releaseAnnouncements.findAnnouncement(
                    releaseVersion,
                    channelId
                )
            );
        },
        findChannel(channelId) {
            return Effect.runPromise(
                repositories.channels.findChannelById(channelId)
            );
        },
        renderAnnouncement(releaseVersion, locale) {
            const release = getReleases().find(candidate => {
                return candidate.version === releaseVersion;
            });

            return release ? renderReleaseAnnouncement(release, locale) : null;
        },
        async claimForSending(announcementId, now) {
            return Effect.runPromise(
                repositories.releaseAnnouncements.claimForSending(
                    announcementId,
                    now
                )
            );
        },
        async sendMessage(telegramChatId, html) {
            await telegram.sendMessage(telegramChatId, html, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true }
            });
        },
        async markSent(announcementId, channelId, releaseVersion, now) {
            await Effect.runPromise(
                repositories.releaseAnnouncements.markSent(
                    announcementId,
                    channelId,
                    releaseVersion,
                    now
                )
            );
        },
        async markSkipped(
            announcementId,
            channelId,
            releaseVersion,
            errorCode,
            now
        ) {
            await Effect.runPromise(
                repositories.releaseAnnouncements.markSkipped(
                    announcementId,
                    channelId,
                    releaseVersion,
                    errorCode,
                    now
                )
            );
        },
        async releaseToQueue(announcementId, errorCode, countAttempt, now) {
            await Effect.runPromise(
                repositories.releaseAnnouncements.releaseToQueue(
                    announcementId,
                    errorCode,
                    countAttempt,
                    now
                )
            );
        },
        async markFailed(announcementId, errorCode, now) {
            await Effect.runPromise(
                repositories.releaseAnnouncements.markFailed(
                    announcementId,
                    errorCode,
                    now
                )
            );
        },
        migrateChannelChatId(channelId, newTelegramChatId) {
            return Effect.runPromise(
                repositories.releaseAnnouncements.migrateChannelChatId(
                    channelId,
                    newTelegramChatId
                )
            );
        },
        async requeueJob(job, delaySeconds) {
            await env.RELEASE_QUEUE.send(job, { delaySeconds });
        },
        sleep(milliseconds) {
            return new Promise(resolve => {
                setTimeout(resolve, milliseconds);
            });
        },
        now: () => Date.now(),
        log: entry => console.log(JSON.stringify(entry))
    };
};

export const handleReleaseAnnouncementQueue = (
    batch: MessageBatch<ReleaseAnnouncementJob>,
    env: WorkerBindings
) => {
    return processReleaseAnnouncementBatch(
        batch.messages,
        createReleaseAnnouncementDependencies(env)
    );
};
