import assert from 'node:assert/strict';
import test from 'node:test';

import {
    renderDebugReport,
    type ChannelDebugInfo,
    type DebugReport
} from '../src/bot/content/debug-report';
import { getMessages } from '../src/bot/content/messages';

const LL = getMessages('en');

const registeredInfo: ChannelDebugInfo = {
    channel: {
        id: 12,
        telegramChatId: -1001,
        language: 'en',
        releaseVersion: '5.0.0',
        lastVoteAt: new Date('2026-09-30T08:15:30.123Z'),
        botAdminStatus: 'admin',
        botAdminCheckedAt: new Date('2026-10-01T01:00:00.000Z'),
        stoppedAt: null,
        createdAt: new Date('2026-09-01T10:00:00.000Z')
    },
    memberCounts: { total: 5, active: 4, autoJoined: 3 },
    actor: {
        player: { id: 33 },
        member: { isActive: true, isAutoJoined: false, score: 7 }
    },
    latestWin: {
        wonAt: new Date('2026-09-30T08:15:30.000Z'),
        mode: 'auto',
        eligibleCount: 4
    },
    latestSnapshot: {
        reason: 'reset',
        createdAt: new Date('2026-09-25T12:00:00.000Z'),
        expiresAt: new Date('2026-10-02T12:00:00.000Z')
    }
};

const createReport = (overrides: Partial<DebugReport> = {}): DebugReport => {
    return {
        chatId: -1001,
        chatType: 'supergroup',
        userId: 77,
        environment: 'production',
        currentReleaseVersion: '5.1.0',
        liveStatuses: { user: 'member', bot: 'administrator' },
        info: registeredInfo,
        ...overrides
    };
};

test('a registered group report lists ids, live and stored state', () => {
    const text = renderDebugReport(createReport(), LL);

    assert.ok(text.includes('Chat ID: <code>-1001</code>'));
    assert.ok(text.includes('Chat type: <code>supergroup</code>'));
    assert.ok(text.includes('Your user ID: <code>77</code>'));
    assert.ok(text.includes('Your status: <code>member</code>'));
    assert.ok(text.includes('Bot status: <code>administrator</code>'));
    assert.ok(text.includes('Registered: <code>yes</code>'));
    assert.ok(text.includes('Channel DB ID: <code>12</code>'));
    assert.ok(text.includes('Stored release: <code>5.0.0</code>'));
    assert.ok(text.includes('Current release: <code>5.1.0</code>'));
    assert.ok(text.includes('Environment: <code>production</code>'));
    assert.ok(text.includes('Bot status (stored): <code>admin</code>'));
    assert.ok(
        text.includes(
            'Bot status checked at: <code>2026-10-01T01:00:00Z</code>'
        )
    );
    assert.ok(text.includes('Created at: <code>2026-09-01T10:00:00Z</code>'));
    assert.ok(text.includes('Total: <code>5</code>'));
    assert.ok(text.includes('Active: <code>4</code>'));
    assert.ok(text.includes('Auto-joined: <code>3</code>'));
    assert.ok(text.includes('Your player ID: <code>33</code>'));
    assert.ok(text.includes('Your score: <code>7</code>'));
    assert.ok(text.includes('Won at: <code>2026-09-30T08:15:30Z</code>'));
    assert.ok(text.includes('Mode: <code>auto</code>'));
    assert.ok(text.includes('Eligible players: <code>4</code>'));
    assert.ok(text.includes('Reason: <code>reset</code>'));
    assert.ok(text.includes('Expires at: <code>2026-10-02T12:00:00Z</code>'));
});

test('the chat section comes first so ids are at the very top', () => {
    const text = renderDebugReport(createReport(), LL);

    assert.ok(text.startsWith(`<strong>${LL.debug.chatSection()}</strong>\n`));
    assert.ok(
        text.indexOf(LL.debug.chatSection()) <
            text.indexOf(LL.debug.botSection())
    );
});

test('null dates and a missing win or backup are printed as a dash', () => {
    const text = renderDebugReport(
        createReport({
            info: {
                ...registeredInfo,
                channel: {
                    ...registeredInfo.channel!,
                    lastVoteAt: null,
                    botAdminStatus: null,
                    botAdminCheckedAt: null
                },
                latestWin: null,
                latestSnapshot: null
            }
        }),
        LL
    );

    assert.ok(text.includes('Paused at: <code>-</code>'));
    assert.ok(text.includes('Last vote at: <code>-</code>'));
    assert.ok(text.includes('Bot status (stored): <code>-</code>'));
    assert.ok(text.includes('Bot status checked at: <code>-</code>'));
    assert.ok(text.includes('<strong>Last winner</strong>\n<code>-</code>'));
    assert.ok(text.includes('<strong>Backup</strong>\n<code>-</code>'));
});

test('a paused group reports when it was stopped', () => {
    const text = renderDebugReport(
        createReport({
            info: {
                ...registeredInfo,
                channel: {
                    ...registeredInfo.channel!,
                    stoppedAt: new Date('2026-09-29T00:00:00.000Z')
                }
            }
        }),
        LL
    );

    assert.ok(text.includes('Paused at: <code>2026-09-29T00:00:00Z</code>'));
});

test('an unavailable live status is reported as unavailable', () => {
    const text = renderDebugReport(
        createReport({ liveStatuses: { user: null, bot: null } }),
        LL
    );

    assert.ok(text.includes('Your status: <code>unavailable</code>'));
    assert.ok(text.includes('Bot status: <code>unavailable</code>'));
});

test('a chat without a channel row still reports ids and the backup', () => {
    const text = renderDebugReport(
        createReport({
            info: {
                channel: null,
                memberCounts: { total: 0, active: 0, autoJoined: 0 },
                actor: { player: null, member: null },
                latestWin: null,
                latestSnapshot: registeredInfo.latestSnapshot
            }
        }),
        LL
    );

    assert.ok(text.includes('Chat ID: <code>-1001</code>'));
    assert.ok(text.includes('Registered: <code>no</code>'));
    assert.equal(text.includes('Channel DB ID'), false);
    assert.equal(text.includes('Players'), false);
    assert.ok(text.includes('Reason: <code>reset</code>'));
});

test('a player who is not in the game is reported as such', () => {
    const text = renderDebugReport(
        createReport({
            info: {
                ...registeredInfo,
                actor: { player: { id: 33 }, member: null }
            }
        }),
        LL
    );

    assert.ok(text.includes('Your player ID: <code>33</code>'));
    assert.ok(text.includes('<code>You are not in the game</code>'));
    assert.equal(text.includes('Your score'), false);
});

test('a private chat reports ids and a no group data note only', () => {
    const text = renderDebugReport(
        createReport({
            chatId: 77,
            chatType: 'private',
            liveStatuses: null,
            info: null
        }),
        LL
    );

    assert.ok(text.includes('Chat ID: <code>77</code>'));
    assert.ok(text.includes('Chat type: <code>private</code>'));
    assert.ok(text.includes('Your user ID: <code>77</code>'));
    assert.ok(text.includes(LL.debug.noGroupData()));
    assert.equal(text.includes('Your status'), false);
    assert.equal(text.includes('Registered'), false);
    assert.equal(text.includes('Backup'), false);
});

test('displayed values are HTML-escaped', () => {
    const text = renderDebugReport(
        createReport({ chatType: '<b>&', environment: 'a"b' }),
        LL
    );

    assert.ok(text.includes('<code>&lt;b&gt;&amp;</code>'));
    assert.ok(text.includes('<code>a&quot;b</code>'));
});

test('the Ukrainian report uses translated labels', () => {
    const text = renderDebugReport(createReport(), getMessages('ua'));

    assert.ok(text.includes('ID чату: <code>-1001</code>'));
    assert.ok(text.includes('Зареєстровано: <code>так</code>'));
});
