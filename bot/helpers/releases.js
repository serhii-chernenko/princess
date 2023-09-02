const messages = require('../i18n/messages');
const getVersions = require('./versions');

module.exports = (spliceIndex = 0, releasesToPost = []) => {
    const releases = getVersions();
    const versions = Object.keys(releases);
    const unreleasedChanges =
        spliceIndex <= 0 ? versions : versions.splice(0, spliceIndex);
    const { labels, order } = messages.releases;

    for (const release of unreleasedChanges) {
        let result = `🎉 <strong>${release} - ${releases[release].date}</strong>\n`;

        for (const group of order) {
            const features = releases[release].list[group];

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
