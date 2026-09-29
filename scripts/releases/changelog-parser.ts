export const releaseGroupOrder = [
    'added',
    'updated',
    'fixed',
    'removed',
    'notes'
] as const;

export type ReleaseGroup = (typeof releaseGroupOrder)[number];

export type ReleaseItem = {
    uk: string;
    en?: string;
};

export type ReleaseEntry = {
    version: string;
    date: string;
    groups: Partial<Record<ReleaseGroup, ReleaseItem[]>>;
};

type PendingItem = {
    uk: string;
    en: string | null;
    target: 'uk' | 'en';
};

const releaseHeadingPattern = /^## (\d+\.\d+\.\d+)(?: - (.+))?$/;
const taggedItemPattern =
    /^\s*-\s+(?:[0-9a-f]{7,40}:\s+(?:-\s+)?)?\[(added|updated|fixed|removed|notes)\] (.+)$/;
const englishLinePattern = /^\s*-\s+en: (.+)$/;

export const parseChangelog = (changelog: string) => {
    const releases: ReleaseEntry[] = [];
    let currentRelease: ReleaseEntry | null = null;
    let currentGroup: ReleaseGroup | null = null;
    let currentItem: PendingItem | null = null;

    const flushItem = () => {
        if (currentRelease && currentGroup && currentItem) {
            const item: ReleaseItem = { uk: currentItem.uk.trimEnd() };

            if (currentItem.en !== null) {
                item.en = currentItem.en.trimEnd();
            }

            const groups = currentRelease.groups;

            groups[currentGroup] = [...(groups[currentGroup] ?? []), item];
        }

        currentItem = null;
    };

    const flushRelease = () => {
        flushItem();

        if (!currentRelease) {
            return;
        }

        const release: ReleaseEntry = currentRelease;
        const orderedGroups = releaseGroupOrder.reduce<ReleaseEntry['groups']>(
            (accumulator, group) => {
                const items = release.groups[group];

                if (items?.length) {
                    accumulator[group] = items;
                }

                return accumulator;
            },
            {}
        );

        releases.push({
            version: release.version,
            date: release.date,
            groups: orderedGroups
        });
        currentRelease = null;
        currentGroup = null;
    };

    for (const line of changelog.split('\n')) {
        const releaseHeading = line.match(releaseHeadingPattern);

        if (releaseHeading) {
            flushRelease();

            const version = releaseHeading[1];
            const date = releaseHeading[2];

            if (!version || !date) {
                throw new Error(
                    `Missing release date for version ${version} in CHANGELOG.md`
                );
            }

            currentRelease = { version, date, groups: {} };
            continue;
        }

        if (!currentRelease) {
            continue;
        }

        const taggedItem = line.match(taggedItemPattern);

        if (taggedItem) {
            flushItem();
            currentGroup = taggedItem[1] as ReleaseGroup;
            currentItem = { uk: taggedItem[2] ?? '', en: null, target: 'uk' };
            continue;
        }

        if (line.startsWith('## ')) {
            flushRelease();
            continue;
        }

        if (line.startsWith('### ')) {
            continue;
        }

        if (currentItem === null) {
            continue;
        }

        const englishLine = line.match(englishLinePattern);

        if (englishLine && currentItem.en === null) {
            currentItem.en = englishLine[1] ?? '';
            currentItem.target = 'en';
            continue;
        }

        const continuation = line.replace(/^ {2}/, '');

        if (currentItem.target === 'en') {
            currentItem.en = `${currentItem.en}\n${line.replace(/^ {1,4}/, '')}`;
        } else {
            currentItem.uk = `${currentItem.uk}\n${continuation}`;
        }
    }

    flushRelease();

    return releases;
};
