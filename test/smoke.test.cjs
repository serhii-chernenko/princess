const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

    assert.equal(version, '5.0.0');
    assert.equal(Array.isArray(versions), true);
    assert.equal(versions[0].version, version);
    assert.match(rendered, /5\.0\.0/);
    assert.doesNotMatch(rendered, /\[object Object\]/);
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

test('db layer files exist for the D1 migration path', async () => {
    const dbFiles = [
        '../src/db/index.ts',
        '../src/db/client.ts',
        '../src/db/schema.ts',
        '../src/db/schemas/index.ts',
        '../src/db/relations.ts',
        '../src/db/service.ts',
        '../src/db/repositories/index.ts',
        '../scripts/db/migrate-local.ts',
        '../scripts/db/prepare-mongo-import.ts',
        '../drizzle.production.config.ts',
        '../drizzle'
    ];

    for (const relativePath of dbFiles) {
        const absolutePath = path.join(__dirname, relativePath);

        assert.equal(fs.existsSync(absolutePath), true, absolutePath);
    }

    const drizzleDir = path.join(__dirname, '../drizzle');
    const migrationFiles = fs
        .readdirSync(drizzleDir, {
            recursive: true
        })
        .filter(fileName => fileName.endsWith('.sql'));

    assert.ok(migrationFiles.length > 0);
});

test('legacy rollback loads its isolated Mongo environment file', () => {
    const connectDbSource = fs.readFileSync(
        path.join(__dirname, '../bot/connect-db.js'),
        'utf8'
    );

    assert.match(
        connectDbSource,
        /'env', `\.env\.\$\{process\.env\.NODE_ENV\}`/
    );
    assert.doesNotMatch(connectDbSource, /\.dev\.vars/);
    assert.match(connectDbSource, /process\.env\.MONGODB_URI/);
});

test('remote migration and webhook cutover cannot run from ordinary CI deploys', () => {
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
    );
    const workflowSource = fs.readFileSync(
        path.join(__dirname, '../.github/workflows/main.yml'),
        'utf8'
    );
    const wranglerConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8')
    );

    assert.equal(packageJson.scripts['deploy:stable'], undefined);
    assert.equal(packageJson.scripts['deploy:production'], undefined);
    assert.equal(packageJson.scripts['deploy:beta'], undefined);
    assert.doesNotMatch(
        packageJson.scripts['worker:deploy:stable'],
        /db:migrate|telegram:webhook/
    );
    assert.doesNotMatch(
        packageJson.scripts['worker:deploy:beta'],
        /db:migrate|telegram:webhook/
    );
    assert.doesNotMatch(workflowSource, /workflow_dispatch:/);
    assert.doesNotMatch(workflowSource, /^\s+deploy:/m);
    assert.doesNotMatch(workflowSource, /worker:deploy/);
    assert.doesNotMatch(workflowSource, /db:migrate/);
    assert.doesNotMatch(workflowSource, /telegram:webhook/);
    assert.doesNotMatch(workflowSource, /secrets\./);
    assert.equal(wranglerConfig.env.production.workers_dev, false);
    assert.equal(wranglerConfig.env.beta.workers_dev, false);
});

test('game service logs claim-restore failures without raw error objects', () => {
    const gameServiceSource = fs.readFileSync(
        path.join(__dirname, '../src/bot/services/game-service.ts'),
        'utf8'
    );

    assert.match(gameServiceSource, /channel_run_claim_restore_failed/);
    assert.doesNotMatch(
        gameServiceSource,
        /console\.error\(\s*['"]failed to restore channel run claim/
    );
});
