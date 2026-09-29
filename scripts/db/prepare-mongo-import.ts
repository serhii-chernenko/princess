import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDefaultGithubRepository, prepareMongoImport } from './mongo-import';

export { formatImportSql, prepareMongoImport } from './mongo-import';

interface CliOptions {
    source:
        | { kind: 'directory'; directory: string }
        | {
              kind: 'github';
              repository: string;
              ref: string;
              requireCommitSha: boolean;
          };
}

const readOptionValue = (arguments_: string[], index: number, name: string) => {
    const value = arguments_[index + 1];

    if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }

    return value;
};

export const parsePrepareMongoImportArguments = (
    arguments_: string[]
): CliOptions => {
    let directory = process.env.MONGO_BACKUP_DIR;
    let githubRef: string | undefined;
    let githubRepository =
        process.env.MONGO_BACKUP_REPOSITORY ?? getDefaultGithubRepository();
    let requireCommitSha = false;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];

        if (argument === '--input-dir') {
            directory = readOptionValue(arguments_, index, argument);
            index += 1;
        } else if (argument === '--github-ref') {
            githubRef = readOptionValue(arguments_, index, argument);
            index += 1;
        } else if (argument === '--github-repository') {
            githubRepository = readOptionValue(arguments_, index, argument);
            index += 1;
        } else if (argument === '--require-commit-sha') {
            requireCommitSha = true;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    githubRef ??= process.env.MONGO_BACKUP_REF;

    if (githubRef && directory) {
        throw new Error('Choose either --input-dir or --github-ref, not both');
    }

    if (githubRef) {
        return {
            source: {
                kind: 'github',
                repository: githubRepository,
                ref: githubRef,
                requireCommitSha
            }
        };
    }

    if (requireCommitSha) {
        throw new Error('--require-commit-sha is only valid with --github-ref');
    }

    return {
        source: {
            kind: 'directory',
            directory: directory ?? path.resolve(process.cwd(), 'princess-db')
        }
    };
};

const run = async () => {
    const options = parsePrepareMongoImportArguments(process.argv.slice(2));
    const report = await prepareMongoImport({ source: options.source });

    console.log(JSON.stringify(report, null, 2));
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    void run().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
