import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    snakeCase,
    uniqueIndex
} from 'drizzle-orm/sqlite-core';

import { channels } from './channels';
import { players } from './players';

export const channelMembers = snakeCase.table(
    'channel_members',
    {
        id: integer().primaryKey({ autoIncrement: true }),
        channelId: integer()
            .notNull()
            .references(
                () => {
                    return channels.id;
                },
                { onDelete: 'cascade' }
            ),
        playerId: integer()
            .notNull()
            .references(
                () => {
                    return players.id;
                },
                { onDelete: 'cascade' }
            ),
        score: integer().notNull().default(0),
        isActive: integer({ mode: 'boolean' }).notNull().default(true),
        isAutoJoined: integer({ mode: 'boolean' }).notNull().default(true),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .$defaultFn(() => {
                return new Date();
            }),
        updatedAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .$defaultFn(() => {
                return new Date();
            })
    },
    table => {
        return [
            uniqueIndex('channel_members_channel_player_unique').on(
                table.channelId,
                table.playerId
            ),
            check(
                'channel_members_score_non_negative',
                sql`${table.score} >= 0`
            ),
            index('channel_members_channel_id_index').on(table.channelId),
            index('channel_members_player_id_index').on(table.playerId),
            index('channel_members_active_index').on(
                table.channelId,
                table.isActive
            ),
            index('channel_members_score_index').on(
                table.channelId,
                table.score
            )
        ];
    }
);
