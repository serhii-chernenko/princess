import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderReleaseNotes } from '../src/bot/content/releases';
import {
    getAvailableLanguagesMessage,
    getCommandList
} from '../src/bot/content/messages';
import { mapAppLocaleToI18nLocale, normalizeAppLocale } from '../src/bot/i18n';
import { getTelegramWebhookPath } from '../src/worker/env';
import { getSortedPrintablePlayers } from '../src/bot/services/game-service';
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
