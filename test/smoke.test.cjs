const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN';
process.env.ADMIN_ID = process.env.ADMIN_ID || '1';
process.env.TG_CHANNEL = process.env.TG_CHANNEL || 'https://t.me/example';
process.env.TG_GROUP = process.env.TG_GROUP || 'https://t.me/example_group';
process.env.YT_CHANNEL =
    process.env.YT_CHANNEL || 'https://youtube.com/@example';
process.env.MAIL = process.env.MAIL || 'example@example.com';
process.env.WISHLIST_TG_URL =
    process.env.WISHLIST_TG_URL || 'https://t.me/example_wishlist';
process.env.CHATGPT_GITHUB_REPO_URL =
    process.env.CHATGPT_GITHUB_REPO_URL || 'https://github.com/example/repo';

test('core helpers expose the latest release consistently', async () => {
    const getVersion = require('../bot/helpers/version');
    const getVersions = require('../bot/helpers/versions');
    const renderReleases = require('../bot/helpers/releases');

    const version = getVersion();
    const versions = getVersions();
    const rendered = renderReleases();

    assert.equal(version, '4.0.1');
    assert.ok(versions[version]);
    assert.match(rendered, /4\.0\.1/);
    assert.match(rendered, /Нотатки/);
});

test('username helper preserves preferred user shape', async () => {
    const returnUserName = require('../bot/helpers/username');

    assert.equal(
        returnUserName({
            username: 'princess',
            first_name: 'Test',
            last_name: 'User'
        }),
        '@princess'
    );

    assert.equal(
        returnUserName(
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

test('bot modules load with a dummy environment', async () => {
    const bot = require('../bot/bot');
    const scenes = require('../bot/scenes');

    require('../bot/commands');
    require('../bot/listeners');

    assert.ok(bot);
    assert.equal(Array.isArray(scenes), true);
    assert.ok(scenes.length > 0);
});
