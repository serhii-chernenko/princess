import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    snakeCase,
    text
} from 'drizzle-orm/sqlite-core';

export const channelSnapshotReasons = ['reset', 'forget', 'restore'] as const;

export const channelSnapshots = snakeCase.table(
    'channel_snapshots',
    {
        id: integer().primaryKey({ autoIncrement: true }),
        telegramChatId: integer().notNull(),
        reason: text({ enum: channelSnapshotReasons }).notNull(),
        payload: text().notNull(),
        createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
        expiresAt: integer({ mode: 'timestamp_ms' }).notNull()
    },
    table => {
        return [
            check(
                'channel_snapshots_reason_check',
                sql`${table.reason} in ('reset', 'forget', 'restore')`
            ),
            index('channel_snapshots_chat_created_at_index').on(
                table.telegramChatId,
                table.createdAt
            ),
            index('channel_snapshots_expires_at_index').on(table.expiresAt)
        ];
    }
);
