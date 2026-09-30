import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    snakeCase,
    text
} from 'drizzle-orm/sqlite-core';

import { channels } from './channels';
import { players } from './players';

export const voteWinModes = ['auto', 'manual', 'sudo'] as const;

export const voteWins = snakeCase.table(
    'vote_wins',
    {
        id: integer().primaryKey({ autoIncrement: true }),
        channelId: integer()
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        playerId: integer()
            .notNull()
            .references(() => players.id, { onDelete: 'cascade' }),
        wonAt: integer({ mode: 'timestamp_ms' }).notNull(),
        mode: text({ enum: voteWinModes }).notNull(),
        eligibleCount: integer().notNull()
    },
    table => {
        return [
            check(
                'vote_wins_mode_check',
                sql`${table.mode} in ('auto', 'manual', 'sudo')`
            ),
            check(
                'vote_wins_eligible_count_check',
                sql`${table.eligibleCount} >= 2`
            ),
            index('vote_wins_channel_won_at_index').on(
                table.channelId,
                table.wonAt
            )
        ];
    }
);
