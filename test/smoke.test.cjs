const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

    assert.equal(packageJson.scripts['deploy:prod'], undefined);
    assert.equal(packageJson.scripts['deploy:production'], undefined);
    assert.doesNotMatch(
        packageJson.scripts['worker:deploy:prod'],
        /db:migrate|telegram:webhook/
    );
    assert.doesNotMatch(workflowSource, /workflow_dispatch:/);
    assert.doesNotMatch(workflowSource, /^\s+deploy:/m);
    assert.doesNotMatch(workflowSource, /worker:deploy/);
    assert.doesNotMatch(workflowSource, /db:migrate/);
    assert.doesNotMatch(workflowSource, /telegram:webhook/);
    assert.doesNotMatch(workflowSource, /secrets\./);
    assert.equal(wranglerConfig.env.production.workers_dev, false);
    assert.equal(wranglerConfig.env.beta, undefined);
    assert.equal(wranglerConfig.env.production.preview_urls, true);
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
