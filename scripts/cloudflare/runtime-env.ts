import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

export type EnvTarget = 'local' | 'production';
export type AppEnvTarget = 'local' | 'production' | 'beta';

const envFileByTarget: Record<AppEnvTarget, string> = {
    local: path.resolve('.dev.vars'),
    production: path.resolve('.dev.vars.production'),
    beta: path.resolve('.dev.vars.beta')
};

export const workerRuntimeSecretKeys = [
    'BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_WEBHOOK_PATH'
] as const;

export const loadOptionalEnvFile = (target: AppEnvTarget) => {
    const envFilePath = envFileByTarget[target];

    if (fs.existsSync(envFilePath)) {
        config({
            path: envFilePath,
            override: false
        });
    }

    return envFilePath;
};

export const requireEnv = (name: string) => {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
};

export const getWorkerRuntimeSecrets = () => {
    return workerRuntimeSecretKeys.reduce<Record<string, string>>(
        (accumulator, key) => {
            const value = process.env[key];

            if (value) {
                accumulator[key] = value;
            }

            return accumulator;
        },
        {}
    );
};

export const createWebhookUrl = () => {
    const workerBaseUrl = requireEnv('WORKER_BASE_URL').replace(/\/+$/, '');
    const webhookPathValue = requireEnv('TELEGRAM_WEBHOOK_PATH');
    const webhookPath = webhookPathValue.startsWith('/')
        ? webhookPathValue
        : `/${webhookPathValue}`;

    return `${workerBaseUrl}${webhookPath}`;
};
