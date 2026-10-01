import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    createDrizzleChildEnvironment,
    loadD1Environment,
    resolveCloudflareAuthMode,
    wranglerLoginAuthMode
} from './d1-child-environment';
import { getProjectRoot } from './d1-import-target';
import {
    d1DatabaseIdEnvironmentNames,
    resolveD1DatabaseId,
    type D1DatabaseTarget
} from './production-d1-target';
import { runWranglerLoginMigration } from './wrangler-login-migration';

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

export const redactSecret = (text: string, secret: string | undefined) => {
    return secret ? text.split(secret).join('[redacted]') : text;
};

export const runRemoteMigration = async (target: D1DatabaseTarget) => {
    const projectRoot = getProjectRoot();

    loadD1Environment(projectRoot);

    const wranglerConfigPath = path.join(projectRoot, 'wrangler.jsonc');
    const databaseId = resolveD1DatabaseId(
        wranglerConfigPath,
        target,
        process.env[d1DatabaseIdEnvironmentNames[target]]
    );

    if (resolveCloudflareAuthMode(process.env) === wranglerLoginAuthMode) {
        const result = await runWranglerLoginMigration(
            target,
            projectRoot,
            wranglerConfigPath
        );

        console.log(
            JSON.stringify(
                { target, authMode: wranglerLoginAuthMode, ...result },
                null,
                2
            )
        );

        return;
    }

    const drizzleConfigPath = path.join(
        projectRoot,
        `drizzle.${target}.config.ts`
    );
    const result = spawnSync(
        pnpmExecutable,
        getProductionMigrationArguments(drizzleConfigPath),
        {
            cwd: projectRoot,
            env: createDrizzleChildEnvironment(
                process.env,
                databaseId,
                target
            ) as unknown as NodeJS.ProcessEnv,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    const token = process.env.CLOUDFLARE_D1_TOKEN;
    const stdout = redactSecret(result.stdout ?? '', token);
    const stderr = redactSecret(result.stderr ?? '', token);

    process.stdout.write(stdout);
    process.stderr.write(stderr);

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const detail = `${stderr}${stdout}`.trim();

        throw new Error(
            detail
                ? `${target} Drizzle migration exited with status ${result.status}\n${detail}`
                : `${target} Drizzle migration exited with status ${result.status}`
        );
    }
};

export const runProductionMigration = async () => {
    await runRemoteMigration('production');
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    runProductionMigration().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
