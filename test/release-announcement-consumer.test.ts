import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    DISABLED_RETRY_DELAY_SECONDS,
    getBackoffSeconds,
    LOGGED_DESCRIPTION_MAX_LENGTH,
    processReleaseAnnouncementBatch,
    QUEUE_MAX_DELIVERIES,
    QUEUE_MAX_RETRIES,
    STATE_WRITE_MAX_ATTEMPTS,
    type AnnouncementChannel,
    type AnnouncementRecord,
    type ReleaseAnnouncementConsumerDependencies,
    type ReleaseAnnouncementMessage
} from '../src/worker/queues/release-announcements';

const releaseVersion = '5.0.0';

const telegramError = (
    code: number,
    options: {
        retryAfter?: number;
        description?: string;
        migrateTo?: number;
    } = {}
) => {
    return Object.assign(new Error(`Telegram ${code}`), {
        response: {
            ok: false,
            error_code: code,
            description: options.description,
            parameters:
                options.retryAfter || options.migrateTo
                    ? {
                          retry_after: options.retryAfter,
                          migrate_to_chat_id: options.migrateTo
                      }
                    : undefined
        }
    });
};

interface Scenario {
    announcement?: AnnouncementRecord | null;
    channel?: AnnouncementChannel | null;
    sendErrors?: unknown[];
    sendError?: unknown;
    rendered?: string | null;
    enabled?: boolean;
    claimed?: boolean;
    migrated?: boolean;
    currentVersion?: string;
}

const createHarness = (scenario: Scenario = {}) => {
    const announcement =
        scenario.announcement === undefined
            ? { id: 10, status: 'queued' as const }
            : scenario.announcement;
    const channel =
        scenario.channel === undefined
            ? {
                  id: 1,
                  telegramChatId: -1001,
                  language: 'ua',
                  releaseVersion: '4.0.1'
              }
            : scenario.channel;
    const pendingErrors = [...(scenario.sendErrors ?? [])];
    const state = {
        sent: [] as { chatId: number; html: string }[],
        marks: [] as unknown[][],
        sleeps: [] as number[],
        logs: [] as Record<string, unknown>[],
        requeued: [] as { job: unknown; delaySeconds: number }[],
        migrations: [] as number[][],
        claims: 0,
        clock: 1000,
        locales: [] as string[]
    };
    const dependencies: ReleaseAnnouncementConsumerDependencies = {
        isBroadcastEnabled: () => scenario.enabled ?? true,
        getCurrentReleaseVersion: () => {
            return scenario.currentVersion ?? releaseVersion;
        },
        async findAnnouncement() {
            return announcement;
        },
        async findChannel() {
            return channel;
        },
        renderAnnouncement(_version, locale) {
            state.locales.push(locale);
            return scenario.rendered === undefined
                ? `announcement ${locale}`
                : scenario.rendered;
        },
        async claimForSending() {
            state.claims += 1;
            return scenario.claimed ?? true;
        },
        async sendMessage(chatId, html) {
            const queuedError = pendingErrors.shift();

            if (queuedError) {
                throw queuedError;
            }

            if (scenario.sendError) {
                throw scenario.sendError;
            }

            state.sent.push({ chatId, html });
        },
        async markSent(...arguments_) {
            state.marks.push(['sent', ...arguments_.slice(0, 3)]);
        },
        async markSkipped(...arguments_) {
            state.marks.push(['skipped', ...arguments_.slice(0, 4)]);
        },
        async releaseToQueue(...arguments_) {
            state.marks.push(['queued', ...arguments_.slice(0, 3)]);
        },
        async markFailed(...arguments_) {
            state.marks.push(['failed', ...arguments_.slice(0, 2)]);
        },
        async migrateChannelChatId(channelId, newChatId) {
            state.migrations.push([channelId, newChatId]);
            return scenario.migrated ?? true;
        },
        async requeueJob(job, delaySeconds) {
            state.requeued.push({ job, delaySeconds });
        },
        async sleep(milliseconds) {
            state.sleeps.push(milliseconds);
            state.clock += milliseconds;
        },
        now: () => state.clock,
        log: entry => state.logs.push(entry)
    };

    return { dependencies, state };
};

const createMessage = (
    attempts = 1,
    channelId = 1,
    body: unknown = { releaseVersion, channelId }
) => {
    const outcome = {
        acked: false,
        retried: false,
        retryOptions: undefined as { delaySeconds?: number } | undefined
    };
    const message: ReleaseAnnouncementMessage = {
        body,
        attempts,
        ack() {
            outcome.acked = true;
        },
        retry(options) {
            outcome.retried = true;
            outcome.retryOptions = options;
        }
    };

    return { message, outcome };
};

const runOne = async (scenario: Scenario, attempts = 1, body?: unknown) => {
    const harness = createHarness(scenario);
    const { message, outcome } = createMessage(attempts, 1, body);

    await processReleaseAnnouncementBatch([message], harness.dependencies);

    return { ...harness, outcome };
};

test('successful delivery marks the row sent and acknowledges', async () => {
    const { dependencies, state } = createHarness();
    const { message, outcome } = createMessage();

    await processReleaseAnnouncementBatch([message], dependencies);

    assert.equal(outcome.acked, true);
    assert.equal(outcome.retried, false);
    assert.deepEqual(state.sent, [{ chatId: -1001, html: 'announcement ua' }]);
    assert.deepEqual(state.marks, [['sent', 10, 1, releaseVersion]]);
    assert.equal(state.logs[0]?.event, 'release_announcement_sent');
    assert.deepEqual(Object.keys(state.logs[0] ?? {}).sort(), [
        'chatId',
        'event',
        'releaseVersion'
    ]);
});

test('the announcement is rendered in the channel language', async () => {
    const { dependencies, state } = createHarness({
        channel: {
            id: 1,
            telegramChatId: -1001,
            language: 'en',
            releaseVersion: '4.0.1'
        }
    });

    await processReleaseAnnouncementBatch(
        [createMessage().message],
        dependencies
    );

    assert.deepEqual(state.locales, ['en']);
    assert.equal(state.sent[0]?.html, 'announcement en');
});

test('429 acknowledges and re-enqueues a fresh job without counting an attempt', async () => {
    const { outcome, state } = await runOne({
        sendError: telegramError(429, { retryAfter: 12 })
    });

    assert.equal(outcome.acked, true);
    assert.equal(outcome.retried, false);
    assert.deepEqual(state.requeued, [
        { job: { releaseVersion, channelId: 1 }, delaySeconds: 13 }
    ]);
    assert.deepEqual(state.marks, [['queued', 10, 429, false]]);
    assert.equal(state.logs[0]?.event, 'release_announcement_rate_limited');
});

test('403 skips the chat, keeps the channel and acknowledges', async () => {
    const { outcome, state } = await runOne({ sendError: telegramError(403) });

    assert.equal(outcome.acked, true);
    assert.equal(outcome.retried, false);
    assert.deepEqual(state.marks, [['skipped', 10, 1, releaseVersion, 403]]);
    assert.equal(state.logs[0]?.event, 'release_announcement_skipped');
});

test('permanent 400 descriptions skip the chat case-insensitively', async () => {
    const descriptions = [
        'Bad Request: chat not found',
        'Bad Request: bot was kicked from the supergroup chat',
        'Bad Request: bot is not a member of the channel chat',
        'Bad Request: have no rights to send a message',
        'Bad Request: CHAT_WRITE_FORBIDDEN',
        'Bad Request: user is deactivated',
        'Bad Request: PEER_ID_INVALID',
        'Bad Request: GROUP CHAT WAS DEACTIVATED'
    ];

    for (const description of descriptions) {
        const { outcome, state } = await runOne({
            sendError: telegramError(400, { description })
        });

        assert.equal(outcome.acked, true, description);
        assert.deepEqual(
            state.marks,
            [['skipped', 10, 1, releaseVersion, 400]],
            description
        );
    }
});

test('other 400 errors fail the row without bumping the version and log a truncated description', async () => {
    const description = `Bad Request: can't parse entities ${'x'.repeat(500)}`;
    const { outcome, state } = await runOne({
        sendError: telegramError(400, { description })
    });

    assert.equal(outcome.acked, true);
    assert.equal(outcome.retried, false);
    assert.deepEqual(state.marks, [['failed', 10, 400]]);
    assert.equal(state.logs[0]?.event, 'release_announcement_failed');
    assert.equal(
        String(state.logs[0]?.description).length,
        LOGGED_DESCRIPTION_MAX_LENGTH
    );
});

test('a migrated chat is updated and the announcement is sent once more to the new id', async () => {
    const { outcome, state } = await runOne({
        sendErrors: [
            telegramError(400, {
                description: 'Bad Request: group chat was upgraded',
                migrateTo: -100200
            })
        ]
    });

    assert.deepEqual(state.migrations, [[1, -100200]]);
    assert.deepEqual(state.sent, [
        { chatId: -100200, html: 'announcement ua' }
    ]);
    assert.deepEqual(state.marks, [['sent', 10, 1, releaseVersion]]);
    assert.equal(outcome.acked, true);
    assert.equal(state.logs[0]?.event, 'release_announcement_chat_migrated');
});

test('a migrated chat applies the normal outcome when the retry fails', async () => {
    const { outcome, state } = await runOne({
        sendErrors: [
            telegramError(400, { migrateTo: -100200 }),
            telegramError(403)
        ]
    });

    assert.deepEqual(state.marks, [['skipped', 10, 1, releaseVersion, 403]]);
    assert.equal(outcome.acked, true);
    assert.equal(state.migrations.length, 1);
});

test('a migration target already owned by another channel skips without sending', async () => {
    const { outcome, state } = await runOne({
        migrated: false,
        sendErrors: [telegramError(400, { migrateTo: -100200 })]
    });

    assert.deepEqual(state.sent, []);
    assert.deepEqual(state.marks, [['skipped', 10, 1, releaseVersion, 400]]);
    assert.equal(outcome.acked, true);
    assert.equal(
        state.logs[0]?.event,
        'release_announcement_chat_migrated_conflict'
    );
});

test('any 5xx is ambiguous, skipped with its status code and never resent', async () => {
    for (const errorCode of [500, 502, 504]) {
        for (const attempts of [1, QUEUE_MAX_DELIVERIES]) {
            const { outcome, state } = await runOne(
                { sendError: telegramError(errorCode) },
                attempts
            );

            assert.equal(outcome.acked, true);
            assert.equal(outcome.retried, false);
            assert.deepEqual(state.marks, [
                ['skipped', 10, 1, releaseVersion, errorCode]
            ]);
            assert.equal(
                state.logs[0]?.event,
                'release_announcement_ambiguous'
            );
            assert.equal(state.logs[0]?.errorCode, errorCode);
            assert.deepEqual(state.sent, []);
        }
    }
});

test('a network failure without a Telegram response is ambiguous and never resent', async () => {
    const { outcome, state } = await runOne({
        sendError: new TypeError('fetch failed')
    });

    assert.equal(outcome.acked, true);
    assert.equal(outcome.retried, false);
    assert.deepEqual(state.marks, [['skipped', 10, 1, releaseVersion, null]]);
    assert.equal(state.logs[0]?.event, 'release_announcement_ambiguous');
    assert.deepEqual(state.sent, []);
});

test('backoff is capped at one hour', () => {
    assert.equal(getBackoffSeconds(1), 30);
    assert.equal(getBackoffSeconds(8), 3600);
    assert.equal(getBackoffSeconds(50), 3600);
});

test('queue delivery limits match the committed wrangler consumers', () => {
    const config = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8')
    );

    const consumers = config.env.production.queues.consumers;

    assert.equal(consumers.length, 1);
    assert.equal(consumers[0].max_retries, QUEUE_MAX_RETRIES);

    assert.equal(QUEUE_MAX_DELIVERIES, QUEUE_MAX_RETRIES + 1);
});

test('duplicate delivery of a settled row acknowledges without sending', async () => {
    for (const status of ['sent', 'skipped', 'failed'] as const) {
        const { outcome, state } = await runOne({
            announcement: { id: 10, status }
        });

        assert.equal(outcome.acked, true);
        assert.deepEqual(state.sent, []);
        assert.deepEqual(state.marks, []);
    }
});

test('a row already in sending is ambiguous: skipped, logged and never resent', async () => {
    const { outcome, state } = await runOne({
        announcement: { id: 10, status: 'sending' }
    });

    assert.equal(outcome.acked, true);
    assert.deepEqual(state.sent, []);
    assert.equal(state.claims, 0);
    assert.deepEqual(state.marks, [['skipped', 10, 1, releaseVersion, null]]);
    assert.equal(state.logs[0]?.event, 'release_announcement_ambiguous');
});

test('a lost compare-and-set acknowledges without sending', async () => {
    const { outcome, state } = await runOne({ claimed: false });

    assert.equal(outcome.acked, true);
    assert.deepEqual(state.sent, []);
    assert.deepEqual(state.marks, []);
});

test('a channel already on or past the version is acknowledged without sending', async () => {
    for (const channelVersion of ['5.0.0', '5.1.0']) {
        const { outcome, state } = await runOne({
            channel: {
                id: 1,
                telegramChatId: -1001,
                language: 'ua',
                releaseVersion: channelVersion
            }
        });

        assert.equal(outcome.acked, true);
        assert.deepEqual(state.sent, []);
    }
});

test('a missing channel or announcement row is acknowledged', async () => {
    for (const scenario of [{ channel: null }, { announcement: null }]) {
        const { outcome, state } = await runOne(scenario);

        assert.equal(outcome.acked, true);
        assert.deepEqual(state.sent, []);
    }
});

test('missing release notes retry without touching state', async () => {
    const { outcome, state } = await runOne({ rendered: null });

    assert.equal(outcome.acked, false);
    assert.deepEqual(outcome.retryOptions, { delaySeconds: 30 });
    assert.deepEqual(state.sent, []);
    assert.equal(state.claims, 0);
});

test('the kill switch retries every message after ten minutes without sending or writing', async () => {
    const { outcome, state } = await runOne({ enabled: false });

    assert.equal(outcome.acked, false);
    assert.deepEqual(outcome.retryOptions, {
        delaySeconds: DISABLED_RETRY_DELAY_SECONDS
    });
    assert.equal(DISABLED_RETRY_DELAY_SECONDS, 600);
    assert.deepEqual(state.sent, []);
    assert.deepEqual(state.marks, []);
    assert.equal(state.claims, 0);
});

test('invalid job bodies are acknowledged and logged', async () => {
    const bodies = [
        null,
        'text',
        {},
        { releaseVersion: '5.0', channelId: 1 },
        { releaseVersion: '05.0.0', channelId: 1 },
        { releaseVersion: '5.0.0-rc', channelId: 1 },
        { releaseVersion, channelId: 0 },
        { releaseVersion, channelId: -3 },
        { releaseVersion, channelId: 1.5 },
        { releaseVersion, channelId: Number.MAX_SAFE_INTEGER + 2 },
        { releaseVersion, channelId: '1' }
    ];

    for (const body of bodies) {
        const { outcome, state } = await runOne({}, 1, body);

        assert.equal(outcome.acked, true, JSON.stringify(body));
        assert.equal(state.logs[0]?.event, 'release_announcement_invalid_job');
        assert.deepEqual(state.sent, []);
        assert.equal(state.claims, 0);
    }
});

test('jobs for a release that is no longer the latest are acknowledged as stale', async () => {
    const { outcome, state } = await runOne({ currentVersion: '5.1.0' });

    assert.equal(outcome.acked, true);
    assert.equal(state.logs[0]?.event, 'release_announcement_stale_job');
    assert.deepEqual(state.sent, []);
    assert.equal(state.claims, 0);
});

test('a state write is retried and a persistent failure acknowledges without resending', async () => {
    const harness = createHarness();
    const { message, outcome } = createMessage();
    let writes = 0;

    harness.dependencies.markSent = async () => {
        writes += 1;
        throw new Error('D1 unavailable');
    };

    await processReleaseAnnouncementBatch([message], harness.dependencies);

    assert.equal(writes, STATE_WRITE_MAX_ATTEMPTS);
    assert.equal(outcome.acked, true);
    assert.equal(outcome.retried, false);
    assert.equal(harness.state.sent.length, 1);
    assert.equal(harness.state.sleeps.length, STATE_WRITE_MAX_ATTEMPTS - 1);
    assert.ok(
        harness.state.logs.some(entry => {
            return entry.event === 'release_announcement_state_write_failed';
        })
    );
});

test('a state write that recovers within the retry budget still succeeds', async () => {
    const harness = createHarness();
    const { message, outcome } = createMessage();
    let writes = 0;

    harness.dependencies.markSent = async () => {
        writes += 1;

        if (writes < 3) {
            throw new Error('D1 unavailable');
        }
    };

    await processReleaseAnnouncementBatch([message], harness.dependencies);

    assert.equal(writes, 3);
    assert.equal(outcome.acked, true);
    assert.ok(
        !harness.state.logs.some(entry => {
            return entry.event === 'release_announcement_state_write_failed';
        })
    );
});

test('an unexpected error before sending retries the message and never throws', async () => {
    const harness = createHarness();
    const { message, outcome } = createMessage();

    harness.dependencies.claimForSending = async () => {
        throw new Error('D1 unavailable');
    };

    await processReleaseAnnouncementBatch([message], harness.dependencies);

    assert.equal(outcome.acked, false);
    assert.equal(outcome.retried, true);
    assert.deepEqual(harness.state.sent, []);
});

test('sends inside a batch are paced at least 50ms apart', async () => {
    const { dependencies, state } = createHarness();

    await processReleaseAnnouncementBatch(
        [createMessage().message, createMessage().message],
        dependencies
    );

    assert.equal(state.sent.length, 2);
    assert.deepEqual(state.sleeps, [50]);
});

test('one failing chat does not stop the rest of the batch', async () => {
    const { dependencies, state } = createHarness();
    const first = createMessage();
    const second = createMessage();
    let calls = 0;

    dependencies.sendMessage = async (chatId, html) => {
        calls += 1;

        if (calls === 1) {
            throw telegramError(403);
        }

        state.sent.push({ chatId, html });
    };

    await processReleaseAnnouncementBatch(
        [first.message, second.message],
        dependencies
    );

    assert.equal(first.outcome.acked, true);
    assert.equal(second.outcome.acked, true);
    assert.equal(state.sent.length, 1);
});
