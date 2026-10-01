import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runRemoteMigration } from './migrate-production';
import {
    d1DatabaseIdEnvironmentNames,
    type D1DatabaseTarget
} from './production-d1-target';

export const productionBranch = 'main';
export const branchEnvironmentName = 'WORKERS_CI_BRANCH';
export const maxMigrationAttempts = 3;
export const retryDelayMilliseconds = 5_000;

const unsupportedBranchPrefix = 'refs/';
const transientD1ErrorPattern = /\b7403\b/;

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const resolveCiMigrationTarget = (
    source: EnvironmentSource
): D1DatabaseTarget => {
    if (source.WORKERS_CI !== '1') {
        throw new Error(
            'db:migrate:ci runs only inside Cloudflare Workers Builds (WORKERS_CI=1). Use db:migrate:prod or db:migrate:preview locally.'
        );
    }

    const branch = source[branchEnvironmentName]?.trim() ?? '';

    if (branch === '') {
        throw new Error(
            `${branchEnvironmentName} is empty; refusing to guess which database to migrate`
        );
    }

    if (branch.startsWith(unsupportedBranchPrefix)) {
        throw new Error(
            `${branchEnvironmentName} must be a bare branch name; refusing to interpret "${branch}"`
        );
    }

    return branch === productionBranch ? 'production' : 'preview';
};

export const assertPinnedCiConfiguration = (source: EnvironmentSource) => {
    const authMode = source.CLOUDFLARE_AUTH_MODE;

    if (authMode !== undefined && authMode !== '' && authMode !== 'token') {
        throw new Error(
            'db:migrate:ci supports only CLOUDFLARE_AUTH_MODE=token'
        );
    }

    const productionId = source[d1DatabaseIdEnvironmentNames.production];
    const previewId = source[d1DatabaseIdEnvironmentNames.preview];

    for (const [target, id] of [
        ['production', productionId],
        ['preview', previewId]
    ] as const) {
        if (!id) {
            throw new Error(
                `${d1DatabaseIdEnvironmentNames[target]} must be set as a Workers Builds build variable so the ${target} database id is pinned outside the repository`
            );
        }
    }

    if (productionId === previewId) {
        throw new Error(
            'The pinned production and preview database ids must differ'
        );
    }
};

export const isTransientD1Error = (error: unknown) => {
    return (
        error instanceof Error && transientD1ErrorPattern.test(error.message)
    );
};

export const runWithTransientRetry = async <Result>(
    operation: () => Promise<Result>,
    options: {
        maxAttempts?: number;
        delayMilliseconds?: number;
        sleep?: (milliseconds: number) => Promise<void>;
        onRetry?: (attempt: number, error: unknown) => void;
    } = {}
) => {
    const maxAttempts = options.maxAttempts ?? maxMigrationAttempts;
    const delayMilliseconds =
        options.delayMilliseconds ?? retryDelayMilliseconds;
    const sleep =
        options.sleep ??
        ((milliseconds: number) => {
            return new Promise<void>(resolve => {
                setTimeout(resolve, milliseconds);
            });
        });

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= maxAttempts || !isTransientD1Error(error)) {
                throw error;
            }

            options.onRetry?.(attempt, error);
            await sleep(delayMilliseconds * attempt);
        }
    }
};

export const runCiMigration = async (
    source: EnvironmentSource = process.env
) => {
    const target = resolveCiMigrationTarget(source);

    assertPinnedCiConfiguration(source);
    console.log(
        `Branch ${source[branchEnvironmentName]?.trim()}: applying D1 migrations to the ${target} database`
    );

    await runWithTransientRetry(
        () => {
            return runRemoteMigration(target);
        },
        {
            onRetry: (attempt, error) => {
                console.warn(
                    `D1 returned a transient error on attempt ${attempt}; retrying: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
                );
            }
        }
    );
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    runCiMigration().catch((error: unknown) => {
        console.error(
            error instanceof Error
                ? error.message.split('\n')[0]
                : String(error)
        );
        process.exitCode = 1;
    });
}
