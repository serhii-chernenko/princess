const messages = require('../i18n/messages');
const getVersions = require('./versions');

module.exports = (spliceIndex = 0, releasesToPost = []) => {
    const releases = getVersions();
    const { labels, order } = messages.releases;
    const unreleasedChanges =
        spliceIndex <= 0 ? releases : releases.slice(0, spliceIndex);

    for (const release of unreleasedChanges) {
        let result = `🎉 <strong>${release.version} - ${release.date}</strong>\n`;

        for (const group of order) {
            const features = release.groups[group];

            if (!features) {
                continue;
            }

            result += `\n<strong>${labels[group]}</strong>\n\n`;

            for (const feature of features) {
                result += `${features.length > 1 ? '- ' : ''}${feature}\n`;
            }
        }

        releasesToPost.push(result);
    }

    return releasesToPost.join('\n');
};
