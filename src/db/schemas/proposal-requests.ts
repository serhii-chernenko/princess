import {
    index,
    integer,
    snakeCase,
    uniqueIndex
} from 'drizzle-orm/sqlite-core';

export const proposalRequests = snakeCase.table(
    'proposal_requests',
    {
        id: integer().primaryKey({ autoIncrement: true }),
        chatId: integer().notNull(),
        userId: integer().notNull(),
        promptMessageId: integer().notNull(),
        createdAt: integer({ mode: 'timestamp_ms' }).notNull()
    },
    table => {
        return [
            uniqueIndex('proposal_requests_chat_user_unique').on(
                table.chatId,
                table.userId
            ),
            index('proposal_requests_created_at_index').on(table.createdAt)
        ];
    }
);
