import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getLatestRelease,
    getReleaseItemText,
    normalizeReleaseRecords,
    renderReleaseAnnouncement,
    renderReleaseNotes,
    TELEGRAM_MESSAGE_LIMIT,
    type ReleaseRecord
} from '../src/bot/content/releases';

const bilingualRelease: ReleaseRecord = {
    version: '5.0.0',
    date: '29.09.2026',
    groups: {
        added: [
            { uk: 'Нова команда /lang.', en: 'New /lang command.' },
            { uk: 'Тільки українською.' }
        ],
        notes: [{ uk: 'Нотатка', en: 'A note' }]
    }
};

test('the newest release is 5.0.0 with Ukrainian and English items', () => {
    const latest = getLatestRelease();
    const items = Object.values(latest?.groups ?? {}).flat();

    assert.equal(latest?.version, '5.0.0');
    assert.ok(items.length > 0);
    assert.ok(items.every(item => item.uk.length > 0));
    assert.ok(items.every(item => (item.en ?? '').length > 0));
});

test('release items fall back to Ukrainian when English is missing', () => {
    assert.equal(getReleaseItemText({ uk: 'uk', en: 'en' }, 'en'), 'en');
    assert.equal(getReleaseItemText({ uk: 'uk', en: 'en' }, 'ua'), 'uk');
    assert.equal(getReleaseItemText({ uk: 'uk' }, 'en'), 'uk');
});

test('legacy string items normalize to Ukrainian-only items', () => {
    const [record] = normalizeReleaseRecords([
        {
            version: '1.0.0',
            date: '01.01.2020',
            groups: { notes: ['Перша версія'] }
        }
    ]);

    assert.deepEqual(record?.groups.notes, [{ uk: 'Перша версія' }]);
});

test('the announcement uses Ukrainian text and headings for ua channels', () => {
    const rendered = renderReleaseAnnouncement(bilingualRelease, 'ua');

    assert.match(rendered, /Бот оновлено до версії 5\.0\.0 🎉/);
    assert.match(rendered, /29\.09\.2026/);
    assert.match(rendered, /<strong>Додано<\/strong>/);
    assert.match(rendered, /- Нова команда \/lang\./);
    assert.match(rendered, /Нотатка/);
    assert.match(rendered, /\/releases/);
    assert.doesNotMatch(rendered, /New \/lang command/);
});

test('the announcement uses English text and headings for en channels', () => {
    const rendered = renderReleaseAnnouncement(bilingualRelease, 'en');

    assert.match(rendered, /The bot has been updated to version 5\.0\.0 🎉/);
    assert.match(rendered, /<strong>Added<\/strong>/);
    assert.match(rendered, /- New \/lang command\./);
    assert.match(rendered, /- Тільки українською\./);
    assert.match(rendered, /A note/);
    assert.match(rendered, /\/releases/);
});

test('release notes and announcements escape HTML in item text', () => {
    const release: ReleaseRecord = {
        version: '5.0.1',
        date: '01.10.2026',
        groups: { fixed: [{ uk: 'a <b>bold</b> & "quoted"' }] }
    };

    for (const rendered of [
        renderReleaseAnnouncement(release, 'ua'),
        renderReleaseNotes(0, 'ua')
    ]) {
        assert.doesNotMatch(rendered, /a <b>bold<\/b>/);
    }

    assert.match(
        renderReleaseAnnouncement(release, 'ua'),
        /a &lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot;/
    );
});

test('/releases renders English text for en channels', () => {
    assert.match(renderReleaseNotes(1, 'en'), /New \/lang command/);
    assert.match(renderReleaseNotes(1, 'ua'), /Команда \/lang/);
});

test('oversized announcements are truncated below the Telegram limit', () => {
    const release: ReleaseRecord = {
        version: '9.9.9',
        date: '01.01.2030',
        groups: {
            added: Array.from({ length: 200 }, (_value, index) => {
                return { uk: `Пункт ${index} & ${'слово '.repeat(20)}` };
            }),
            notes: [{ uk: 'Ніколи не показується' }]
        }
    };

    for (const locale of ['ua', 'en'] as const) {
        const rendered = renderReleaseAnnouncement(release, locale);

        assert.ok(rendered.length <= TELEGRAM_MESSAGE_LIMIT);
        assert.match(rendered, /…/);
        assert.match(rendered, /\/releases/);
        assert.doesNotMatch(rendered, /Ніколи не показується/);
        assert.doesNotMatch(rendered, /&(?![a-z#0-9]+;)/i);
    }
});

test('a single oversized item is cut instead of dropped', () => {
    const release: ReleaseRecord = {
        version: '9.9.9',
        date: '01.01.2030',
        groups: { added: [{ uk: 'x'.repeat(10_000) }] }
    };
    const rendered = renderReleaseAnnouncement(release, 'ua');

    assert.ok(rendered.length <= TELEGRAM_MESSAGE_LIMIT);
    assert.match(rendered, /xxxx…/);
});

test('short announcements are not truncated', () => {
    const rendered = renderReleaseAnnouncement(bilingualRelease, 'ua');

    assert.doesNotMatch(rendered, /…/);
});
