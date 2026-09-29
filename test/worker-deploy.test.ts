import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    getWorkerDeployArguments,
    parseWorkerDeployTarget
} from '../scripts/cloudflare/deploy-worker';

test('Worker deploy wrapper accepts only fixed production and beta targets', () => {
    assert.equal(parseWorkerDeployTarget('production'), 'production');
    assert.equal(parseWorkerDeployTarget('beta'), 'beta');
    assert.throws(() => {
        parseWorkerDeployTarget('staging');
    }, /Usage: deploy-worker\.ts <production\|beta>/);
});

test('Worker deploy wrapper builds fixed config, environment, and secrets arguments', () => {
    const configPath = path.resolve('/tmp/princess/wrangler.jsonc');
    const productionSecretsPath = path.resolve(
        '/tmp/princess/.dev.vars.production'
    );
    const betaSecretsPath = path.resolve('/tmp/princess/.dev.vars.beta');

    assert.deepEqual(
        getWorkerDeployArguments(
            'production',
            configPath,
            productionSecretsPath
        ),
        [
            'exec',
            'wrangler',
            'deploy',
            '--config',
            configPath,
            '--env',
            'production',
            '--secrets-file',
            productionSecretsPath
        ]
    );
    assert.deepEqual(
        getWorkerDeployArguments('beta', configPath, betaSecretsPath),
        [
            'exec',
            'wrangler',
            'deploy',
            '--config',
            configPath,
            '--env',
            'beta',
            '--secrets-file',
            betaSecretsPath
        ]
    );
});

test('all package Worker deploy commands use the fail-closed wrapper', () => {
    const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const wrapperSource = fs.readFileSync(
        path.resolve(process.cwd(), 'scripts/cloudflare/deploy-worker.ts'),
        'utf8'
    );

    assert.equal(
        packageJson.scripts['worker:deploy:stable'],
        'tsx scripts/cloudflare/deploy-worker.ts production'
    );
    assert.equal(
        packageJson.scripts['worker:deploy:production'],
        'pnpm run worker:deploy:stable'
    );
    assert.equal(
        packageJson.scripts['worker:deploy:beta'],
        'tsx scripts/cloudflare/deploy-worker.ts beta'
    );
    assert.match(wrapperSource, /resolveProductionD1DatabaseId/);
    assert.match(wrapperSource, /createWranglerChildEnvironment/);
    assert.match(wrapperSource, /loadD1Environment/);
    assert.doesNotMatch(wrapperSource, /\.\.\.process\.env/);
});

test('stable deploy workflow supplies the protected database confirmation', () => {
    const workflowSource = fs.readFileSync(
        path.resolve(process.cwd(), '.github/workflows/main.yml'),
        'utf8'
    );

    assert.match(
        workflowSource,
        /CLOUDFLARE_DATABASE_ID: \$\{\{ vars\.CLOUDFLARE_DATABASE_ID \}\}/
    );
    assert.match(workflowSource, /pnpm run worker:deploy:stable/);
});
