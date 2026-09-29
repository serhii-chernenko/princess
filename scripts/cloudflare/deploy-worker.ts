import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createWranglerChildEnvironment,
    loadD1Environment
} from '../db/d1-child-environment';
import {
    d1DatabaseIdEnvironmentNames,
    resolveD1DatabaseId
} from '../db/production-d1-target';

export type WorkerDeployTarget = 'production';

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
);

export const parseWorkerDeployTarget = (
    value: string | undefined
): WorkerDeployTarget => {
    if (value === 'production') {
        return value;
    }

    throw new Error('Usage: deploy-worker.ts <production>');
};

export const getWorkerDeployArguments = (
    target: WorkerDeployTarget,
    configPath: string,
    secretsFilePath: string
) => {
    return [
        'exec',
        'wrangler',
        'deploy',
        '--config',
        path.resolve(configPath),
        '--env',
        target,
        '--secrets-file',
        path.resolve(secretsFilePath)
    ];
};

export const runWorkerDeploy = (target: WorkerDeployTarget) => {
    loadD1Environment(projectRoot);

    const wranglerConfigPath = path.join(projectRoot, 'wrangler.jsonc');

    resolveD1DatabaseId(
        wranglerConfigPath,
        target,
        process.env[d1DatabaseIdEnvironmentNames[target]]
    );

    const secretsFilePath = path.join(projectRoot, '.dev.vars.production');

    if (
        !fs.existsSync(secretsFilePath) ||
        !fs.statSync(secretsFilePath).isFile()
    ) {
        throw new Error(`Worker secrets file is missing: ${secretsFilePath}`);
    }

    const result = spawnSync(
        pnpmExecutable,
        getWorkerDeployArguments(target, wranglerConfigPath, secretsFilePath),
        {
            cwd: projectRoot,
            env: createWranglerChildEnvironment(
                process.env,
                target
            ) as unknown as NodeJS.ProcessEnv,
            stdio: 'inherit'
        }
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`Worker deploy exited with status ${result.status}`);
    }
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    try {
        runWorkerDeploy(parseWorkerDeployTarget(process.argv[2]));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
