import { integer, snakeCase, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const players = snakeCase.table(
    'players',
    {
        id: integer().primaryKey({ autoIncrement: true }),
        telegramUserId: integer().notNull(),
        displayName: text().notNull(),
        language: text(),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .$defaultFn(() => new Date())
    },
    table => {
        return [
            uniqueIndex('players_telegram_user_id_unique').on(
                table.telegramUserId
            )
        ];
    }
);
