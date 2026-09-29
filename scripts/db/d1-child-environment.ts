import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

import {
    d1DatabaseIdEnvironmentNames,
    type D1DatabaseTarget
} from './production-d1-target';

const processEssentialKeys = new Set([
    'APPDATA',
    'COMSPEC',
    'ComSpec',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR',
    'XDG_CONFIG_HOME'
]);
const cloudflareAccountIdPattern = /^[0-9a-f]{32}$/;

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
export type ChildProcessEnvironment = Record<string, string>;
export type CloudflareAuthMode = 'token' | 'wrangler-login';

export const wranglerLoginAuthMode = 'wrangler-login';

const requireCredential = (
    source: EnvironmentSource,
    name: string,
    validator?: (value: string) => boolean
) => {
    const value = source[name];

    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value ||
        /\s/.test(value) ||
        (validator !== undefined && !validator(value))
    ) {
        throw new Error(`${name} is required and invalid`);
    }

    return value;
};

const createProcessEssentials = (source: EnvironmentSource) => {
    const environment: ChildProcessEnvironment = {};

    for (const [name, value] of Object.entries(source)) {
        if (value !== undefined && processEssentialKeys.has(name)) {
            environment[name] = value;
        }
    }

    return environment;
};

export const resolveCloudflareAuthMode = (
    source: EnvironmentSource
): CloudflareAuthMode => {
    const mode = source.CLOUDFLARE_AUTH_MODE;

    if (mode === undefined || mode === '' || mode === 'token') {
        return 'token';
    }

    if (mode !== wranglerLoginAuthMode) {
        throw new Error(
            `CLOUDFLARE_AUTH_MODE must be unset, "token" or "${wranglerLoginAuthMode}"`
        );
    }

    if (Boolean(source.CI) || Boolean(source.GITHUB_ACTIONS)) {
        throw new Error(
            `CLOUDFLARE_AUTH_MODE=${wranglerLoginAuthMode} is for local operators only and is rejected in CI`
        );
    }

    return wranglerLoginAuthMode;
};

export const loadD1Environment = (projectRoot: string) => {
    const dotenvPath = path.join(projectRoot, 'env/.env.d1');

    if (fs.existsSync(dotenvPath)) {
        loadDotenv({ path: dotenvPath, override: false });
    }
};

export const createDrizzleChildEnvironment = (
    source: EnvironmentSource,
    databaseId: string,
    target: D1DatabaseTarget = 'production'
): ChildProcessEnvironment => {
    return {
        ...createProcessEssentials(source),
        CLOUDFLARE_ACCOUNT_ID: requireCredential(
            source,
            'CLOUDFLARE_ACCOUNT_ID',
            value => cloudflareAccountIdPattern.test(value)
        ),
        [d1DatabaseIdEnvironmentNames[target]]: databaseId,
        CLOUDFLARE_D1_TOKEN: requireCredential(source, 'CLOUDFLARE_D1_TOKEN')
    } satisfies ChildProcessEnvironment;
};

export const createWranglerChildEnvironment = (
    source: EnvironmentSource,
    target: 'local' | D1DatabaseTarget,
    additionalEnvironment: ChildProcessEnvironment = {}
): ChildProcessEnvironment => {
    const environment = {
        ...createProcessEssentials(source),
        ...additionalEnvironment
    };

    if (target !== 'local') {
        environment.CLOUDFLARE_ACCOUNT_ID = requireCredential(
            source,
            'CLOUDFLARE_ACCOUNT_ID',
            value => cloudflareAccountIdPattern.test(value)
        );

        if (resolveCloudflareAuthMode(source) === 'token') {
            environment.CLOUDFLARE_API_TOKEN = requireCredential(
                source,
                'CLOUDFLARE_API_TOKEN'
            );
        }
    }

    return environment;
};
