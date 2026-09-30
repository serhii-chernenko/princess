import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Effect } from 'effect';

import {
    buildMigrationHashesSql,
    migrationsTableName
} from '../../scripts/db/copy-production-to-preview';
import { countRows, createD1Harness, type D1Harness } from './d1-harness';

interface SchemaObject {
    type: string;
    name: string;
    sql: string | null;
}

describe('D1 migrations', () => {
    let harness: D1Harness;

    before(async () => {
        harness = await createD1Harness();
    });

    after(async () => {
        await harness.dispose();
    });

    it('applies from an empty database and creates the expected schema', async () => {
        await harness.applyMigrations();

        const { results } = await harness.env.DB.prepare(
            'SELECT type, name, sql FROM sqlite_master'
        ).all<SchemaObject>();
        const findObject = (name: string) => {
            return results.find(object => object.name === name);
        };

        for (const tableName of [
            'channels',
            'players',
            'channel_members',
            'telegram_updates',
            'release_announcements',
            'vote_wins'
        ]) {
            assert.equal(findObject(tableName)?.type, 'table', tableName);
        }

        for (const indexName of [
            'channels_telegram_chat_id_unique',
            'players_telegram_user_id_unique',
            'channel_members_channel_player_unique',
            'telegram_updates_bot_update_unique',
            'release_announcements_version_channel_unique'
        ]) {
            assert.match(findObject(indexName)?.sql ?? '', /UNIQUE INDEX/);
        }

        assert.match(
            findObject('channel_members')?.sql ?? '',
            /channel_members_score_non_negative[^)]*CHECK\("score" >= 0\)/
        );
        assert.match(
            findObject('telegram_updates')?.sql ?? '',
            /telegram_updates_status_check[^)]*CHECK\("status" in \('processing', 'processed'\)\)/
        );
        assert.match(
            findObject('release_announcements')?.sql ?? '',
            /release_announcements_status_check[^)]*CHECK\("status" in \('queued', 'sending', 'sent', 'skipped', 'failed'\)\)/
        );
        assert.match(
            findObject('vote_wins')?.sql ?? '',
            /vote_wins_mode_check[^)]*CHECK\("mode" in \('auto', 'manual', 'sudo'\)\)/
        );
        assert.match(
            findObject('vote_wins')?.sql ?? '',
            /vote_wins_eligible_count_check[^)]*CHECK\("eligible_count" >= 2\)/
        );
        assert.equal(
            findObject('vote_wins_channel_won_at_index')?.type,
            'index'
        );
        assert.match(findObject('channels')?.sql ?? '', /`language` text/);
        assert.match(
            findObject('channels')?.sql ?? '',
            /`bot_admin_status` text/
        );
        assert.match(
            findObject('channels')?.sql ?? '',
            /`bot_admin_checked_at` integer/
        );
    });

    it('is a no-op when applied a second time', async () => {
        await harness.applyMigrations();
        const appliedBefore = await countRows(harness, '__drizzle_migrations');

        await harness.applyMigrations();

        assert.equal(appliedBefore, 6);
        assert.equal(
            await countRows(harness, '__drizzle_migrations'),
            appliedBefore
        );
    });

    it('records applied migrations where the production copy script reads them', async () => {
        await harness.applyMigrations();

        const table = await harness.env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
            .bind(migrationsTableName)
            .first<{ name: string }>();
        const { results: columns } = await harness.env.DB.prepare(
            `PRAGMA table_info("${migrationsTableName}")`
        ).all<{ name: string }>();
        const { results: hashes } = await harness.env.DB.prepare(
            buildMigrationHashesSql()
        ).all<{ hash: string }>();

        assert.equal(table?.name, migrationsTableName);
        assert.ok(columns.some(column => column.name === 'hash'));
        assert.ok(columns.some(column => column.name === 'id'));
        assert.equal(hashes.length, 6);
        assert.ok(hashes.every(row => row.hash.length > 0));
    });

    describe('constraints', () => {
        beforeEach(async () => {
            await harness.clearApplicationTables();
        });

        it('rejects duplicate channels, players and ledger keys', async () => {
            const { DB } = harness.env;

            await DB.batch([
                DB.prepare(
                    "INSERT INTO channels (telegram_chat_id, release_version, created_at) VALUES (1, '1', 0)"
                ),
                DB.prepare(
                    "INSERT INTO players (telegram_user_id, display_name, created_at, updated_at) VALUES (1, 'a', 0, 0)"
                ),
                DB.prepare(
                    "INSERT INTO telegram_updates (bot_key, update_id, status, lease_id, started_at) VALUES ('b', 1, 'processing', 'l', 0)"
                )
            ]);

            await assert.rejects(
                DB.prepare(
                    "INSERT INTO channels (telegram_chat_id, release_version, created_at) VALUES (1, '2', 0)"
                ).run(),
                /UNIQUE/
            );
            await assert.rejects(
                DB.prepare(
                    "INSERT INTO players (telegram_user_id, display_name, created_at, updated_at) VALUES (1, 'b', 0, 0)"
                ).run(),
                /UNIQUE/
            );
            await assert.rejects(
                DB.prepare(
                    "INSERT INTO telegram_updates (bot_key, update_id, status, lease_id, started_at) VALUES ('b', 1, 'processing', 'other', 0)"
                ).run(),
                /UNIQUE/
            );
        });

        it('rejects invalid ledger statuses and negative scores', async () => {
            const { DB } = harness.env;

            await assert.rejects(
                DB.prepare(
                    "INSERT INTO telegram_updates (bot_key, update_id, status, lease_id, started_at) VALUES ('b', 2, 'bogus', 'l', 0)"
                ).run(),
                /CHECK/
            );

            await DB.batch([
                DB.prepare(
                    "INSERT INTO channels (telegram_chat_id, release_version, created_at) VALUES (1, '1', 0)"
                ),
                DB.prepare(
                    "INSERT INTO players (telegram_user_id, display_name, created_at, updated_at) VALUES (1, 'a', 0, 0)"
                )
            ]);

            await assert.rejects(
                DB.prepare(
                    'INSERT INTO channel_members (channel_id, player_id, score, created_at, updated_at) SELECT c.id, p.id, -1, 0, 0 FROM channels c, players p'
                ).run(),
                /CHECK/
            );
        });

        it('cascades channel and player deletion to memberships and rejects dangling references', async () => {
            const { DB } = harness.env;

            await DB.batch([
                DB.prepare(
                    "INSERT INTO channels (telegram_chat_id, release_version, created_at) VALUES (1, '1', 0)"
                ),
                DB.prepare(
                    "INSERT INTO players (telegram_user_id, display_name, created_at, updated_at) VALUES (1, 'a', 0, 0), (2, 'b', 0, 0)"
                ),
                DB.prepare(
                    'INSERT INTO channel_members (channel_id, player_id, created_at, updated_at) SELECT c.id, p.id, 0, 0 FROM channels c, players p'
                )
            ]);

            await assert.rejects(
                DB.prepare(
                    'INSERT INTO channel_members (channel_id, player_id, created_at, updated_at) VALUES (999, 999, 0, 0)'
                ).run(),
                /FOREIGN KEY/
            );

            await DB.prepare(
                'DELETE FROM players WHERE telegram_user_id = 1'
            ).run();
            assert.equal(await countRows(harness, 'channel_members'), 1);

            await DB.prepare('DELETE FROM channels').run();
            assert.equal(await countRows(harness, 'channel_members'), 0);
            assert.equal(await countRows(harness, 'players'), 1);
        });

        it('records vote wins, enforces their checks and cascades deletion', async () => {
            const { DB } = harness.env;

            await DB.batch([
                DB.prepare(
                    "INSERT INTO channels (telegram_chat_id, release_version, created_at) VALUES (1, '1', 0)"
                ),
                DB.prepare(
                    "INSERT INTO players (telegram_user_id, display_name, created_at, updated_at) VALUES (1, 'a', 0, 0), (2, 'b', 0, 0)"
                )
            ]);

            const { results: channelRows } = await DB.prepare(
                'SELECT id FROM channels'
            ).all<{ id: number }>();
            const { results: playerRows } = await DB.prepare(
                'SELECT id FROM players ORDER BY telegram_user_id'
            ).all<{ id: number }>();
            const channelId = channelRows[0]!.id;
            const [firstPlayerId, secondPlayerId] = playerRows.map(row => {
                return row.id;
            }) as [number, number];

            const recorded = await Effect.runPromise(
                harness.repositories.voteWins.recordWin({
                    channelId,
                    playerId: secondPlayerId,
                    wonAt: new Date(1_800_000_000_000),
                    mode: 'sudo',
                    eligibleCount: 2
                })
            );

            assert.equal(recorded?.mode, 'sudo');
            assert.equal(recorded?.eligibleCount, 2);
            assert.equal(recorded?.wonAt.getTime(), 1_800_000_000_000);
            assert.equal(await countRows(harness, 'vote_wins'), 1);

            const insertWin = (
                playerId: number,
                mode: string,
                eligibleCount: number
            ) => {
                return DB.prepare(
                    'INSERT INTO vote_wins (channel_id, player_id, won_at, mode, eligible_count) VALUES (?, ?, 0, ?, ?)'
                )
                    .bind(channelId, playerId, mode, eligibleCount)
                    .run();
            };

            await assert.rejects(insertWin(firstPlayerId, 'bogus', 2), /CHECK/);
            await assert.rejects(insertWin(firstPlayerId, 'auto', 1), /CHECK/);
            await assert.rejects(insertWin(999, 'auto', 2), /FOREIGN KEY/);

            await DB.prepare(
                'DELETE FROM players WHERE telegram_user_id = 2'
            ).run();
            assert.equal(await countRows(harness, 'vote_wins'), 0);

            await insertWin(firstPlayerId, 'auto', 3);
            await DB.prepare('DELETE FROM channels').run();
            assert.equal(await countRows(harness, 'vote_wins'), 0);
        });
    });
});
