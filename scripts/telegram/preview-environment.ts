import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from 'dotenv';

import type { TelegramApiPayload } from './webhook';

export const PREVIEW_BOT_USERNAME = 'princess_debug_bot';
export const PREVIEW_ENVIRONMENT_KEYS = [
    'BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_WEBHOOK_PATH'
] as const;

const PREVIEW_ENVIRONMENT_FILE_NAME = '.dev.vars.preview';
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 60_000;

export type RunCommand = (command: string, args: string[]) => Promise<string>;

export class PreviewOperatorError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PreviewOperatorError';
    }
}

const execFileAsync = promisify(execFile);

export const runLocalCommand: RunCommand = async (command, args) => {
    const { stdout } = await execFileAsync(command, args, {
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        timeout: COMMAND_TIMEOUT_MILLISECONDS
    });

    return stdout;
};

export const resolveMainWorktreeRoot = async (
    runCommand: RunCommand,
    cwd: string
) => {
    try {
        const commonDirectory = path.resolve(
            cwd,
            (
                await runCommand('git', [
                    '-C',
                    cwd,
                    'rev-parse',
                    '--git-common-dir'
                ])
            ).trim()
        );

        return path.basename(commonDirectory) === '.git'
            ? path.dirname(commonDirectory)
            : undefined;
    } catch {
        return undefined;
    }
};

const loadEnvironmentFile = (
    filePath: string,
    environment: Record<string, string | undefined>
) => {
    config({
        path: filePath,
        override: false,
        processEnv: environment as Record<string, string>
    });
};

export const loadPreviewEnvironment = async (options: {
    runCommand: RunCommand;
    environment?: Record<string, string | undefined>;
    cwd?: string;
    fileExists?: (filePath: string) => boolean;
    load?: (
        filePath: string,
        environment: Record<string, string | undefined>
    ) => void;
}) => {
    const environment = options.environment ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const fileExists = options.fileExists ?? fs.existsSync;
    const load = options.load ?? loadEnvironmentFile;
    const mainRoot = await resolveMainWorktreeRoot(options.runCommand, cwd);
    const candidates = [
        ...new Set(
            [cwd, mainRoot].flatMap(directory => {
                return directory === undefined
                    ? []
                    : [path.join(directory, PREVIEW_ENVIRONMENT_FILE_NAME)];
            })
        )
    ];
    const envFilePath = candidates.find(fileExists);

    if (envFilePath === undefined) {
        throw new PreviewOperatorError(
            `Missing ${PREVIEW_ENVIRONMENT_FILE_NAME}. Looked in: ${candidates.join(', ')}. Create it with the preview bot BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_WEBHOOK_PATH.`
        );
    }

    for (const key of PREVIEW_ENVIRONMENT_KEYS) {
        Reflect.deleteProperty(environment, key);
    }

    load(envFilePath, environment);

    return envFilePath;
};

const readBotUsername = (payload: TelegramApiPayload) => {
    const { result } = payload;

    return typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result)
        ? (result as Record<string, unknown>).username
        : undefined;
};

export const requirePreviewBot = async (
    readBotIdentity: () => Promise<TelegramApiPayload>
) => {
    const payload = await readBotIdentity();

    if (readBotUsername(payload) !== PREVIEW_BOT_USERNAME) {
        throw new PreviewOperatorError(
            'BOT_TOKEN does not belong to the preview bot, so the webhook was not changed. Check .dev.vars.preview.'
        );
    }
};
