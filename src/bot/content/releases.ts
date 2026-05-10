import changelog from '../../../changelog.json';

import { messages } from './messages';

type ReleaseGroup = keyof typeof messages.releases.labels;

type ReleaseRecord = {
    date: string;
    list: Partial<Record<ReleaseGroup, string[]>>;
};

const releaseEntries = changelog as Record<string, ReleaseRecord>;

export const getReleases = () => {
    return releaseEntries;
};

export const getLatestReleaseVersion = () => {
    return Object.keys(releaseEntries)[0] ?? '0.0.0';
};

export const renderReleaseNotes = (spliceIndex = 0) => {
    const releases = getReleases();
    const versions = Object.keys(releases);
    const unreleasedChanges =
        spliceIndex <= 0 ? versions : versions.slice(0, spliceIndex);
    const { labels, order } = messages.releases;

    return unreleasedChanges
        .map(release => {
            const releaseEntry = releases[release];

            if (!releaseEntry) {
                return '';
            }

            let result = `🎉 <strong>${release} - ${releaseEntry.date}</strong>\n`;

            for (const group of order) {
                const features = releaseEntry.list[group];

                if (!features) {
                    continue;
                }

                result += `\n<strong>${labels[group]}</strong>\n\n`;

                for (const feature of features) {
                    result += `${features.length > 1 ? '- ' : ''}${feature}\n`;
                }
            }

            return result;
        })
        .filter(Boolean)
        .join('\n');
};
