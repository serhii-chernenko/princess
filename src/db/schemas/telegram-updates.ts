import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    snakeCase,
    text,
    uniqueIndex
} from 'drizzle-orm/sqlite-core';

export const telegramUpdateStatuses = ['processing', 'processed'] as const;

export const telegramUpdates = snakeCase.table(
    'telegram_updates',
    {
        botKey: text().notNull(),
        updateId: integer().notNull(),
        status: text({ enum: telegramUpdateStatuses }).notNull(),
        leaseId: text().notNull(),
        startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
        processedAt: integer({ mode: 'timestamp_ms' })
    },
    table => {
        return [
            uniqueIndex('telegram_updates_bot_update_unique').on(
                table.botKey,
                table.updateId
            ),
            check(
                'telegram_updates_status_check',
                sql`${table.status} in ('processing', 'processed')`
            ),
            index('telegram_updates_cleanup_index').on(
                table.status,
                table.processedAt
            )
        ];
    }
);
