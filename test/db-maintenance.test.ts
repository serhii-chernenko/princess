import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';

import { createGameService } from '../src/bot/services/game-service';
import { createDb } from '../src/db/client';
import { createRepositories } from '../src/db/repositories';
import type { WorkerBindings } from '../src/worker/env';
import {
    chunkPlayerIdsForD1,
    d1BoundParameterSafetyLimit
} from '../src/db/repositories/player-repository';
import { formatImportSql } from '../scripts/db/prepare-mongo-import';

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

class RecordingPreparedStatement {
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
    async raw(options?: { columnNames?: boolean }): Promise<unknown> {
        const rows = this.getRawRows();

        if (options?.columnNames) {
            return [[], ...rows];
        }

        return rows;
    }
}

const createRecordingDatabase = (
    getRawRows: (query: string) => unknown[][]
) => {
    const statements: RecordedStatement[] = [];
    const database = {
        prepare(query: string) {
            const recordedStatement: RecordedStatement = {
                query,
                boundValues: []
            };
            statements.push(recordedStatement);

            return new RecordingPreparedStatement(recordedStatement, () => {
                return getRawRows(query);
            });
        },
        async batch() {
            return [];
        },
        async exec() {
            return {
                count: 0,
                duration: 0
            };
        },
        withSession() {
            throw new Error('Sessions are not used by this test');
        },
        async dump() {
            return new ArrayBuffer(0);
        }
    } satisfies D1Database;

    return {
        database,
        statements
    };
};

const createTestWorkerBindings = (
    database: D1Database,
    botEnvironment: 'local' | 'stable' | 'beta' = 'local',
    enableScheduledCleanup: 'true' | 'false' = 'true'
) => {
    return {
        DB: database,
        BOT_ENVIRONMENT: botEnvironment,
        ENABLE_SCHEDULED_CLEANUP: enableScheduledCleanup
    } as WorkerBindings;
};

test('D1 player ID chunks stay below the bound-parameter ceiling', () => {
    const candidatePlayerIds = Array.from(
        { length: d1BoundParameterSafetyLimit + 1 },
        (_value, index) => index + 1
    );
    candidatePlayerIds.push(1);

    const chunks = chunkPlayerIdsForD1(candidatePlayerIds);

    assert.deepEqual(
        chunks.map(playerIdChunk => playerIdChunk.length),
        [d1BoundParameterSafetyLimit, 1]
    );
    assert.equal(new Set(chunks.flat()).size, candidatePlayerIds.length - 1);
    assert.equal(d1BoundParameterSafetyLimit < 100, true);
});

test('daily run claims use timestamp CAS and return the claimed channel', async () => {
    const claimedAt = new Date('2026-07-15T10:00:00.000Z');
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const { database, statements } = createRecordingDatabase(query => {
        if (query.startsWith('update "channels"')) {
            return [
                [
                    7,
                    -100,
                    'ua',
                    '4.0.1',
                    claimedAt.getTime(),
                    createdAt.getTime()
                ]
            ];
        }

        return [];
    });
    const repositories = createRepositories(
        createDb(createTestWorkerBindings(database))
    );

    const claimedChannel = await Effect.runPromise(
        repositories.channels.claimChannelRun(7, null, claimedAt)
    );

    assert.equal(claimedChannel?.id, 7);
    assert.equal(claimedChannel?.lastVoteAt?.getTime(), claimedAt.getTime());
    assert.match(statements[0]?.query ?? '', /"last_vote_at" is null/);
    assert.match(statements[0]?.query ?? '', / returning /);
});

test('winner score updates are atomic SQL increments with a returned row', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-07-15T10:00:00.000Z');
    const { database, statements } = createRecordingDatabase(query => {
        if (query.startsWith('update "channel_members"')) {
            return [
                [11, 7, 9, 4, 1, 1, createdAt.getTime(), updatedAt.getTime()]
            ];
        }

        return [];
    });
    const repositories = createRepositories(
        createDb(createTestWorkerBindings(database))
    );

    const incrementedMember = await Effect.runPromise(
        repositories.channelMembers.incrementMemberScore(11)
    );

    assert.equal(incrementedMember?.score, 4);
    assert.match(
        statements[0]?.query ?? '',
        /"score" = "channel_members"\."score" \+ 1/
    );
    assert.match(statements[0]?.query ?? '', / returning /);
});

test('inactive-channel cleanup uses set-based channel work and chunked orphan deletes', async () => {
    const candidatePlayerIds = Array.from(
        { length: d1BoundParameterSafetyLimit + 1 },
        (_value, index) => index + 1
    );
    const deletedChannelIds = Array.from(
        { length: 225 },
        (_value, index) => index + 1
    );
    const { database, statements } = createRecordingDatabase(query => {
        if (query.startsWith('select distinct')) {
            return candidatePlayerIds.map(playerId => [playerId]);
        }

        if (query.startsWith('delete from "channels"')) {
            return deletedChannelIds.map(channelId => [channelId]);
        }

        return [];
    });
    const game = createGameService(createTestWorkerBindings(database));

    const deletedChannelCount = await game.cleanupInactiveChannels(
        new Date('2026-01-01T00:00:00.000Z')
    );

    assert.equal(deletedChannelCount, 225);
    assert.equal(statements.length, 4);
    assert.match(statements[0]?.query ?? '', /^select distinct /);
    assert.match(statements[0]?.query ?? '', /inner join "channels"/);
    assert.match(statements[1]?.query ?? '', /^delete from "channels"/);
    assert.deepEqual(
        statements.slice(2).map(statement => statement.boundValues.length),
        [d1BoundParameterSafetyLimit, 1]
    );

    for (const statement of statements.slice(2)) {
        assert.match(statement.query, /^delete from "players"/);
        assert.match(statement.query, /not exists/);
    }
});

test('global cleanup rejects disabled and beta execution before querying D1', async () => {
    const disabled = createRecordingDatabase(() => []);
    const beta = createRecordingDatabase(() => []);
    const disabledGame = createGameService(
        createTestWorkerBindings(disabled.database, 'stable', 'false')
    );
    const betaGame = createGameService(
        createTestWorkerBindings(beta.database, 'beta', 'true')
    );
    const cutoff = new Date('2026-01-01T00:00:00.000Z');

    await assert.rejects(
        disabledGame.cleanupInactiveChannels(cutoff),
        /disabled by configuration/
    );
    await assert.rejects(
        betaGame.cleanupInactiveChannels(cutoff),
        /forbidden outside the local or stable owner environment/
    );
    assert.equal(disabled.statements.length, 0);
    assert.equal(beta.statements.length, 0);
});

test('Mongo import SQL is insert-only and leaves transaction control to Wrangler', () => {
    const sql = formatImportSql(
        [
            {
                telegramUserId: 1,
                displayName: 'Test Player',
                createdAt: 1,
                updatedAt: 1
            }
        ],
        [
            {
                telegramChatId: -1,
                language: 'ua',
                releaseVersion: '4.0.1',
                lastVoteAt: null,
                createdAt: 1
            }
        ],
        [
            {
                telegramChatId: -1,
                telegramUserId: 1,
                score: 0,
                isActive: true,
                isAutoJoined: true,
                createdAt: 1,
                updatedAt: 1
            }
        ]
    );

    assert.doesNotMatch(sql, /^\s*BEGIN(?: TRANSACTION)?;/im);
    assert.doesNotMatch(sql, /^\s*COMMIT;/im);
    assert.doesNotMatch(sql, /ON CONFLICT/i);
    assert.match(sql, /wrangler d1 execute --file/);
    assert.match(sql, /rerunning against populated tables must not overwrite/);
});
