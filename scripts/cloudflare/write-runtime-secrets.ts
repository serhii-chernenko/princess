import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'dotenv';

import { workerRuntimeSecretKeys } from './runtime-env';

const productionDeployEnvironmentKeys = [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    ...workerRuntimeSecretKeys
] as const;

type ProductionDeployEnvironment = Partial<
    Record<(typeof productionDeployEnvironmentKeys)[number], string>
>;

const readRequiredSingleLineValue = (
    environment: ProductionDeployEnvironment,
    key: (typeof productionDeployEnvironmentKeys)[number]
) => {
    const value = environment[key];

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${key} must be a non-empty value`);
    }

    if (/\r|\n/.test(value)) {
        throw new Error(`${key} must not contain CR or LF characters`);
    }

    return value;
};

const serializeDotenvValue = (key: string, value: string) => {
    const candidates = [
        value,
        `'${value}'`,
        `"${value}"`,
        JSON.stringify(value)
    ];

    for (const candidate of candidates) {
        if (parse(`${key}=${candidate}\n`)[key] === value) {
            return candidate;
        }
    }

    throw new Error(`${key} cannot be represented safely in a dotenv file`);
};

export const formatProductionRuntimeSecrets = (
    environment: ProductionDeployEnvironment
) => {
    for (const key of productionDeployEnvironmentKeys) {
        readRequiredSingleLineValue(environment, key);
    }

    const lines = workerRuntimeSecretKeys.map(key => {
        const value = readRequiredSingleLineValue(environment, key);

        return `${key}=${serializeDotenvValue(key, value)}`;
    });

    return `${lines.join('\n')}\n`;
};

export const writeProductionRuntimeSecrets = (
    outputPath: string,
    environment: ProductionDeployEnvironment = process.env
) => {
    const resolvedOutputPath = path.resolve(outputPath);
    const content = formatProductionRuntimeSecrets(environment);

    fs.writeFileSync(resolvedOutputPath, content, {
        encoding: 'utf8',
        mode: 0o600
    });
    fs.chmodSync(resolvedOutputPath, 0o600);

    return resolvedOutputPath;
};

const run = () => {
    const outputPath = process.argv[2];

    if (!outputPath || process.argv.length !== 3) {
        throw new Error(
            'Usage: write-runtime-secrets.ts <runtime-secrets-output-path>'
        );
    }

    writeProductionRuntimeSecrets(outputPath);
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    try {
        run();
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Unknown error');
        process.exitCode = 1;
    }
}
