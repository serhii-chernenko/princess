import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWranglerChildEnvironment } from './d1-child-environment';
import {
    d1DatabaseIdEnvironmentNames,
    resolveD1DatabaseId,
    type D1DatabaseTarget
} from './production-d1-target';

export type ImportTarget = 'local' | D1DatabaseTarget;
export type D1ExecuteTarget = 'local' | D1DatabaseTarget;

export interface ApplicationTableCounts {
    channels: number;
    players: number;
    channelMembers: number;
    telegramUpdates: number;
}

const emptyTargetSql = [
    'SELECT',
    '  (SELECT COUNT(*) FROM "channels") AS "channels",',
    '  (SELECT COUNT(*) FROM "players") AS "players",',
    '  (SELECT COUNT(*) FROM "channel_members") AS "channelMembers",',
    '  (SELECT COUNT(*) FROM "telegram_updates") AS "telegramUpdates";'
].join('\n');

const readCount = (value: unknown, name: string) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`Wrangler returned an invalid ${name} row count`);
    }

    return value as number;
};

export const parseApplicationTableCounts = (
    output: string
): ApplicationTableCounts => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(output) as unknown;
    } catch (error) {
        throw new Error(`Wrangler returned invalid JSON: ${String(error)}`);
    }

    if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error('Wrangler returned an unexpected D1 result envelope');
    }

    const envelope = parsed[0];

    if (
        typeof envelope !== 'object' ||
        envelope === null ||
        !('success' in envelope) ||
        envelope.success !== true ||
        !('results' in envelope) ||
        !Array.isArray(envelope.results) ||
        envelope.results.length !== 1
    ) {
        throw new Error('Wrangler did not return one successful D1 count row');
    }

    const row = envelope.results[0];

    if (typeof row !== 'object' || row === null) {
        throw new Error('Wrangler returned an invalid D1 count row');
    }

    return {
        channels: readCount(
            'channels' in row ? row.channels : undefined,
            'channels'
        ),
        players: readCount(
            'players' in row ? row.players : undefined,
            'players'
        ),
        channelMembers: readCount(
            'channelMembers' in row ? row.channelMembers : undefined,
            'channelMembers'
        ),
        telegramUpdates: readCount(
            'telegramUpdates' in row ? row.telegramUpdates : undefined,
            'telegramUpdates'
        )
    };
};

export const assertApplicationTablesEmpty = (
    counts: ApplicationTableCounts
) => {
    const populatedTables = Object.entries(counts).filter(([, count]) => {
        return count !== 0;
    });

    if (populatedTables.length > 0) {
        throw new Error(
            `D1 import target is not empty: ${populatedTables
                .map(([table, count]) => `${table}=${count}`)
                .join(', ')}`
        );
    }
};

export const getD1ExecuteArguments = (
    target: D1ExecuteTarget,
    configPath: string,
    operation: { command: string } | { file: string }
) => {
    const arguments_ = [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'DB',
        '--config',
        configPath
    ];

    if (target === 'local') {
        arguments_.push('--local');
    } else {
        arguments_.push('--env', target, '--remote');
    }

    if ('command' in operation) {
        arguments_.push('--command', operation.command, '--json');
    } else {
        arguments_.push('--file', operation.file);
    }

    arguments_.push('--yes');

    return arguments_;
};

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
);
const wranglerConfigPath = path.join(projectRoot, 'wrangler.jsonc');
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const assertRemoteD1Target = (target: D1DatabaseTarget) => {
    return resolveD1DatabaseId(
        wranglerConfigPath,
        target,
        process.env[d1DatabaseIdEnvironmentNames[target]]
    );
};

export const assertProductionD1Target = () => {
    return assertRemoteD1Target('production');
};

export const getWranglerConfigPath = () => wranglerConfigPath;

export const readApplicationTableCounts = (
    target: ImportTarget
): ApplicationTableCounts => {
    if (target !== 'local') {
        assertRemoteD1Target(target);
    }

    const result = spawnSync(
        pnpmExecutable,
        getD1ExecuteArguments(target, wranglerConfigPath, {
            command: emptyTargetSql
        }),
        {
            cwd: projectRoot,
            encoding: 'utf8',
            env: createWranglerChildEnvironment(
                process.env,
                target
            ) as unknown as NodeJS.ProcessEnv,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout).trim();

        throw new Error(
            detail
                ? `D1 empty-target preflight failed: ${detail}`
                : `D1 empty-target preflight exited with status ${result.status}`
        );
    }

    return parseApplicationTableCounts(result.stdout);
};

export const preflightImportTarget = (target: ImportTarget) => {
    const counts = readApplicationTableCounts(target);

    assertApplicationTablesEmpty(counts);

    return counts;
};

export const executeImportSql = (target: ImportTarget, sqlPath: string) => {
    if (target !== 'local') {
        assertRemoteD1Target(target);
    }

    const result = spawnSync(
        pnpmExecutable,
        getD1ExecuteArguments(target, wranglerConfigPath, { file: sqlPath }),
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
        throw new Error(`D1 import exited with status ${result.status}`);
    }
};

export const getProjectRoot = () => projectRoot;
