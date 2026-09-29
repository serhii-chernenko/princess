import {
    getDefaultAppLocale,
    normalizeAppLocale,
    type AppLocale
} from '../../bot/i18n';
import { isSemverLower } from '../../bot/utils/semver';
import type { ReleaseAnnouncementJob } from './release-announcement-job';

export const QUEUE_MAX_RETRIES = 5;
export const QUEUE_MAX_DELIVERIES = QUEUE_MAX_RETRIES + 1;
export const MINIMUM_SEND_INTERVAL_MILLISECONDS = 50;
export const BACKOFF_BASE_SECONDS = 30;
export const BACKOFF_MAX_SECONDS = 3600;
export const QUEUE_MAX_DELAY_SECONDS = 43_200;
export const DISABLED_RETRY_DELAY_SECONDS = 600;
export const STATE_WRITE_MAX_ATTEMPTS = 3;
export const STATE_WRITE_BACKOFF_MILLISECONDS = 100;
export const LOGGED_DESCRIPTION_MAX_LENGTH = 100;

const strictSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const permanentBadRequestPattern =
    /chat not found|bot was kicked|bot is not a member|have no rights to send|chat_write_forbidden|user is deactivated|peer_id_invalid|group chat was deactivated/i;

export interface AnnouncementRecord {
    id: number;
    status: 'queued' | 'sending' | 'sent' | 'skipped' | 'failed';
}

export interface AnnouncementChannel {
    id: number;
    telegramChatId: number;
    language: string;
    releaseVersion: string;
}

export interface ReleaseAnnouncementMessage {
    body: unknown;
    attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
}

export interface ReleaseAnnouncementConsumerDependencies {
    isBroadcastEnabled: () => boolean;
    getCurrentReleaseVersion: () => string;
    findAnnouncement: (
        releaseVersion: string,
        channelId: number
    ) => Promise<AnnouncementRecord | null>;
    findChannel: (channelId: number) => Promise<AnnouncementChannel | null>;
    renderAnnouncement: (
        releaseVersion: string,
        locale: AppLocale
    ) => string | null;
    claimForSending: (announcementId: number, now: Date) => Promise<boolean>;
    sendMessage: (telegramChatId: number, html: string) => Promise<void>;
    markSent: (
        announcementId: number,
        channelId: number,
        releaseVersion: string,
        now: Date
    ) => Promise<void>;
    markSkipped: (
        announcementId: number,
        channelId: number,
        releaseVersion: string,
        errorCode: number | null,
        now: Date
    ) => Promise<void>;
    releaseToQueue: (
        announcementId: number,
        errorCode: number | null,
        countAttempt: boolean,
        now: Date
    ) => Promise<void>;
    markFailed: (
        announcementId: number,
        errorCode: number | null,
        now: Date
    ) => Promise<void>;
    migrateChannelChatId: (
        channelId: number,
        newTelegramChatId: number
    ) => Promise<boolean>;
    requeueJob: (
        job: ReleaseAnnouncementJob,
        delaySeconds: number
    ) => Promise<void>;
    sleep: (milliseconds: number) => Promise<void>;
    now: () => number;
    log: (entry: Record<string, unknown>) => void;
}

interface TelegramFailure {
    errorCode: number | null;
    description: string;
    retryAfterSeconds: number | null;
    migrateToChatId: number | null;
}

type SendOutcome =
    | { delivered: true }
    | { delivered: false; failure: TelegramFailure };

interface Pacing {
    lastSendAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const readNumber = (value: unknown) => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const classifyTelegramFailure = (error: unknown): TelegramFailure => {
    const response =
        isRecord(error) && isRecord(error.response) ? error.response : {};
    const parameters = isRecord(response.parameters) ? response.parameters : {};

    return {
        errorCode: readNumber(response.error_code),
        description:
            typeof response.description === 'string'
                ? response.description
                : '',
        retryAfterSeconds: readNumber(parameters.retry_after),
        migrateToChatId: readNumber(parameters.migrate_to_chat_id)
    };
};

export const getBackoffSeconds = (deliveryAttempt: number) => {
    const exponent = Math.max(0, deliveryAttempt - 1);

    return Math.min(BACKOFF_BASE_SECONDS * 2 ** exponent, BACKOFF_MAX_SECONDS);
};

const isValidJob = (body: unknown): body is ReleaseAnnouncementJob => {
    return (
        isRecord(body) &&
        typeof body.releaseVersion === 'string' &&
        strictSemverPattern.test(body.releaseVersion) &&
        typeof body.channelId === 'number' &&
        Number.isSafeInteger(body.channelId) &&
        body.channelId > 0
    );
};

const toLocale = (language: string): AppLocale => {
    return normalizeAppLocale(language) ?? getDefaultAppLocale();
};

const sendOnce = async (
    dependencies: ReleaseAnnouncementConsumerDependencies,
    pacing: Pacing,
    telegramChatId: number,
    text: string
): Promise<SendOutcome> => {
    if (pacing.lastSendAt !== null) {
        const waitMilliseconds =
            MINIMUM_SEND_INTERVAL_MILLISECONDS -
            (dependencies.now() - pacing.lastSendAt);

        if (waitMilliseconds > 0) {
            await dependencies.sleep(waitMilliseconds);
        }
    }

    pacing.lastSendAt = dependencies.now();

    try {
        await dependencies.sendMessage(telegramChatId, text);
        pacing.lastSendAt = dependencies.now();
        return { delivered: true };
    } catch (error) {
        pacing.lastSendAt = dependencies.now();
        return { delivered: false, failure: classifyTelegramFailure(error) };
    }
};

const isPermanentFailure = (failure: TelegramFailure) => {
    return (
        failure.errorCode === 403 ||
        (failure.errorCode === 400 &&
            permanentBadRequestPattern.test(failure.description))
    );
};

const handleMessage = async (
    message: ReleaseAnnouncementMessage,
    dependencies: ReleaseAnnouncementConsumerDependencies,
    pacing: Pacing
) => {
    if (!dependencies.isBroadcastEnabled()) {
        message.retry({ delaySeconds: DISABLED_RETRY_DELAY_SECONDS });
        return;
    }

    if (!isValidJob(message.body)) {
        dependencies.log({ event: 'release_announcement_invalid_job' });
        message.ack();
        return;
    }

    const job = message.body;
    const { releaseVersion, channelId } = job;

    if (releaseVersion !== dependencies.getCurrentReleaseVersion()) {
        dependencies.log({
            event: 'release_announcement_stale_job',
            releaseVersion,
            channelId
        });
        message.ack();
        return;
    }

    const announcement = await dependencies.findAnnouncement(
        releaseVersion,
        channelId
    );
    const channel = await dependencies.findChannel(channelId);

    if (
        !announcement ||
        !channel ||
        announcement.status === 'sent' ||
        announcement.status === 'skipped' ||
        announcement.status === 'failed' ||
        !isSemverLower(channel.releaseVersion, releaseVersion)
    ) {
        message.ack();
        return;
    }

    const logContext = { chatId: channel.telegramChatId, releaseVersion };

    const writeState = async (
        outcomeName: string,
        write: () => Promise<void>
    ) => {
        for (let attempt = 1; attempt <= STATE_WRITE_MAX_ATTEMPTS; attempt++) {
            try {
                await write();
                return true;
            } catch {
                if (attempt < STATE_WRITE_MAX_ATTEMPTS) {
                    await dependencies.sleep(
                        STATE_WRITE_BACKOFF_MILLISECONDS * attempt
                    );
                }
            }
        }

        dependencies.log({
            event: 'release_announcement_state_write_failed',
            outcome: outcomeName,
            ...logContext
        });
        return false;
    };
    const timestamp = () => new Date(dependencies.now());

    if (announcement.status === 'sending') {
        await writeState('ambiguous', () => {
            return dependencies.markSkipped(
                announcement.id,
                channel.id,
                releaseVersion,
                null,
                timestamp()
            );
        });
        dependencies.log({
            event: 'release_announcement_ambiguous',
            reason: 'redelivered_while_sending',
            ...logContext
        });
        message.ack();
        return;
    }

    const text = dependencies.renderAnnouncement(
        releaseVersion,
        toLocale(channel.language)
    );

    if (text === null) {
        dependencies.log({
            event: 'release_announcement_notes_missing',
            ...logContext
        });
        message.retry({ delaySeconds: getBackoffSeconds(message.attempts) });
        return;
    }

    const claimed = await dependencies.claimForSending(
        announcement.id,
        timestamp()
    );

    if (!claimed) {
        message.ack();
        return;
    }

    let outcome = await sendOnce(
        dependencies,
        pacing,
        channel.telegramChatId,
        text
    );
    let sentChatId = channel.telegramChatId;

    if (
        !outcome.delivered &&
        outcome.failure.errorCode === 400 &&
        outcome.failure.migrateToChatId !== null
    ) {
        const newChatId = outcome.failure.migrateToChatId;
        const migrated = await dependencies.migrateChannelChatId(
            channel.id,
            newChatId
        );

        if (!migrated) {
            await writeState('migrated_conflict', () => {
                return dependencies.markSkipped(
                    announcement.id,
                    channel.id,
                    releaseVersion,
                    400,
                    timestamp()
                );
            });
            dependencies.log({
                event: 'release_announcement_chat_migrated_conflict',
                ...logContext
            });
            message.ack();
            return;
        }

        dependencies.log({
            event: 'release_announcement_chat_migrated',
            ...logContext
        });
        sentChatId = newChatId;
        outcome = await sendOnce(dependencies, pacing, newChatId, text);
    }

    const sentLogContext = { chatId: sentChatId, releaseVersion };

    if (outcome.delivered) {
        await writeState('sent', () => {
            return dependencies.markSent(
                announcement.id,
                channel.id,
                releaseVersion,
                timestamp()
            );
        });
        dependencies.log({
            event: 'release_announcement_sent',
            ...sentLogContext
        });
        message.ack();
        return;
    }

    const { failure } = outcome;

    if (failure.errorCode === null) {
        await writeState('ambiguous', () => {
            return dependencies.markSkipped(
                announcement.id,
                channel.id,
                releaseVersion,
                null,
                timestamp()
            );
        });
        dependencies.log({
            event: 'release_announcement_ambiguous',
            reason: 'no_telegram_response',
            ...sentLogContext
        });
        message.ack();
        return;
    }

    if (isPermanentFailure(failure)) {
        await writeState('skipped', () => {
            return dependencies.markSkipped(
                announcement.id,
                channel.id,
                releaseVersion,
                failure.errorCode,
                timestamp()
            );
        });
        dependencies.log({
            event: 'release_announcement_skipped',
            errorCode: failure.errorCode,
            ...sentLogContext
        });
        message.ack();
        return;
    }

    if (failure.errorCode === 429) {
        const delaySeconds = Math.min(
            Math.ceil(failure.retryAfterSeconds ?? BACKOFF_BASE_SECONDS) + 1,
            QUEUE_MAX_DELAY_SECONDS
        );

        await dependencies.releaseToQueue(
            announcement.id,
            429,
            false,
            timestamp()
        );
        await dependencies.requeueJob(job, delaySeconds);
        dependencies.log({
            event: 'release_announcement_rate_limited',
            delaySeconds,
            ...sentLogContext
        });
        message.ack();
        return;
    }

    const isServerError = failure.errorCode >= 500;

    if (isServerError && message.attempts < QUEUE_MAX_DELIVERIES) {
        const delaySeconds = getBackoffSeconds(message.attempts);

        await dependencies.releaseToQueue(
            announcement.id,
            failure.errorCode,
            true,
            timestamp()
        );
        dependencies.log({
            event: 'release_announcement_retry',
            errorCode: failure.errorCode,
            attempts: message.attempts,
            delaySeconds,
            ...sentLogContext
        });
        message.retry({ delaySeconds });
        return;
    }

    await writeState('failed', () => {
        return dependencies.markFailed(
            announcement.id,
            failure.errorCode,
            timestamp()
        );
    });
    dependencies.log({
        event: 'release_announcement_failed',
        errorCode: failure.errorCode,
        attempts: message.attempts,
        description: failure.description.slice(
            0,
            LOGGED_DESCRIPTION_MAX_LENGTH
        ),
        ...sentLogContext
    });

    if (isServerError) {
        message.retry();
        return;
    }

    message.ack();
};

export const processReleaseAnnouncementBatch = async (
    messages: readonly ReleaseAnnouncementMessage[],
    dependencies: ReleaseAnnouncementConsumerDependencies
) => {
    const pacing: Pacing = { lastSendAt: null };

    for (const message of messages) {
        try {
            await handleMessage(message, dependencies, pacing);
        } catch (error) {
            dependencies.log({
                event: 'release_announcement_handler_error',
                errorType: error instanceof Error ? error.name : typeof error
            });
            message.retry({
                delaySeconds: getBackoffSeconds(message.attempts)
            });
        }
    }
};
