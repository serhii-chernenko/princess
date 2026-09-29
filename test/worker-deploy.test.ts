import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    getWorkerDeployArguments,
    parseWorkerDeployTarget
} from '../scripts/cloudflare/deploy-worker';

test('Worker deploy wrapper accepts only only the fixed production target', () => {
    assert.equal(parseWorkerDeployTarget('production'), 'production');
    assert.throws(() => {
        parseWorkerDeployTarget('beta');
    }, /Usage/);
    assert.throws(() => {
        parseWorkerDeployTarget('staging');
    }, /Usage: deploy-worker\.ts <production>/);
});

test('Worker deploy wrapper builds fixed config, environment, and secrets arguments', () => {
    const configPath = path.resolve('/tmp/princess/wrangler.jsonc');
    const productionSecretsPath = path.resolve(
        '/tmp/princess/.dev.vars.production'
    );

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
        packageJson.scripts['worker:deploy:prod'],
        'tsx scripts/cloudflare/deploy-worker.ts production'
    );
    assert.equal(packageJson.scripts['worker:deploy:beta'], undefined);
    assert.match(wrapperSource, /resolveD1DatabaseId/);
    assert.match(wrapperSource, /createWranglerChildEnvironment/);
    assert.match(wrapperSource, /loadD1Environment/);
    assert.doesNotMatch(wrapperSource, /\.\.\.process\.env/);
});

test('main workflow only validates and never deploys', () => {
    const workflowSource = fs.readFileSync(
        path.resolve(process.cwd(), '.github/workflows/main.yml'),
        'utf8'
    );

    assert.match(workflowSource, /pnpm run check/);
    assert.match(workflowSource, /wrangler deploy --env production --dry-run/);
    assert.doesNotMatch(workflowSource, /--env beta/);
    assert.doesNotMatch(workflowSource, /workflow_dispatch:/);
    assert.doesNotMatch(workflowSource, /^\s+deploy:/m);
    assert.doesNotMatch(workflowSource, /worker:deploy/);
    assert.doesNotMatch(workflowSource, /CLOUDFLARE_API_TOKEN/);
    assert.doesNotMatch(workflowSource, /secrets\./);
    assert.doesNotMatch(workflowSource, /\brg\b/);
});

test('copy workflow is manual, main-only, protected, and confirmed', () => {
    const workflowSource = fs.readFileSync(
        path.resolve(
            process.cwd(),
            '.github/workflows/copy-production-to-preview.yml'
        ),
        'utf8'
    );

    assert.match(workflowSource, /workflow_dispatch:/);
    assert.doesNotMatch(workflowSource, /^\s+(push|pull_request):/m);
    assert.match(workflowSource, /github\.ref == 'refs\/heads\/main'/);
    assert.match(workflowSource, /inputs\.confirmation == 'OVERWRITE PREVIEW'/);
    assert.match(workflowSource, /environment: preview/);
    assert.match(workflowSource, /permissions:\s+contents: read/);
    assert.match(workflowSource, /concurrency:/);
    assert.match(workflowSource, /--confirm-overwrite-preview/);
    assert.doesNotMatch(
        workflowSource,
        /^\s+run:.*\$\{\{\s*(?:secrets|vars)\./m
    );
});
