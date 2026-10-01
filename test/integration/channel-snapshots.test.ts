import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { Effect } from 'effect';

import { getLatestReleaseVersion } from '../../src/bot/content/releases';
import { getMessages } from '../../src/bot/content/messages';
import { BotUserError } from '../../src/bot/errors';
import { createGameService } from '../../src/bot/services/game-service';
import {
    channelSnapshotMaxPerChat,
    channelSnapshotRetentionMilliseconds
} from '../../src/db/channel-snapshot-payload';
import { createDb } from '../../src/db/client';
import { createRepositories } from '../../src/db/repositories';
import {
    countRows,
    createD1Harness,
    seedGeneratedPlayers,
    type D1Harness
} from './d1-harness';

const baseTime = 1_800_000_000_000;
const chatId = -100;
const otherChatId = -200;

interface MemberScore {
    telegramUserId: number;
    score: number;
}

const createAdminReader = () => {
    return {
        async getChatMember(_chatId: number, userId: number) {
            return {
                status: 'creator',
                user: { id: userId, is_bot: false, first_name: 'Ann' }
            } as never;
        }
    };
};

describe('Channel snapshots on D1', () => {
    let harness: D1Harness;

    const createGame = () => {
        return createGameService(harness.env);
    };
    const seedChannel = async (
        telegramChatId: number,
        options: {
            language?: string;
            lastVoteAt?: number | null;
            stoppedAt?: number | null;
            firstMemberId?: number;
            lastMemberId: number;
        }
    ) => {
        await harness.env.DB.prepare(
            `INSERT INTO channels (telegram_chat_id, language, release_version, last_vote_at, stopped_at, created_at)
            VALUES (?, ?, '1.0.0', ?, ?, ?)`
        )
            .bind(
                telegramChatId,
                options.language ?? 'en',
                options.lastVoteAt ?? null,
                options.stoppedAt ?? null,
                baseTime - 5000
            )
            .run();
        await harness.env.DB.prepare(
            `INSERT INTO channel_members (channel_id, player_id, score, is_active, is_auto_joined, created_at, updated_at)
            SELECT c.id, p.id, p.telegram_user_id % 7 + 1, 1, 1, ?, ?
            FROM channels c, players p
            WHERE c.telegram_chat_id = ? AND p.telegram_user_id BETWEEN ? AND ?`
        )
            .bind(
                baseTime - 4000,
                baseTime - 3000,
                telegramChatId,
                options.firstMemberId ?? 1,
                options.lastMemberId
            )
            .run();
    };
    const seedWins = (telegramChatId: number, winCount: number) => {
        return harness.env.DB.prepare(
            `INSERT INTO vote_wins (channel_id, player_id, won_at, mode, eligible_count)
            WITH RECURSIVE sequence(n) AS (
                SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
            ),
            ranked AS (
                SELECT
                    m.channel_id AS channelId,
                    m.player_id AS playerId,
                    row_number() OVER (ORDER BY m.id) - 1 AS position,
                    count(*) OVER () AS total
                FROM channel_members m
                JOIN channels c ON c.id = m.channel_id
                WHERE c.telegram_chat_id = ?
            )
            SELECT
                r.channelId,
                r.playerId,
                s.n * 1000,
                CASE s.n % 3 WHEN 0 THEN 'auto' WHEN 1 THEN 'manual' ELSE 'sudo' END,
                5
            FROM sequence s
            JOIN ranked r ON r.position = (s.n - 1) % r.total`
        )
            .bind(winCount, telegramChatId)
            .run();
    };
    const readScores = async (telegramChatId: number) => {
        const { results } = await harness.env.DB.prepare(
            `SELECT p.telegram_user_id AS telegramUserId, m.score AS score
            FROM channel_members m
            JOIN players p ON p.id = m.player_id
            JOIN channels c ON c.id = m.channel_id
            WHERE c.telegram_chat_id = ?
            ORDER BY p.telegram_user_id`
        )
            .bind(telegramChatId)
            .all<MemberScore>();

        return results;
    };
    const readChannel = (telegramChatId: number) => {
        return harness.env.DB.prepare(
            `SELECT language, last_vote_at AS lastVoteAt, stopped_at AS stoppedAt, release_version AS releaseVersion
            FROM channels WHERE telegram_chat_id = ?`
        )
            .bind(telegramChatId)
            .first<{
                language: string;
                lastVoteAt: number | null;
                stoppedAt: number | null;
                releaseVersion: string;
            }>();
    };
    const readSnapshotReasons = async () => {
        const { results } = await harness.env.DB.prepare(
            'SELECT reason FROM channel_snapshots ORDER BY id'
        ).all<{ reason: string }>();

        return results.map(row => {
            return row.reason;
        });
    };
    const readSnapshotCreatedAt = async (telegramChatId: number) => {
        const { results } = await harness.env.DB.prepare(
            'SELECT created_at AS createdAt FROM channel_snapshots WHERE telegram_chat_id = ? ORDER BY created_at'
        )
            .bind(telegramChatId)
            .all<{ createdAt: number }>();

        return results.map(row => {
            return row.createdAt;
        });
    };
    const seedOtherChatSnapshots = (count: number) => {
        return harness.env.DB.batch(
            Array.from({ length: count }, (_value, index) => {
                return harness.env.DB.prepare(
                    "INSERT INTO channel_snapshots (telegram_chat_id, reason, payload, created_at, expires_at) VALUES (?, 'reset', '{}', ?, ?)"
                ).bind(otherChatId, index + 1, baseTime * 2);
            })
        );
    };
    const at = (offsetSeconds: number) => {
        return new Date(baseTime + offsetSeconds * 1000);
    };

    before(async () => {
        harness = await createD1Harness();
        await harness.applyMigrations();
    });

    after(async () => {
        await harness.dispose();
    });

    beforeEach(async () => {
        await harness.clearApplicationTables();
        await seedGeneratedPlayers(harness, 10);
    });

    it('reset snapshots the channel, zeroes scores, clears the run and keeps members and vote history', async () => {
        await seedChannel(chatId, { lastMemberId: 5, lastVoteAt: baseTime });
        await seedWins(chatId, 3);

        await createGame().resetScores(chatId, 'en', at(0));

        const scores = await readScores(chatId);

        assert.deepEqual(await readSnapshotReasons(), ['reset']);
        assert.equal(scores.length, 5);
        assert.ok(
            scores.every(({ score }) => {
                return score === 0;
            })
        );
        assert.equal((await readChannel(chatId))?.lastVoteAt, null);
        assert.equal(await countRows(harness, 'channel_members'), 5);
        assert.equal(await countRows(harness, 'vote_wins'), 3);
    });

    it('forget snapshots before deleting the channel and removes only orphaned players', async () => {
        await seedChannel(chatId, { lastMemberId: 5 });
        await seedChannel(otherChatId, { firstMemberId: 4, lastMemberId: 5 });

        await createGame().forgetChannel(chatId, 'en', at(0));

        assert.deepEqual(await readSnapshotReasons(), ['forget']);
        assert.equal(await readChannel(chatId), null);
        assert.notEqual(await readChannel(otherChatId), null);
        assert.equal(await countRows(harness, 'channel_members'), 2);
        assert.equal(await countRows(harness, 'players'), 7);
    });

    it('restore after forget rebuilds channel, scores and wins keyed by telegram user id without duplicating players', async () => {
        await seedChannel(chatId, {
            language: 'en',
            lastMemberId: 5,
            lastVoteAt: baseTime,
            stoppedAt: baseTime - 1000
        });
        await seedWins(chatId, 6);
        await harness.env.DB.prepare(
            'DELETE FROM players WHERE telegram_user_id > 5'
        ).run();

        const scoresBefore = await readScores(chatId);
        const game = createGame();

        await game.forgetChannel(chatId, 'en', at(0));

        assert.equal(await countRows(harness, 'players'), 0);

        await harness.env.DB.batch([
            harness.env.DB.prepare(
                "INSERT INTO players (telegram_user_id, display_name, created_at, updated_at) VALUES (3, 'Fresh Name', 0, 0)"
            ),
            harness.env.DB.prepare(
                "INSERT INTO channels (telegram_chat_id, release_version, created_at) VALUES (-200, '1.0.0', 0)"
            ),
            harness.env.DB.prepare(
                'INSERT INTO channel_members (channel_id, player_id, created_at, updated_at) SELECT c.id, p.id, 0, 0 FROM channels c, players p'
            )
        ]);

        const restored = await game.restoreChannel(chatId, 'ua', at(10));
        const channel = await readChannel(chatId);
        const { results: playersOfThree } = await harness.env.DB.prepare(
            'SELECT display_name AS displayName FROM players WHERE telegram_user_id = 3'
        ).all<{ displayName: string }>();

        assert.equal(restored.locale, 'en');
        assert.deepEqual(await readScores(chatId), scoresBefore);
        assert.equal(await countRows(harness, 'vote_wins'), 6);
        assert.equal(await countRows(harness, 'players'), 5);
        assert.deepEqual(playersOfThree, [{ displayName: 'Fresh Name' }]);
        assert.equal(channel?.language, 'en');
        assert.equal(channel?.lastVoteAt, baseTime);
        assert.equal(channel?.stoppedAt, null);
        assert.equal(channel?.releaseVersion, getLatestReleaseVersion());
        assert.equal((await readScores(-200)).length, 1);

        const { results: winsByUser } = await harness.env.DB.prepare(
            `SELECT p.telegram_user_id AS telegramUserId, count(*) AS wins
            FROM vote_wins w JOIN players p ON p.id = w.player_id
            GROUP BY p.telegram_user_id ORDER BY p.telegram_user_id`
        ).all<{ telegramUserId: number; wins: number }>();

        assert.deepEqual(winsByUser, [
            { telegramUserId: 1, wins: 2 },
            { telegramUserId: 2, wins: 1 },
            { telegramUserId: 3, wins: 1 },
            { telegramUserId: 4, wins: 1 },
            { telegramUserId: 5, wins: 1 }
        ]);
    });

    it('restore over existing data saves a restore snapshot first and a second restore undoes the first', async () => {
        await seedChannel(chatId, { lastMemberId: 5 });

        const game = createGame();
        const originalScores = await readScores(chatId);

        await game.forgetChannel(chatId, 'en', at(0));
        await game.restoreChannel(chatId, 'en', at(10));

        assert.deepEqual(await readSnapshotReasons(), ['forget']);

        await harness.env.DB.prepare(
            'UPDATE channel_members SET score = score + 10'
        ).run();

        const changedScores = await readScores(chatId);

        await game.restoreChannel(chatId, 'en', at(20));

        assert.deepEqual(await readSnapshotReasons(), ['forget', 'restore']);
        assert.deepEqual(await readScores(chatId), originalScores);

        await game.restoreChannel(chatId, 'en', at(30));

        assert.deepEqual(await readScores(chatId), changedScores);
        assert.deepEqual(await readSnapshotReasons(), [
            'forget',
            'restore',
            'restore'
        ]);
        assert.equal(await countRows(harness, 'players'), 10);
    });

    it('restore ignores expired snapshots', async () => {
        await seedChannel(chatId, { lastMemberId: 5 });

        const game = createGame();

        await game.forgetChannel(chatId, 'en', at(0));

        await assert.rejects(
            game.restoreChannel(
                chatId,
                'en',
                new Date(baseTime + channelSnapshotRetentionMilliseconds)
            ),
            {
                name: 'BotUserError',
                message: getMessages('en').restoreNotFound()
            }
        );
        assert.equal(await readChannel(chatId), null);

        const restored = await game.restoreChannel(
            chatId,
            'en',
            new Date(baseTime + channelSnapshotRetentionMilliseconds - 1)
        );

        assert.equal(restored.locale, 'en');
        assert.equal((await readScores(chatId)).length, 5);
    });

    it('every snapshot insert prunes expired snapshots of any chat', async () => {
        await seedChannel(chatId, { lastMemberId: 5 });
        await harness.env.DB.batch([
            harness.env.DB.prepare(
                "INSERT INTO channel_snapshots (telegram_chat_id, reason, payload, created_at, expires_at) VALUES (-999, 'reset', '{}', 1, 2)"
            ),
            harness.env.DB.prepare(
                "INSERT INTO channel_snapshots (telegram_chat_id, reason, payload, created_at, expires_at) VALUES (-888, 'reset', '{}', 1, ?)"
            ).bind(baseTime + 1_000_000)
        ]);

        await createGame().resetScores(chatId, 'en', at(0));

        const { results } = await harness.env.DB.prepare(
            'SELECT telegram_chat_id AS telegramChatId FROM channel_snapshots ORDER BY telegram_chat_id'
        ).all<{ telegramChatId: number }>();

        assert.deepEqual(results, [
            { telegramChatId: -888 },
            { telegramChatId: chatId }
        ]);
    });

    it('restore of a 250-member, 600-win group round-trips', async () => {
        const memberCount = 250;
        const winCount = 600;

        await harness.env.DB.prepare('DELETE FROM players').run();
        await seedGeneratedPlayers(harness, memberCount);
        await seedChannel(chatId, {
            lastMemberId: memberCount,
            lastVoteAt: baseTime
        });
        await seedWins(chatId, winCount);

        const readWins = async () => {
            const { results } = await harness.env.DB.prepare(
                `SELECT p.telegram_user_id AS telegramUserId, w.won_at AS wonAt, w.mode AS mode, w.eligible_count AS eligibleCount
                FROM vote_wins w JOIN players p ON p.id = w.player_id
                ORDER BY w.won_at`
            ).all();

            return results;
        };
        const scoresBefore = await readScores(chatId);
        const winsBefore = await readWins();
        const game = createGame();

        await game.forgetChannel(chatId, 'en', at(0));

        assert.equal(await countRows(harness, 'players'), 0);
        assert.equal(await countRows(harness, 'vote_wins'), 0);

        await game.restoreChannel(chatId, 'en', at(10));

        assert.equal(await countRows(harness, 'players'), memberCount);
        assert.deepEqual(await readScores(chatId), scoresBefore);
        assert.equal(winsBefore.length, winCount);
        assert.deepEqual(await readWins(), winsBefore);
    });

    it('refuses reset and forget when the restore would need too many statements', async () => {
        const memberCount = 2500;
        const winCount = 12_500;

        await harness.env.DB.prepare('DELETE FROM players').run();
        await seedGeneratedPlayers(harness, memberCount);
        await seedChannel(chatId, { lastMemberId: memberCount });
        await seedWins(chatId, winCount);

        const game = createGame();
        const errorLog = mock.method(console, 'error', () => undefined);
        const scoresBefore = await readScores(chatId);

        try {
            await assert.rejects(game.resetScores(chatId, 'en', at(0)), {
                message: getMessages('en').snapshotTooLarge()
            });
            await assert.rejects(game.forgetChannel(chatId, 'en', at(0)), {
                message: getMessages('en').snapshotTooLarge()
            });

            const logged = errorLog.mock.calls.map(call => {
                return JSON.parse(String(call.arguments[0]));
            });

            assert.equal(logged.length, 2);
            assert.equal(logged[0].event, 'channel_snapshot_too_large');
            assert.equal(logged[0].estimatedStatements, 910);
            assert.ok(logged[0].bytes < 1_900_000);
        } finally {
            errorLog.mock.restore();
        }

        assert.deepEqual(await readScores(chatId), scoresBefore);
        assert.equal(await countRows(harness, 'channel_snapshots'), 0);
        assert.equal(await countRows(harness, 'vote_wins'), winCount);
    });

    it('restore proceeds without a safety snapshot when the current state is too large to back up', async () => {
        const memberCount = 2500;
        const winCount = 12_500;

        await harness.env.DB.prepare('DELETE FROM players').run();
        await seedGeneratedPlayers(harness, memberCount);
        await seedChannel(chatId, { lastMemberId: 5 });

        const scoresBefore = await readScores(chatId);
        const game = createGame();

        await game.forgetChannel(chatId, 'en', at(0));
        await seedChannel(chatId, {
            firstMemberId: 6,
            lastMemberId: memberCount
        });
        await seedWins(chatId, winCount);

        assert.equal(await countRows(harness, 'vote_wins'), winCount);

        const errorLog = mock.method(console, 'error', () => undefined);

        try {
            await game.restoreChannel(chatId, 'en', at(10));

            const logged = errorLog.mock.calls.map(call => {
                return JSON.parse(String(call.arguments[0]));
            });

            assert.equal(logged.length, 1);
            assert.deepEqual(Object.keys(logged[0]).sort(), [
                'bytes',
                'estimatedStatements',
                'event'
            ]);
            assert.equal(
                logged[0].event,
                'channel_restore_safety_snapshot_skipped'
            );
            assert.equal(logged[0].estimatedStatements, 910);
        } finally {
            errorLog.mock.restore();
        }

        assert.deepEqual(await readSnapshotReasons(), ['forget']);
        assert.deepEqual(await readScores(chatId), scoresBefore);
        assert.equal(await countRows(harness, 'vote_wins'), 0);
        assert.equal(await countRows(harness, 'players'), 5);
    });

    it('keeps at most the newest snapshots per chat across reset cycles and leaves other chats untouched', async () => {
        const cycleCount = channelSnapshotMaxPerChat + 2;

        await seedChannel(chatId, { lastMemberId: 5 });
        await seedOtherChatSnapshots(channelSnapshotMaxPerChat + 1);

        const game = createGame();

        for (let cycle = 0; cycle < cycleCount; cycle += 1) {
            await game.resetScores(chatId, 'en', at(cycle * 10));
        }

        assert.deepEqual(
            await readSnapshotCreatedAt(chatId),
            Array.from(
                { length: channelSnapshotMaxPerChat },
                (_value, index) => {
                    return at((index + 2) * 10).getTime();
                }
            )
        );
        assert.equal(
            (await readSnapshotCreatedAt(otherChatId)).length,
            channelSnapshotMaxPerChat + 1
        );
    });

    it('keeps at most the newest snapshots per chat across forget and restore cycles', async () => {
        await seedChannel(chatId, { lastMemberId: 5 });

        const game = createGame();

        await game.forgetChannel(chatId, 'en', at(0));

        for (
            let cycle = 1;
            cycle <= channelSnapshotMaxPerChat + 1;
            cycle += 1
        ) {
            await game.restoreChannel(chatId, 'en', at(cycle * 10));
        }

        const createdAt = await readSnapshotCreatedAt(chatId);

        assert.equal(createdAt.length, channelSnapshotMaxPerChat);
        assert.equal(
            createdAt.at(-1),
            at((channelSnapshotMaxPerChat + 1) * 10).getTime()
        );
        assert.ok(
            createdAt.every((value, index) => {
                return index === 0 || value > (createdAt[index - 1] ?? 0);
            })
        );
        assert.equal((await readScores(chatId)).length, 5);
    });

    it('wraps repository failures without leaking the snapshot payload', async () => {
        await seedChannel(chatId, { lastMemberId: 5 });

        const channelRow = await harness.env.DB.prepare(
            'SELECT id FROM channels WHERE telegram_chat_id = ?'
        )
            .bind(chatId)
            .first<{ id: number }>();
        const repositories = createRepositories(createDb(harness.env));
        const secretPayload = 'SECRET_SNAPSHOT_PAYLOAD_MARKER';
        const failure = await Effect.runPromise(
            Effect.flip(
                repositories.channelSnapshots.resetChannelWithSnapshot({
                    channelId: channelRow?.id as number,
                    snapshot: {
                        telegramChatId: chatId,
                        reason: 'invalid' as never,
                        payload: secretPayload,
                        createdAt: at(0),
                        expiresAt: at(100)
                    }
                })
            )
        );

        assert.ok(failure instanceof Error);
        assert.match(failure.message, /^Channel snapshot repository failure: /);
        assert.equal(failure.message.includes(secretPayload), false);
        assert.equal(await countRows(harness, 'channel_snapshots'), 0);
    });

    it('paused channel refuses manual runs, stays silent on auto runs and resumes through ensureChannel', async () => {
        await seedChannel(chatId, { lastMemberId: 3 });

        const game = createGame();
        const LL = getMessages('en');
        const reader = createAdminReader();
        const runAt = at(100);

        await game.stopChannel(chatId, 'en', at(0));

        assert.equal((await readChannel(chatId))?.stoppedAt, baseTime);

        await assert.rejects(
            game.runVote(chatId, 1, runAt, reader, 'manual', false, 'en'),
            (error: unknown) => {
                return (
                    error instanceof BotUserError &&
                    error.message === LL.gameStopped() &&
                    !error.silent
                );
            }
        );
        await assert.rejects(
            game.runVote(chatId, 1, runAt, reader, 'auto', false, 'en'),
            (error: unknown) => {
                return (
                    error instanceof BotUserError &&
                    error.message === LL.gameStopped() &&
                    error.silent
                );
            }
        );
        await assert.rejects(game.stopChannel(chatId, 'en', at(1)), {
            message: LL.alreadyStop()
        });
        assert.equal((await readChannel(chatId))?.lastVoteAt, null);
        assert.equal(await countRows(harness, 'channel_members'), 3);

        const stillStopped = await game.ensureChannel(chatId, false);

        assert.equal(stillStopped.state, 'stopped');
        assert.equal((await readChannel(chatId))?.stoppedAt, baseTime);

        const resumed = await game.ensureChannel(chatId, true);

        assert.equal(resumed.state, 'resumed');
        assert.equal((await readChannel(chatId))?.stoppedAt, null);
        assert.equal(
            (await game.ensureChannel(chatId, true)).state,
            'existing'
        );
        assert.equal(
            (await game.ensureChannel(otherChatId, true)).state,
            'created'
        );
    });
});
