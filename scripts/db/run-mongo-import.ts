import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    assertProductionD1Target,
    executeImportSql,
    getProjectRoot,
    preflightImportTarget,
    type ImportTarget
} from './d1-import-target';
import { loadD1Environment } from './d1-child-environment';
import { getDefaultGithubRepository, prepareMongoImport } from './mongo-import';

const parseTarget = (value: string | undefined): ImportTarget => {
    if (value === 'local' || value === 'production') {
        return value;
    }

    throw new Error('Usage: run-mongo-import.ts <local|production>');
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

export const runMongoImport = async (target: ImportTarget) => {
    const projectRoot = getProjectRoot();

    if (target === 'production') {
        loadD1Environment(projectRoot);
    }

    const repository = resolveMongoBackupRepository(
        target,
        process.env.MONGO_BACKUP_REPOSITORY
    );

    if (target === 'production') {
        assertProductionD1Target();
    }

    const ref = process.env.MONGO_BACKUP_REF;

    if (!ref) {
        throw new Error(
            'MONGO_BACKUP_REF must identify the private backup repository commit to import'
        );
    }

    const outputDirectory = path.join(projectRoot, '.backups');
    const sqlPath = path.join(outputDirectory, 'mongo-to-d1.sql');

    try {
        const report = await prepareMongoImport({
            source: {
                kind: 'github',
                repository,
                ref,
                requireCommitSha: target === 'production'
            },
            outputDirectory
        });
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
    void runMongoImport(parseTarget(process.argv[2])).catch(
        (error: unknown) => {
            console.error(
                error instanceof Error ? error.message : String(error)
            );
            process.exitCode = 1;
        }
    );
}
