import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Effect } from 'effect';

import {
    telegramAbandonedUpdateRetentionMilliseconds,
    telegramUpdateLeaseMilliseconds,
    telegramUpdateRetentionMilliseconds
} from '../../src/db/repositories/telegram-update-repository';
import { countRows, createD1Harness, type D1Harness } from './d1-harness';

const racerCount = 15;
const botKey = 'bot-key';
const updateId = 1001;

describe('Telegram update ledger on D1', () => {
    let harness: D1Harness;

    const claim = (id: string, startedAt: Date, key = updateId) => {
        return Effect.runPromise(
            harness.repositories.telegramUpdates.claimUpdate(
                botKey,
                key,
                id,
                startedAt
            )
        );
    };
    const terminalize = (id: string, processedAt: Date) => {
        return Effect.runPromise(
            harness.repositories.telegramUpdates.terminalizeUpdate(
                botKey,
                updateId,
                id,
                processedAt
            )
        );
    };
    const readRow = (key = updateId) => {
        return harness.env.DB.prepare(
            'SELECT status, lease_id AS leaseId, started_at AS startedAt FROM telegram_updates WHERE bot_key = ? AND update_id = ?'
        )
            .bind(botKey, key)
            .first<{ status: string; leaseId: string; startedAt: number }>();
    };
    const insertRow = (
        key: number,
        status: 'processing' | 'processed',
        startedAt: number,
        processedAt: number | null
    ) => {
        return harness.env.DB.prepare(
            'INSERT INTO telegram_updates (bot_key, update_id, status, lease_id, started_at, processed_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
            .bind(botKey, key, status, `lease-${key}`, startedAt, processedAt)
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

    it('lets exactly one of many concurrent racers claim an update', async () => {
        const now = new Date();
        const claims = await Promise.all(
            Array.from({ length: racerCount }, (_, index) => {
                return claim(`lease-${index}`, now);
            })
        );
        const winners = claims.filter(result => result.state === 'claimed');

        assert.equal(winners.length, 1);
        const winner = winners[0];

        assert.equal(winner?.state === 'claimed' && winner.reclaimed, false);
        assert.equal(
            (await readRow())?.leaseId,
            winner?.state === 'claimed' ? winner.leaseId : null
        );
        assert.equal(
            claims.filter(result => result.state === 'busy').length,
            racerCount - 1
        );
        assert.equal(await countRows(harness, 'telegram_updates'), 1);
    });

    it('acknowledges duplicates after terminalization and never reprocesses', async () => {
        const now = new Date();

        await claim('lease-a', now);
        assert.equal(await terminalize('lease-a', now), true);

        const results = await Promise.all(
            Array.from({ length: racerCount }, (_, index) => {
                return claim(`late-${index}`, new Date(now.getTime() + 1));
            })
        );

        assert.ok(results.every(result => result.state === 'duplicate'));
        assert.equal((await readRow())?.status, 'processed');
    });

    it('reports busy for a fresh in-flight claim, including at the exact lease boundary', async () => {
        const startedAt = new Date(1_000_000);

        await claim('lease-a', startedAt);

        assert.deepEqual(
            await claim('lease-b', new Date(startedAt.getTime() + 1000)),
            { state: 'busy' }
        );
        assert.deepEqual(
            await claim(
                'lease-c',
                new Date(startedAt.getTime() + telegramUpdateLeaseMilliseconds)
            ),
            { state: 'busy' }
        );
        assert.equal((await readRow())?.leaseId, 'lease-a');
    });

    it('lets exactly one concurrent racer reclaim a stale lease', async () => {
        const staleStart = new Date(Date.now() - 6 * 60 * 1000);
        const now = new Date();

        await claim('stale-lease', staleStart);

        const claims = await Promise.all(
            Array.from({ length: racerCount }, (_, index) => {
                return claim(`reclaimer-${index}`, now);
            })
        );
        const winners = claims.filter(result => result.state === 'claimed');

        assert.equal(winners.length, 1);
        assert.equal(
            winners[0]?.state === 'claimed' && winners[0].reclaimed,
            true
        );
        assert.equal(
            claims.filter(result => result.state === 'busy').length,
            racerCount - 1
        );
        assert.equal(
            (await readRow())?.leaseId,
            winners[0]?.state === 'claimed' ? winners[0].leaseId : null
        );
        assert.equal((await readRow())?.startedAt, now.getTime());
    });

    it('does not let a lost lease overwrite the reclaimer terminal state', async () => {
        const now = new Date();

        await claim('old-lease', new Date(now.getTime() - 6 * 60 * 1000));
        const reclaim = await claim('new-lease', now);

        assert.deepEqual(reclaim, {
            state: 'claimed',
            leaseId: 'new-lease',
            reclaimed: true
        });
        assert.equal(await terminalize('old-lease', now), false);
        assert.deepEqual(
            {
                status: (await readRow())?.status,
                lease: (await readRow())?.leaseId
            },
            { status: 'processing', lease: 'new-lease' }
        );
        assert.equal(await terminalize('new-lease', now), true);
        assert.equal(await terminalize('new-lease', now), false);
        assert.equal((await readRow())?.status, 'processed');
    });

    it('prunes only processed rows older than seven days and abandoned processing rows older than a day', async () => {
        const now = Date.now();
        const hour = 60 * 60 * 1000;
        const day = 24 * hour;

        await insertRow(1, 'processed', now - 9 * day, now - 8 * day);
        await insertRow(2, 'processed', now - 7 * day, now - 6 * day);
        await insertRow(3, 'processing', now - 25 * hour, null);
        await insertRow(4, 'processing', now - hour, null);
        await insertRow(5, 'processed', now - 30 * day, now - 29 * day);

        const repository = harness.repositories.telegramUpdates;
        const prunedProcessed = await Effect.runPromise(
            repository.deleteProcessedBefore(
                new Date(now - telegramUpdateRetentionMilliseconds)
            )
        );
        const remainingAfterProcessed = await countRows(
            harness,
            'telegram_updates'
        );
        const prunedAbandoned = await Effect.runPromise(
            repository.deleteAbandonedProcessingBefore(
                new Date(now - telegramAbandonedUpdateRetentionMilliseconds)
            )
        );

        assert.equal(prunedProcessed, 2);
        assert.equal(remainingAfterProcessed, 3);
        assert.equal(prunedAbandoned, 1);
        assert.equal(await readRow(1), null);
        assert.equal(await readRow(3), null);
        assert.equal(await readRow(5), null);
        assert.equal((await readRow(2))?.status, 'processed');
        assert.equal((await readRow(4))?.status, 'processing');
    });
});
