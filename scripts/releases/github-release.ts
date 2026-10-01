import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import packageJson from '../../package.json';
import { compareSemver } from '../../src/bot/utils/semver';
import { getReleaseLabels } from '../../src/bot/content/messages';
import {
    parseChangelog,
    releaseGroupOrder,
    type ReleaseEntry
} from './changelog-parser';

const CHANGELOG_PATH = 'CHANGELOG.md';
const ENGLISH_LOCALE = 'en';
const CONTINUATION_INDENT = '  ';
export const FIRST_AUTOMATIC_VERSION = '5.0.0';

export type GithubReleaseOptions = {
    version: string | null;
    target: string | null;
    print: boolean;
};

export type GithubCli = {
    releaseExists: (tag: string) => boolean;
    createRelease: (options: {
        tag: string;
        target: string;
        title: string;
        notes: string;
        isLatest: boolean;
    }) => void;
};

export const parseGithubReleaseArguments = (
    argv: string[]
): GithubReleaseOptions => {
    const options: GithubReleaseOptions = {
        version: null,
        target: null,
        print: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--print') {
            options.print = true;
        } else if (argument === '--version' || argument === '--target') {
            const value = argv[index + 1];

            if (!value || value.startsWith('--')) {
                throw new Error(`${argument} requires a value`);
            }

            if (argument === '--version') {
                options.version = value;
            } else {
                options.target = value;
            }

            index += 1;
        } else {
            throw new Error(`Unknown argument: ${String(argument)}`);
        }
    }

    return options;
};

export const findRelease = (releases: ReleaseEntry[], version: string) => {
    const release = releases.find(entry => entry.version === version);

    if (!release) {
        throw new Error(`Version ${version} is not in ${CHANGELOG_PATH}`);
    }

    return release;
};

export const formatReleaseDate = (date: string) => {
    const [day, month, year] = date.split('.');

    if (!day || !month || !year) {
        throw new Error(`Unexpected release date format: ${date}`);
    }

    return `${year}-${month}-${day}`;
};

export const getReleaseTitle = (release: ReleaseEntry) => {
    return `${release.version} - ${formatReleaseDate(release.date)}`;
};

const formatBullet = (text: string) => {
    const [firstLine = '', ...rest] = text.split('\n');
    const continuation = rest.map(line => {
        const trimmedLine = line.trim();

        return trimmedLine ? `${CONTINUATION_INDENT}${trimmedLine}` : '';
    });

    return [`- ${firstLine}`, ...continuation].join('\n');
};

export const renderGithubReleaseNotes = (release: ReleaseEntry) => {
    const labels = getReleaseLabels(ENGLISH_LOCALE);
    const sections: string[] = [];

    for (const group of releaseGroupOrder) {
        const items = release.groups[group];

        if (!items?.length) {
            continue;
        }

        const bullets = items.map(item => {
            return formatBullet(item.en ?? item.uk);
        });

        sections.push(`### ${labels[group]}\n\n${bullets.join('\n')}`);
    }

    return `${sections.join('\n\n')}\n`;
};

export type GithubReleaseDependencies = {
    cli: GithubCli;
    target: string;
    log?: (message: string) => void;
};

const publishOne = (
    releases: ReleaseEntry[],
    release: ReleaseEntry,
    target: string,
    cli: GithubCli
) => {
    cli.createRelease({
        tag: release.version,
        target,
        title: getReleaseTitle(release),
        notes: renderGithubReleaseNotes(release),
        isLatest: releases[0]?.version === release.version
    });
};

export const publishGithubReleases = (
    releases: ReleaseEntry[],
    options: GithubReleaseOptions,
    dependencies: GithubReleaseDependencies
) => {
    const { cli, target, log = console.log } = dependencies;
    const releaseTarget = options.target ?? target;
    const candidates = options.version
        ? [findRelease(releases, options.version)]
        : releases
              .filter(release => {
                  return (
                      compareSemver(release.version, FIRST_AUTOMATIC_VERSION) >=
                      0
                  );
              })
              .reverse();
    const published: string[] = [];

    for (const release of candidates) {
        if (cli.releaseExists(release.version)) {
            log(`GitHub release ${release.version} already exists; skipping.`);
            continue;
        }

        publishOne(releases, release, releaseTarget, cli);
        log(`Created GitHub release ${release.version}.`);
        published.push(release.version);
    }

    return published;
};

export const resolvePublishingCommit = () => {
    return (
        process.env.GITHUB_SHA ??
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    );
};

export const ghCli: GithubCli = {
    releaseExists: tag => {
        const result = spawnSync('gh', ['release', 'view', tag], {
            encoding: 'utf8'
        });

        if (result.error) {
            throw result.error;
        }

        if (result.status === 0) {
            return true;
        }

        if (/release not found/i.test(result.stderr)) {
            return false;
        }

        throw new Error(
            `gh release view ${tag} failed: ${result.stderr.trim()}`
        );
    },
    createRelease: ({ tag, target, title, notes, isLatest }) => {
        execFileSync(
            'gh',
            [
                'release',
                'create',
                tag,
                '--target',
                target,
                '--title',
                title,
                '--notes-file',
                '-',
                `--latest=${String(isLatest)}`
            ],
            { input: notes, stdio: ['pipe', 'inherit', 'inherit'] }
        );
    }
};

const run = () => {
    const options = parseGithubReleaseArguments(process.argv.slice(2));
    const releases = parseChangelog(fs.readFileSync(CHANGELOG_PATH, 'utf8'));

    if (options.print) {
        process.stdout.write(
            renderGithubReleaseNotes(
                findRelease(releases, options.version ?? packageJson.version)
            )
        );
        return;
    }

    publishGithubReleases(releases, options, {
        cli: ghCli,
        target: resolvePublishingCommit()
    });
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    try {
        run();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
