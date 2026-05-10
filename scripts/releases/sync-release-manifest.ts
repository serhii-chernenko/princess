import fs from 'node:fs';

const releaseGroupOrder = [
    'added',
    'updated',
    'fixed',
    'removed',
    'notes'
] as const;

type ReleaseGroup = (typeof releaseGroupOrder)[number];
type ReleaseEntry = {
    version: string;
    date: string;
    groups: Partial<Record<ReleaseGroup, string[]>>;
};

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const lines = changelog.split('\n');
const releases: ReleaseEntry[] = [];

let currentRelease: ReleaseEntry | null = null;
let currentGroup: ReleaseGroup | null = null;
let currentItem: string | null = null;

const flushItem = () => {
    if (!currentRelease || !currentGroup || currentItem === null) {
        currentItem = null;
        return;
    }

    const groups = currentRelease.groups;
    const existingGroupItems = groups[currentGroup] ?? [];

    groups[currentGroup] = [...existingGroupItems, currentItem.trimEnd()];
    currentItem = null;
};

const flushRelease = () => {
    flushItem();

    if (!currentRelease) {
        return;
    }

    const orderedGroups = releaseGroupOrder.reduce<
        Partial<Record<ReleaseGroup, string[]>>
    >((accumulator, group) => {
        const items = currentRelease?.groups[group];

        if (items?.length) {
            accumulator[group] = items;
        }

        return accumulator;
    }, {});

    releases.push({
        version: currentRelease.version,
        date: currentRelease.date,
        groups: orderedGroups
    });
    currentRelease = null;
    currentGroup = null;
};

for (const line of lines) {
    const releaseHeading = line.match(/^## (\d+\.\d+\.\d+)(?: - (.+))?$/);

    if (releaseHeading) {
        flushRelease();

        const version = releaseHeading[1];
        const date = releaseHeading[2];

        if (!version || !date) {
            throw new Error(
                `Missing release date for version ${version} in CHANGELOG.md`
            );
        }

        currentRelease = {
            version,
            date,
            groups: {}
        };
        continue;
    }

    if (!currentRelease) {
        continue;
    }

    const taggedItem = line.match(
        /^- \[(added|updated|fixed|removed|notes)\] (.+)$/
    );

    if (taggedItem) {
        flushItem();
        currentGroup = taggedItem[1] as ReleaseGroup;
        currentItem = taggedItem[2] ?? null;
        continue;
    }

    if (line.startsWith('## ')) {
        flushRelease();
        continue;
    }

    if (line.startsWith('### ')) {
        continue;
    }

    if (currentItem !== null) {
        currentItem = `${currentItem}\n${line.replace(/^  /, '')}`;
    }
}

flushRelease();

fs.writeFileSync(
    'releases.generated.json',
    `${JSON.stringify(releases, null, 4)}\n`
);
