import { integer, snakeCase, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const channels = snakeCase.table(
    'channels',
    {
        id: integer().primaryKey({ autoIncrement: true }),
        telegramChatId: integer().notNull(),
        language: text().notNull().default('ua'),
        releaseVersion: text().notNull(),
        lastVoteAt: integer({ mode: 'timestamp_ms' }),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .$defaultFn(() => new Date())
    },
    table => {
        return [
            uniqueIndex('channels_telegram_chat_id_unique').on(
                table.telegramChatId
            )
        ];
    }
);
