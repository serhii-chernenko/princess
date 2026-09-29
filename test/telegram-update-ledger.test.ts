import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';

import { createDb } from '../src/db/client';
import { createRepositories } from '../src/db/repositories';
import { telegramUpdateLeaseMilliseconds } from '../src/db/repositories/telegram-update-repository';
import type { WorkerBindings } from '../src/worker/env';

interface RecordedStatement {
    query: string;
    boundValues: unknown[];
}

const createD1Result = <T>(results: T[]): D1Result<T> => {
    return {
        success: true,
        results,
        meta: {
            duration: 0,
            size_after: 0,
            rows_read: 0,
            rows_written: 0,
            last_row_id: 0,
            changed_db: false,
            changes: 0
        }
    };
};

class LedgerPreparedStatement {
    constructor(
        private readonly recordedStatement: RecordedStatement,
        private readonly getRawRows: () => unknown[][]
    ) {}

    bind(...values: unknown[]): D1PreparedStatement {
        this.recordedStatement.boundValues = values;
        return this;
    }

    first<T = unknown>(_columnName: string): Promise<T | null>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    async first<T>(): Promise<T | null> {
        return null;
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return createD1Result([]);
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return createD1Result([]);
    }

    raw<T = unknown[]>(options: {
        columnNames: true;
    }): Promise<[string[], ...T[]]>;
    raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async raw(): Promise<unknown[][]> {
        return this.getRawRows();
    }
}

const createLedgerRepository = (rawResults: unknown[][][]) => {
    const statements: RecordedStatement[] = [];
    let rawResultIndex = 0;
    const database = {
        prepare(query: string) {
            const recordedStatement = {
                query,
                boundValues: []
            } satisfies RecordedStatement;
            statements.push(recordedStatement);

            return new LedgerPreparedStatement(recordedStatement, () => {
                const rows = rawResults[rawResultIndex] ?? [];
                rawResultIndex += 1;
                return rows;
            });
        },
        async batch<T = unknown>(): Promise<D1Result<T>[]> {
            return [];
        },
        async exec() {
            return {
                count: 0,
                duration: 0
            };
        },
        withSession() {
            throw new Error('Sessions are not used by ledger tests');
        },
        async dump() {
            return new ArrayBuffer(0);
        }
    } satisfies D1Database;
    const partialEnv: Pick<WorkerBindings, 'DB'> = {
        DB: database
    };
    const env = partialEnv as WorkerBindings;

    return {
        repository: createRepositories(createDb(env)).telegramUpdates,
        statements
    };
};

test('update claims distinguish insert, duplicate, busy, and stale reclaim', async () => {
    const claimedAt = new Date('2026-07-15T12:00:00.000Z');
    const inserted = createLedgerRepository([[['lease-inserted']]]);
    const duplicate = createLedgerRepository([[], [], [['processed']]]);
    const busy = createLedgerRepository([[], [], [['processing']]]);
    const reclaimed = createLedgerRepository([[], [['lease-reclaimed']]]);

    const insertedClaim = await Effect.runPromise(
        inserted.repository.claimUpdate('bot-a', 1, 'lease-inserted', claimedAt)
    );
    const duplicateClaim = await Effect.runPromise(
        duplicate.repository.claimUpdate('bot-a', 2, 'lease-new', claimedAt)
    );
    const busyClaim = await Effect.runPromise(
        busy.repository.claimUpdate('bot-a', 3, 'lease-new', claimedAt)
    );
    const reclaimedClaim = await Effect.runPromise(
        reclaimed.repository.claimUpdate(
            'bot-a',
            4,
            'lease-reclaimed',
            claimedAt
        )
    );

    assert.deepEqual(insertedClaim, {
        state: 'claimed',
        leaseId: 'lease-inserted',
        reclaimed: false
    });
    assert.deepEqual(duplicateClaim, {
        state: 'duplicate'
    });
    assert.deepEqual(busyClaim, {
        state: 'busy'
    });
    assert.deepEqual(reclaimedClaim, {
        state: 'claimed',
        leaseId: 'lease-reclaimed',
        reclaimed: true
    });
    assert.match(
        inserted.statements[0]?.query ?? '',
        /on conflict \("telegram_updates"\."bot_key", "telegram_updates"\."update_id"\) do nothing/
    );
    assert.match(reclaimed.statements[1]?.query ?? '', /"started_at" < \?/);
    assert.equal(
        reclaimed.statements[1]?.boundValues.includes(
            claimedAt.getTime() - telegramUpdateLeaseMilliseconds
        ),
        true
    );
});

test('terminalization requires the matching processing lease', async () => {
    const completedAt = new Date('2026-07-15T12:01:00.000Z');
    const { repository, statements } = createLedgerRepository([[[42]], []]);

    const terminalized = await Effect.runPromise(
        repository.terminalizeUpdate('bot-a', 42, 'lease-a', completedAt)
    );
    const wrongTerminalizationLease = await Effect.runPromise(
        repository.terminalizeUpdate('bot-a', 42, 'lease-b', completedAt)
    );

    assert.equal(terminalized, true);
    assert.equal(wrongTerminalizationLease, false);

    for (const statement of statements) {
        assert.match(statement.query, /^update "telegram_updates"/);
        assert.match(statement.query, /"status" = \?/);
        assert.match(statement.query, /"lease_id" = \?/);
    }
});

test('ledger retention deletes processed and very old abandoned updates separately', async () => {
    const { repository, statements } = createLedgerRepository([
        [[1], [2], [3]],
        [[4], [5]]
    ]);

    const deletedProcessed = await Effect.runPromise(
        repository.deleteProcessedBefore(new Date('2026-07-08T12:00:00.000Z'))
    );
    const deletedAbandoned = await Effect.runPromise(
        repository.deleteAbandonedProcessingBefore(
            new Date('2026-07-14T12:00:00.000Z')
        )
    );

    assert.equal(deletedProcessed, 3);
    assert.equal(deletedAbandoned, 2);
    assert.equal(statements.length, 2);
    assert.match(statements[0]?.query ?? '', /^delete from "telegram_updates"/);
    assert.match(statements[0]?.query ?? '', /"processed_at" < \?/);
    assert.match(statements[0]?.query ?? '', /"status" = \?/);
    assert.match(statements[1]?.query ?? '', /"started_at" < \?/);
    assert.match(statements[1]?.query ?? '', /"status" = \?/);
});
