import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    assertRemoteD1Target,
    executeImportSql,
    getProjectRoot,
    preflightImportTarget,
    type ImportTarget
} from './d1-import-target';
import { loadD1Environment } from './d1-child-environment';
import { getDefaultGithubRepository, prepareMongoImport } from './mongo-import';

const usage =
    'Usage: run-mongo-import.ts <local|production|preview> [--input-dir <absolute-path>]';

const parseTarget = (value: string | undefined): ImportTarget => {
    if (value === 'local' || value === 'production' || value === 'preview') {
        return value;
    }

    throw new Error(usage);
};

export const parseImportInputDirectory = (arguments_: string[]) => {
    const rest = arguments_.filter(argument => argument !== '--');

    if (rest.length === 0) {
        return undefined;
    }

    const [flag, value, ...extra] = rest;

    if (flag !== '--input-dir' || !value || value.startsWith('--')) {
        throw new Error(usage);
    }

    if (extra.length > 0) {
        throw new Error(usage);
    }

    return value;
};

export type MongoImportSourceSelection =
    | { kind: 'directory'; directory: string }
    | {
          kind: 'github';
          repository: string;
          ref: string;
          requireCommitSha: boolean;
      };

export const resolveMongoImportSource = (
    target: ImportTarget,
    options: {
        projectRoot: string;
        environment: Readonly<Record<string, string | undefined>>;
        inputDirectory?: string | undefined;
    }
): MongoImportSourceSelection => {
    const { environment, inputDirectory, projectRoot } = options;
    const ref = environment.MONGO_BACKUP_REF || undefined;
    const directoryOverride =
        inputDirectory ?? (environment.MONGO_BACKUP_DIR || undefined);

    if (inputDirectory !== undefined && target !== 'preview') {
        throw new Error(
            `--input-dir is only supported for the preview import target, not ${target}`
        );
    }

    if (target === 'preview') {
        if (ref && directoryOverride) {
            throw new Error(
                'Choose either MONGO_BACKUP_DIR/--input-dir or MONGO_BACKUP_REF for the preview import, not both'
            );
        }

        if (ref) {
            return {
                kind: 'github',
                repository: resolveMongoBackupRepository(
                    target,
                    environment.MONGO_BACKUP_REPOSITORY
                ),
                ref,
                requireCommitSha: false
            };
        }

        const directory = path.resolve(
            directoryOverride ?? path.join(projectRoot, 'princess-db')
        );

        if (
            !fs.existsSync(directory) ||
            !fs.statSync(directory).isDirectory()
        ) {
            throw new Error(
                `Preview import backup directory does not exist: ${directory}. Set MONGO_BACKUP_DIR or pass --input-dir with an absolute path`
            );
        }

        return { kind: 'directory', directory };
    }

    if (!ref) {
        throw new Error(
            'MONGO_BACKUP_REF must identify the private backup repository commit to import'
        );
    }

    return {
        kind: 'github',
        repository: resolveMongoBackupRepository(
            target,
            environment.MONGO_BACKUP_REPOSITORY
        ),
        ref,
        requireCommitSha: target === 'production'
    };
};

export const resolveMongoBackupRepository = (
    target: ImportTarget,
    repositoryOverride: string | undefined
) => {
    const productionRepository = getDefaultGithubRepository();

    if (target === 'production' && repositoryOverride !== undefined) {
        throw new Error(
            `Production Mongo import does not accept MONGO_BACKUP_REPOSITORY; source is fixed to ${productionRepository}`
        );
    }

    return target === 'production'
        ? productionRepository
        : (repositoryOverride ?? productionRepository);
};

export const runMongoImport = async (
    target: ImportTarget,
    inputDirectory?: string
) => {
    const projectRoot = getProjectRoot();

    if (target !== 'local') {
        loadD1Environment(projectRoot);
    }

    const source = resolveMongoImportSource(target, {
        projectRoot,
        environment: process.env,
        inputDirectory
    });

    if (target !== 'local') {
        assertRemoteD1Target(target);
    }

    const outputDirectory = path.join(projectRoot, '.backups');
    const sqlPath = path.join(outputDirectory, 'mongo-to-d1.sql');

    try {
        const report = await prepareMongoImport({ source, outputDirectory });
        const preflightCounts = preflightImportTarget(target);

        console.log(
            JSON.stringify(
                {
                    target,
                    source: report.source,
                    sourceCounts: report.sourceCounts,
                    transformedCounts: report.transformedCounts,
                    validation: report.validation,
                    preflightCounts,
                    reportPath: report.outputReportPath
                },
                null,
                2
            )
        );

        executeImportSql(target, report.outputSqlPath);
    } finally {
        fs.rmSync(sqlPath, { force: true });
    }
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    void (async () => {
        await runMongoImport(
            parseTarget(process.argv[2]),
            parseImportInputDirectory(process.argv.slice(3))
        );
    })().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
