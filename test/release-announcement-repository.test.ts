import assert from 'node:assert/strict';
import test from 'node:test';

import { drizzle } from 'drizzle-orm/d1';

import { releaseAnnouncements } from '../src/db/schema';
import {
    D1_BOUND_PARAMETER_CEILING,
    RELEASE_ANNOUNCEMENT_INSERT_CHUNK_SIZE,
    RELEASE_ANNOUNCEMENT_INSERT_COLUMN_COUNT
} from '../src/db/repositories/release-announcement-repository';

test('a full announcement insert chunk stays within the D1 parameter ceiling', () => {
    const db = drizzle({} as D1Database);
    const now = new Date(0);
    const statement = db
        .insert(releaseAnnouncements)
        .values(
            Array.from(
                { length: RELEASE_ANNOUNCEMENT_INSERT_CHUNK_SIZE },
                (_value, channelId) => {
                    return {
                        releaseVersion: '5.0.0',
                        channelId,
                        status: 'queued' as const,
                        attempts: 0,
                        createdAt: now,
                        updatedAt: now
                    };
                }
            )
        )
        .onConflictDoNothing({
            target: [
                releaseAnnouncements.releaseVersion,
                releaseAnnouncements.channelId
            ]
        })
        .returning({ channelId: releaseAnnouncements.channelId })
        .toSQL();

    assert.equal(
        RELEASE_ANNOUNCEMENT_INSERT_CHUNK_SIZE,
        Math.floor(
            D1_BOUND_PARAMETER_CEILING /
                RELEASE_ANNOUNCEMENT_INSERT_COLUMN_COUNT
        )
    );
    assert.ok(statement.params.length <= D1_BOUND_PARAMETER_CEILING);
    assert.equal(
        statement.params.length,
        RELEASE_ANNOUNCEMENT_INSERT_CHUNK_SIZE *
            RELEASE_ANNOUNCEMENT_INSERT_COLUMN_COUNT
    );
    assert.match(statement.sql, /on conflict .* do nothing/i);
});
