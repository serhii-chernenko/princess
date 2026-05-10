import releaseManifest from '../../../releases.generated.json';

import { getDefaultAppLocale, type AppLocale } from '../i18n';
import {
    getReleaseLabels,
    releaseGroupOrder,
    type ReleaseGroup
} from './messages';

type ReleaseRecord = {
    version: string;
    date: string;
    groups: Partial<Record<ReleaseGroup, string[]>>;
};

const releases = releaseManifest as ReleaseRecord[];

export const getReleases = () => {
    return releases;
};

export const getLatestReleaseVersion = () => {
    return releases[0]?.version ?? '0.0.0';
};

export const renderReleaseNotes = (
    spliceIndex = 0,
    locale: AppLocale = getDefaultAppLocale()
) => {
    const releaseEntries =
        spliceIndex <= 0 ? releases : releases.slice(0, spliceIndex);
    const labels = getReleaseLabels(locale);

    return releaseEntries
        .map(release => {
            let result = `🎉 <strong>${release.version} - ${release.date}</strong>\n`;

            for (const group of releaseGroupOrder) {
                const features = release.groups[group];

                if (!features?.length) {
                    continue;
                }

                result += `\n<strong>${labels[group]}</strong>\n\n`;

                for (const feature of features) {
                    result += `${features.length > 1 ? '- ' : ''}${feature}\n`;
                }
            }

            return result;
        })
        .join('\n');
};
