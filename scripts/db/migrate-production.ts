import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    createDrizzleChildEnvironment,
    loadD1Environment
} from './d1-child-environment';
import { getProjectRoot } from './d1-import-target';
import { resolveProductionD1DatabaseId } from './production-d1-target';

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const getProductionMigrationArguments = (configPath: string) => {
    return [
        'exec',
        'drizzle-kit',
        'migrate',
        '--config',
        path.resolve(configPath)
    ];
};

export const runProductionMigration = () => {
    const projectRoot = getProjectRoot();

    loadD1Environment(projectRoot);

    const wranglerConfigPath = path.join(projectRoot, 'wrangler.jsonc');
    const productionDatabaseId = resolveProductionD1DatabaseId(
        wranglerConfigPath,
        process.env.CLOUDFLARE_DATABASE_ID
    );
    const drizzleConfigPath = path.join(
        projectRoot,
        'drizzle.production.config.ts'
    );
    const result = spawnSync(
        pnpmExecutable,
        getProductionMigrationArguments(drizzleConfigPath),
        {
            cwd: projectRoot,
            env: createDrizzleChildEnvironment(
                process.env,
                productionDatabaseId
            ) as unknown as NodeJS.ProcessEnv,
            stdio: 'inherit'
        }
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            `Production Drizzle migration exited with status ${result.status}`
        );
    }
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    try {
        runProductionMigration();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
