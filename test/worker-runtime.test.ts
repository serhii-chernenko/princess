import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Effect } from 'effect';

import { renderReleaseNotes } from '../src/bot/content/releases';
import {
    getAvailableLanguagesMessage,
    getCommandList
} from '../src/bot/content/messages';
import { mapAppLocaleToI18nLocale, normalizeAppLocale } from '../src/bot/i18n';
import { getTelegramWebhookPath } from '../src/worker/env';
import {
    createGameService,
    getSortedPrintablePlayers
} from '../src/bot/services/game-service';
import type { createRepositories } from '../src/db/repositories';
import type { WorkerBindings } from '../src/worker/env';
import { escapeHtml } from '../src/bot/utils/strings';
import { formatUserName, isForwardedReply } from '../src/bot/utils/telegram';

test('typed release renderer exposes the latest changelog', () => {
    const rendered = renderReleaseNotes();

    assert.match(rendered, /4\.0\.1/);
    assert.match(rendered, /Нотатки/);
});

test('worker webhook path fails closed when it is not configured', () => {
    const path = getTelegramWebhookPath({});

    assert.equal(path, null);
});

test('telegram helpers preserve legacy username formatting rules', () => {
    assert.equal(
        formatUserName({
            username: 'princess',
            first_name: 'Test',
            last_name: 'User'
        }),
        '@princess'
    );

    assert.equal(
        formatUserName(
            {
                username: '',
                first_name: 'Test',
                last_name: 'User'
            },
            'name'
        ),
        'Test User'
    );
});

test('Telegram-controlled HTML text escapes markup and quotes', () => {
    assert.equal(
        escapeHtml(`Princess & <Admin> "quoted" 'single'`),
        'Princess &amp; &lt;Admin&gt; &quot;quoted&quot; &#39;single&#39;'
    );
});

test('vote ranking reuses reconciled players and their incremented scores', async () => {
    const winner = {
        member: {
            score: 3
        },
        player: {
            displayName: 'Winner'
        }
    };
    const printablePlayers = getSortedPrintablePlayers(
        [
            {
                member: {
                    score: 1
                },
                player: {
                    displayName: 'Runner-up'
                }
            },
            winner,
            {
                member: {
                    score: 0
                },
                player: {
                    displayName: 'No score'
                }
            }
        ],
        'top'
    );

    assert.deepEqual(
        printablePlayers.map(player => player.player.displayName),
        ['Winner', 'Runner-up']
    );

    const gameServiceSource = await readFile(
        new URL('../src/bot/services/game-service.ts', import.meta.url),
        'utf8'
    );
    const runVoteSource = gameServiceSource.slice(
        gameServiceSource.indexOf('    const runVote = async ('),
        gameServiceSource.indexOf('    const resetScores = async (')
    );

    assert.equal(runVoteSource.match(/reconcileActivePlayers\(/g)?.length, 1);
    assert.doesNotMatch(runVoteSource, /getPrintablePlayers\(/);
});

test('ordinary bot commands cannot trigger global stale-data cleanup', async () => {
    const botSource = await readFile(
        new URL('../src/bot/telegraf/bot.ts', import.meta.url),
        'utf8'
    );
    const stopHandlerSource = botSource.slice(
        botSource.indexOf("    bot.command('stop'"),
        botSource.indexOf("    bot.command('stats'")
    );

    assert.doesNotMatch(botSource, /game\.cleanupInactiveChannels\(/);
    assert.match(
        stopHandlerSource,
        /game\.stopChannel\(actor\.chatId, locale\)/
    );
});

test('forwarded reply guard only blocks the legacy forwarded-reply shape', () => {
    assert.equal(
        isForwardedReply({
            forward_from: {
                id: 1
            },
            reply_to_message: {
                message_id: 1
            }
        }),
        true
    );
    assert.equal(
        isForwardedReply({
            forward_from: {
                id: 1
            }
        }),
        false
    );
});

test('typed message catalog still exposes the command list', () => {
    const commands = getCommandList();

    assert.equal(commands.length > 0, true);
    assert.match(commands.join('\n'), /\/run/);
    assert.match(commands.join('\n'), /\/lang/);
});

test('ua locale aliases to uk internally', () => {
    assert.equal(normalizeAppLocale('ua'), 'ua');
    assert.equal(normalizeAppLocale('uk'), 'ua');
    assert.equal(mapAppLocaleToI18nLocale('ua'), 'uk');
});

test('available languages message mentions ua externally', () => {
    assert.match(
        getAvailableLanguagesMessage('ua'),
        /Available languages: en, ua/
    );
    assert.match(getAvailableLanguagesMessage('ua'), /Доступні мови: en, ua/);
});

const voteChannel = {
    id: 1,
    telegramChatId: -1001,
    language: 'en',
    releaseVersion: '1.0.0',
    lastVoteAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z')
};

interface RecordedWin {
    channelId: number;
    playerId: number;
    wonAt: Date;
    mode: string;
    eligibleCount: number;
}

const createVoteHarness = (
    memberCount: number,
    options: { failRecordWin?: boolean } = {}
) => {
    const calls = {
        resetChannelRun: 0,
        claimChannelRun: 0
    };
    const recordedWins: RecordedWin[] = [];
    const rows = Array.from({ length: memberCount }, (_unused, index) => {
        return {
            member: {
                id: index + 1,
                channelId: 1,
                playerId: index + 1,
                score: 0,
                isActive: true,
                isAutoJoined: true,
                createdAt: new Date(),
                updatedAt: new Date()
            },
            player: {
                id: index + 1,
                telegramUserId: 100 + index,
                displayName: `Player ${index + 1}`,
                createdAt: new Date(),
                updatedAt: new Date()
            }
        };
    });
    const repositories = {
        channels: {
            findChannelByTelegramChatId: () => Effect.succeed(voteChannel),
            listChannelMembers: () => {
                return Effect.succeed(rows.map(row => row.member));
            },
            resetChannelRun: () => {
                calls.resetChannelRun += 1;
                return Effect.void;
            },
            claimChannelRun: () => {
                calls.claimChannelRun += 1;
                return Effect.succeed({
                    ...voteChannel,
                    lastVoteAt: new Date()
                });
            },
            restoreClaimedChannelRun: () => Effect.void,
            touchChannelRun: () => Effect.void
        },
        channelMembers: {
            listMembersForChannel: () => Effect.succeed(rows),
            updateMemberState: () => Effect.void,
            incrementMemberScore: (memberId: number) => {
                return Effect.succeed(
                    rows.find(row => row.member.id === memberId)?.member
                );
            }
        },
        players: {
            updateDisplayName: () => Effect.void
        },
        voteWins: {
            recordWin: (win: RecordedWin) => {
                if (options.failRecordWin) {
                    return Effect.fail(new Error('history write failed'));
                }

                recordedWins.push(win);

                return Effect.succeed(win);
            }
        }
    } as unknown as ReturnType<typeof createRepositories>;
    const game = createGameService({} as WorkerBindings, repositories);

    return { calls, game, recordedWins };
};

const runAt = new Date('2026-01-03T00:00:00Z');

const createTelegram = (failure?: (userId: number) => Error | undefined) => {
    return {
        async getChatMember(_chatId: number, userId: number) {
            const error = failure?.(userId);

            if (error) {
                throw error;
            }

            return {
                status: 'member',
                user: {
                    id: userId,
                    is_bot: false,
                    first_name: `User${userId}`
                }
            } as never;
        }
    };
};

const createTelegramError = (errorCode: number, description?: string) => {
    return Object.assign(new Error('telegram failure'), {
        response: { error_code: errorCode, description }
    });
};

test('auto run below two active players stays silent and keeps the schedule', async () => {
    const { calls, game } = createVoteHarness(1);

    await assert.rejects(
        game.runVote(-1001, 100, runAt, createTelegram(), 'auto', false, 'en'),
        error => {
            return (error as { silent?: boolean }).silent === true;
        }
    );
    assert.equal(calls.resetChannelRun, 0);

    await assert.rejects(
        game.runVote(
            -1001,
            100,
            runAt,
            createTelegram(),
            'manual',
            false,
            'en'
        ),
        error => {
            return (error as { silent?: boolean }).silent === false;
        }
    );
    assert.equal(calls.resetChannelRun, 1);
});

test('definitive 400 member lookups drop the player and the vote continues', async () => {
    const { calls, game } = createVoteHarness(3);
    const telegram = createTelegram(userId => {
        return userId === 100
            ? createTelegramError(400, 'Bad Request: user not found')
            : undefined;
    });

    const result = await game.runVote(
        -1001,
        101,
        runAt,
        telegram,
        'manual',
        false,
        'en'
    );

    assert.equal(calls.claimChannelRun, 1);
    assert.notEqual(result.winner.player.telegramUserId, 100);
});

test('non-member 400 lookups such as chat not found abort the vote without reset', async () => {
    const { calls, game } = createVoteHarness(3);
    const telegram = createTelegram(userId => {
        return userId === 100
            ? createTelegramError(400, 'Bad Request: chat not found')
            : undefined;
    });
    const originalConsoleError = console.error;

    console.error = () => undefined;

    try {
        await assert.rejects(
            game.runVote(-1001, 101, runAt, telegram, 'auto', false, 'en'),
            error => {
                return (error as { silent?: boolean }).silent === true;
            }
        );
        await assert.rejects(
            game.runVote(-1001, 101, runAt, telegram, 'manual', false, 'en'),
            error => {
                return (error as { silent?: boolean }).silent === false;
            }
        );
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(calls.claimChannelRun, 0);
    assert.equal(calls.resetChannelRun, 0);
});

test('transient member lookup errors abort the vote before claiming', async () => {
    for (const errorCode of [429, 502]) {
        const { calls, game } = createVoteHarness(3);
        const telegram = createTelegram(userId => {
            return userId === 101 ? createTelegramError(errorCode) : undefined;
        });
        const originalConsoleError = console.error;
        const logged: string[] = [];

        console.error = (message: string) => {
            logged.push(message);
        };

        try {
            await assert.rejects(
                game.runVote(-1001, 100, runAt, telegram, 'auto', false, 'en'),
                error => {
                    return (error as { silent?: boolean }).silent === true;
                }
            );
            await assert.rejects(
                game.runVote(
                    -1001,
                    100,
                    runAt,
                    telegram,
                    'manual',
                    false,
                    'en'
                ),
                error => {
                    const botError = error as {
                        silent?: boolean;
                        message: string;
                    };

                    return (
                        botError.silent === false && botError.message.length > 0
                    );
                }
            );
            await assert.rejects(
                game.runVote(
                    -1001,
                    100,
                    runAt,
                    createTelegram(() => new TypeError('fetch failed')),
                    'manual',
                    false,
                    'en'
                )
            );
        } finally {
            console.error = originalConsoleError;
        }

        assert.equal(calls.claimChannelRun, 0);
        assert.equal(calls.resetChannelRun, 0);
        assert.equal(
            logged.some(entry => entry.includes('chat_member_lookup_failed')),
            true
        );
    }
});

test('runVote records the win with pool size and mode for auto, manual and sudo runs', async () => {
    const cases = [
        { type: 'auto', sudo: false, mode: 'auto' },
        { type: 'manual', sudo: false, mode: 'manual' },
        { type: 'manual', sudo: true, mode: 'sudo' }
    ] as const;

    for (const { type, sudo, mode } of cases) {
        const { game, recordedWins } = createVoteHarness(4);
        const telegram = {
            async getChatMember(_chatId: number, userId: number) {
                return {
                    status: userId === 100 ? 'creator' : 'member',
                    user: {
                        id: userId,
                        is_bot: false,
                        first_name: `User${userId}`
                    }
                } as never;
            }
        };

        const result = await game.runVote(
            -1001,
            100,
            runAt,
            telegram,
            type,
            sudo,
            'en'
        );

        assert.equal(recordedWins.length, 1, mode);
        assert.deepEqual(recordedWins[0], {
            channelId: 1,
            playerId: result.winner.player.id,
            wonAt: runAt,
            mode,
            eligibleCount: 4
        });
    }
});

test('eligibleCount counts only players that survive reconciliation', async () => {
    const { game, recordedWins } = createVoteHarness(4);
    const telegram = createTelegram(userId => {
        return userId === 100
            ? createTelegramError(400, 'Bad Request: user not found')
            : undefined;
    });

    await game.runVote(-1001, 101, runAt, telegram, 'manual', false, 'en');

    assert.equal(recordedWins[0]?.eligibleCount, 3);
});

test('a failed history insert is logged and never breaks the vote', async () => {
    const { calls, game, recordedWins } = createVoteHarness(3, {
        failRecordWin: true
    });
    const logged: string[] = [];
    const originalConsoleError = console.error;

    console.error = (message: string) => {
        logged.push(message);
    };

    try {
        const result = await game.runVote(
            -1001,
            100,
            runAt,
            createTelegram(),
            'manual',
            false,
            'en'
        );

        assert.equal(result.winner.member.score, 0);
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(calls.claimChannelRun, 1);
    assert.equal(recordedWins.length, 0);
    assert.equal(
        logged.some(entry => entry.includes('vote_win_record_failed')),
        true
    );
});

test('no history row is written when the vote is rejected', async () => {
    const { game, recordedWins } = createVoteHarness(1);

    await assert.rejects(
        game.runVote(-1001, 100, runAt, createTelegram(), 'manual', false, 'en')
    );

    assert.equal(recordedWins.length, 0);
});
