import assert from 'node:assert/strict';
import test from 'node:test';

import { renderReleaseNotes } from '../src/bot/content/releases';
import {
    getAvailableLanguagesMessage,
    getCommandList
} from '../src/bot/content/messages';
import { mapAppLocaleToI18nLocale, normalizeAppLocale } from '../src/bot/i18n';
import { getTelegramWebhookPath } from '../src/worker/env';
import { formatUserName, isForwardedReply } from '../src/bot/utils/telegram';

test('typed release renderer exposes the latest changelog', () => {
    const rendered = renderReleaseNotes();

    assert.match(rendered, /4\.0\.1/);
    assert.match(rendered, /Нотатки/);
});

test('worker webhook path falls back to the default route', () => {
    const path = getTelegramWebhookPath({
        DB: {} as D1Database
    });

    assert.equal(path, '/telegram');
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
