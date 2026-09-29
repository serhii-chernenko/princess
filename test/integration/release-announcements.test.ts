import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { getLatestReleaseVersion } from '../../src/bot/content/releases';
import { processReleaseAnnouncementBatch } from '../../src/worker/queues/release-announcements';
import type { ReleaseAnnouncementMessage } from '../../src/worker/queues/release-announcements';
import { createReleaseAnnouncementDependencies } from '../../src/worker/queues/release-announcements-handler';
import type { ReleaseAnnouncementJob } from '../../src/worker/queues/release-announcement-job';
import {
    createReleaseBroadcastDependencies,
    runReleaseBroadcast
} from '../../src/worker/scheduled/release-broadcast';
import {
    countRows,
    createD1Harness,
    createWorkerEnv,
    type D1Harness
} from './d1-harness';

const currentVersion = getLatestReleaseVersion();
const outdatedChannelCount = 230;

interface AnnouncementRow {
    status: string;
    attempts: number;
    lastErrorCode: number | null;
}

describe('Release announcements on D1', () => {
    let harness: D1Harness;

    const seedChannels = (
        count: number,
        releaseVersion: string,
        firstChatId = -1000
    ) => {
        return harness.env.DB.prepare(
            `INSERT INTO channels (telegram_chat_id, language, release_version, created_at)
            WITH RECURSIVE sequence(n) AS (
                SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
            )
            SELECT ? - n, CASE WHEN n % 2 = 0 THEN 'en' ELSE 'ua' END, ?, 0 FROM sequence`
        )
            .bind(count, firstChatId, releaseVersion)
            .run();
    };
    const readAnnouncement = (channelId: number) => {
        return harness.env.DB.prepare(
            'SELECT status, attempts, last_error_code AS lastErrorCode FROM release_announcements WHERE channel_id = ? AND release_version = ?'
        )
            .bind(channelId, currentVersion)
            .first<AnnouncementRow>();
    };
    const readChannel = (channelId: number) => {
        return harness.env.DB.prepare(
            'SELECT release_version AS releaseVersion, language FROM channels WHERE id = ?'
        )
            .bind(channelId)
            .first<{ releaseVersion: string; language: string }>();
    };
    const runProducer = (batches: ReleaseAnnouncementJob[][]) => {
        const env = createWorkerEnv(harness, {
            ENABLE_RELEASE_BROADCAST: 'true'
        });

        return runReleaseBroadcast(env, {
            ...createReleaseBroadcastDependencies(env),
            async sendBatch(jobs) {
                batches.push(jobs);
            },
            log: () => undefined
        });
    };
    const createMessage = (
        channelId: number,
        attempts = 1
    ): ReleaseAnnouncementMessage => {
        return {
            body: { releaseVersion: currentVersion, channelId },
            attempts,
            ack() {},
            retry() {}
        };
    };
    const runConsumer = (
        message: ReleaseAnnouncementMessage,
        sendMessage: (chatId: number, html: string) => Promise<void>,
        requeueJob: (
            job: ReleaseAnnouncementJob,
            delaySeconds: number
        ) => Promise<void> = async () => undefined
    ) => {
        const env = createWorkerEnv(harness, {
            BOT_TOKEN: '123456:test',
            ENABLE_RELEASE_BROADCAST: 'true'
        });

        return processReleaseAnnouncementBatch([message], {
            ...createReleaseAnnouncementDependencies(env),
            sendMessage,
            requeueJob,
            log: () => undefined
        });
    };
    const findChannelId = async (telegramChatId: number) => {
        const row = await harness.env.DB.prepare(
            'SELECT id FROM channels WHERE telegram_chat_id = ?'
        )
            .bind(telegramChatId)
            .first<{ id: number }>();

        return row?.id as number;
    };
    const telegramError = (
        code: number,
        parameters?: { retry_after?: number; migrate_to_chat_id?: number }
    ) => {
        return Object.assign(new Error(`Telegram ${code}`), {
            response: { error_code: code, parameters }
        });
    };
    const forceStatus = (
        channelId: number,
        status: string,
        updatedAt: number
    ) => {
        return harness.env.DB.prepare(
            'UPDATE release_announcements SET status = ?, updated_at = ? WHERE channel_id = ? AND release_version = ?'
        )
            .bind(status, updatedAt, channelId, currentVersion)
            .run();
    };

    before(async () => {
        harness = await createD1Harness();
        await harness.applyMigrations();
    });

    after(async () => {
        await harness.dispose();
    });

    beforeEach(async () => {
        await harness.clearApplicationTables();
    });

    it('enforces status values, uniqueness and channel cascade deletes', async () => {
        const { DB } = harness.env;

        await seedChannels(1, '4.0.1');
        const channelId = await findChannelId(-1001);
        const insert = (status: string) => {
            return DB.prepare(
                "INSERT INTO release_announcements (release_version, channel_id, status, attempts, created_at, updated_at) VALUES ('5.0.0', ?, ?, 0, 0, 0)"
            )
                .bind(channelId, status)
                .run();
        };

        await assert.rejects(insert('bogus'), /CHECK/);
        await insert('sending');
        await DB.prepare('DELETE FROM release_announcements').run();
        await insert('queued');
        await assert.rejects(insert('queued'), /UNIQUE/);
        assert.equal(await countRows(harness, 'release_announcements'), 1);

        await DB.prepare('DELETE FROM channels WHERE id = ?')
            .bind(channelId)
            .run();

        assert.equal(await countRows(harness, 'release_announcements'), 0);
    });

    it('queues each outdated channel once across chunked inserts and repeated runs', async () => {
        await seedChannels(outdatedChannelCount, '4.0.1');
        await seedChannels(10, currentVersion, -5000);
        await seedChannels(3, 'garbage', -6000);

        const firstBatches: ReleaseAnnouncementJob[][] = [];
        const first = await runProducer(firstBatches);
        const secondBatches: ReleaseAnnouncementJob[][] = [];
        const second = await runProducer(secondBatches);
        const expected = outdatedChannelCount + 3;

        assert.equal(first?.inserted, expected);
        assert.equal(first?.enqueued, expected);
        assert.deepEqual(
            firstBatches.map(batch => batch.length),
            [100, 100, 33]
        );
        assert.equal(
            await countRows(harness, 'release_announcements'),
            expected
        );
        assert.equal(second?.enqueued, 0);
        assert.deepEqual(secondBatches, []);
        assert.equal(
            await countRows(harness, 'release_announcements'),
            expected
        );
    });

    it('never enqueues a channel twice when crons overlap', async () => {
        await seedChannels(120, '4.0.1');

        const batches: ReleaseAnnouncementJob[][] = [];

        await Promise.all([runProducer(batches), runProducer(batches)]);

        const channelIds = batches.flat().map(job => job.channelId);

        assert.equal(channelIds.length, 120);
        assert.equal(new Set(channelIds).size, 120);
        assert.equal(await countRows(harness, 'release_announcements'), 120);
    });

    it('rolls queued rows back when the queue rejects so the next run retries', async () => {
        await seedChannels(5, '4.0.1');

        const env = createWorkerEnv(harness, {
            ENABLE_RELEASE_BROADCAST: 'true'
        });

        await assert.rejects(
            runReleaseBroadcast(env, {
                ...createReleaseBroadcastDependencies(env),
                async sendBatch() {
                    throw new Error('queue down');
                },
                log: () => undefined
            }),
            /queue down/
        );
        assert.equal(await countRows(harness, 'release_announcements'), 0);

        const batches: ReleaseAnnouncementJob[][] = [];

        assert.equal((await runProducer(batches))?.enqueued, 5);
    });

    it('moves rows through sent, skipped, retry and failed states', async () => {
        await seedChannels(4, '4.0.1');
        await runProducer([]);

        const sentId = await findChannelId(-1001);
        const blockedId = await findChannelId(-1002);
        const limitedId = await findChannelId(-1003);
        const brokenId = await findChannelId(-1004);
        const deliveredTexts: string[] = [];

        await runConsumer(createMessage(sentId), async (_chatId, html) => {
            deliveredTexts.push(html);
        });
        await runConsumer(createMessage(blockedId), async () => {
            throw telegramError(403);
        });
        const requeued: [ReleaseAnnouncementJob, number][] = [];

        await runConsumer(
            createMessage(limitedId),
            async () => {
                throw telegramError(429, { retry_after: 7 });
            },
            async (job, delaySeconds) => {
                requeued.push([job, delaySeconds]);
            }
        );
        await runConsumer(createMessage(brokenId, 6), async () => {
            throw telegramError(500);
        });

        assert.deepEqual(await readAnnouncement(sentId), {
            status: 'sent',
            attempts: 1,
            lastErrorCode: null
        });
        assert.equal(
            (await readChannel(sentId))?.releaseVersion,
            currentVersion
        );
        assert.match(deliveredTexts[0] ?? '', /Бот оновлено до версії/);

        assert.deepEqual(await readAnnouncement(blockedId), {
            status: 'skipped',
            attempts: 1,
            lastErrorCode: 403
        });
        assert.equal(
            (await readChannel(blockedId))?.releaseVersion,
            currentVersion
        );

        assert.deepEqual(requeued, [
            [{ releaseVersion: currentVersion, channelId: limitedId }, 8]
        ]);
        assert.deepEqual(await readAnnouncement(limitedId), {
            status: 'queued',
            attempts: 0,
            lastErrorCode: 429
        });
        assert.equal((await readChannel(limitedId))?.releaseVersion, '4.0.1');

        assert.deepEqual(await readAnnouncement(brokenId), {
            status: 'skipped',
            attempts: 1,
            lastErrorCode: 500
        });
        assert.equal(
            (await readChannel(brokenId))?.releaseVersion,
            currentVersion
        );
        assert.equal(await countRows(harness, 'channels'), 4);
    });

    it('renders English announcements for en channels and ignores duplicates', async () => {
        await seedChannels(2, '4.0.1');
        await runProducer([]);

        const englishId = await findChannelId(-1002);
        const delivered: string[] = [];
        const send = async (_chatId: number, html: string) => {
            delivered.push(html);
        };

        await runConsumer(createMessage(englishId), send);
        await runConsumer(createMessage(englishId), send);

        assert.equal(delivered.length, 1);
        assert.match(delivered[0] ?? '', /The bot has been updated to version/);
        assert.deepEqual(await readAnnouncement(englishId), {
            status: 'sent',
            attempts: 1,
            lastErrorCode: null
        });
    });

    it('does not enqueue again after every channel reached the version', async () => {
        await seedChannels(3, '4.0.1');
        await runProducer([]);

        for (const chatId of [-1001, -1002, -1003]) {
            await runConsumer(
                createMessage(await findChannelId(chatId)),
                async () => undefined
            );
        }

        const batches: ReleaseAnnouncementJob[][] = [];

        assert.equal((await runProducer(batches))?.candidates, 0);
        assert.deepEqual(batches, []);
    });

    it('claims a queued row exactly once and refuses a second sender', async () => {
        await seedChannels(1, '4.0.1');
        await runProducer([]);

        const channelId = await findChannelId(-1001);
        const delivered: string[] = [];
        const env = createWorkerEnv(harness, {
            BOT_TOKEN: '123456:test',
            ENABLE_RELEASE_BROADCAST: 'true'
        });
        const dependencies = createReleaseAnnouncementDependencies(env);
        const announcement = await dependencies.findAnnouncement(
            currentVersion,
            channelId
        );
        const first = await dependencies.claimForSending(
            announcement?.id as number,
            new Date()
        );
        const second = await dependencies.claimForSending(
            announcement?.id as number,
            new Date()
        );

        assert.equal(first, true);
        assert.equal(second, false);
        assert.equal((await readAnnouncement(channelId))?.status, 'sending');

        await runConsumer(createMessage(channelId), async (_chatId, html) => {
            delivered.push(html);
        });

        assert.deepEqual(delivered, []);
        assert.deepEqual(await readAnnouncement(channelId), {
            status: 'skipped',
            attempts: 1,
            lastErrorCode: null
        });
        assert.equal(
            (await readChannel(channelId))?.releaseVersion,
            currentVersion
        );
    });

    it('treats a network failure as ambiguous and never resends', async () => {
        await seedChannels(1, '4.0.1');
        await runProducer([]);

        const channelId = await findChannelId(-1001);
        let sends = 0;
        const send = async () => {
            sends += 1;
            throw new TypeError('fetch failed');
        };

        await runConsumer(createMessage(channelId), send);
        await runConsumer(createMessage(channelId), send);

        assert.equal(sends, 1);
        assert.deepEqual(await readAnnouncement(channelId), {
            status: 'skipped',
            attempts: 1,
            lastErrorCode: null
        });
    });

    it('moves a migrated chat to the new id and sends there once', async () => {
        await seedChannels(1, '4.0.1');
        await runProducer([]);

        const channelId = await findChannelId(-1001);
        const sentTo: number[] = [];

        await runConsumer(createMessage(channelId), async chatId => {
            sentTo.push(chatId);

            if (chatId === -1001) {
                throw telegramError(400, { migrate_to_chat_id: -100777 });
            }
        });

        assert.deepEqual(sentTo, [-1001, -100777]);
        assert.equal(await findChannelId(-100777), channelId);
        assert.equal((await readAnnouncement(channelId))?.status, 'sent');
    });

    it('skips a migrated chat whose new id already belongs to another channel', async () => {
        await seedChannels(2, '4.0.1');
        await runProducer([]);

        const channelId = await findChannelId(-1001);
        const otherId = await findChannelId(-1002);
        const sentTo: number[] = [];

        await runConsumer(createMessage(channelId), async chatId => {
            sentTo.push(chatId);
            throw telegramError(400, { migrate_to_chat_id: -1002 });
        });

        assert.deepEqual(sentTo, [-1001]);
        assert.equal(await findChannelId(-1001), channelId);
        assert.equal(await findChannelId(-1002), otherId);
        assert.deepEqual(await readAnnouncement(channelId), {
            status: 'skipped',
            attempts: 1,
            lastErrorCode: 400
        });
        assert.equal(await countRows(harness, 'channels'), 2);
    });

    it('fails an unclassified 400 without bumping the channel version', async () => {
        await seedChannels(1, '4.0.1');
        await runProducer([]);

        const channelId = await findChannelId(-1001);

        await runConsumer(createMessage(channelId), async () => {
            throw telegramError(400);
        });

        assert.equal((await readAnnouncement(channelId))?.status, 'failed');
        assert.equal((await readChannel(channelId))?.releaseVersion, '4.0.1');
    });

    it('re-enqueues stale queued rows and skips stuck sending rows', async () => {
        await seedChannels(3, '4.0.1');
        await runProducer([]);

        const staleId = await findChannelId(-1001);
        const freshId = await findChannelId(-1002);
        const stuckId = await findChannelId(-1003);
        const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;

        await forceStatus(staleId, 'queued', fourHoursAgo);
        await forceStatus(stuckId, 'sending', fourHoursAgo);

        const batches: ReleaseAnnouncementJob[][] = [];

        await runProducer(batches);

        assert.deepEqual(batches, [
            [{ releaseVersion: currentVersion, channelId: staleId }]
        ]);
        assert.equal((await readAnnouncement(staleId))?.status, 'queued');
        assert.equal((await readAnnouncement(freshId))?.status, 'queued');
        assert.deepEqual(await readAnnouncement(stuckId), {
            status: 'skipped',
            attempts: 1,
            lastErrorCode: null
        });
        assert.equal(
            (await readChannel(stuckId))?.releaseVersion,
            currentVersion
        );

        const secondBatches: ReleaseAnnouncementJob[][] = [];

        await runProducer(secondBatches);

        assert.deepEqual(secondBatches, []);
    });
});
