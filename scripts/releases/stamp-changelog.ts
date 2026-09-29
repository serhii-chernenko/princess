import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
    version?: string;
};
const changelogPath = 'CHANGELOG.md';
const changelog = fs.readFileSync(changelogPath, 'utf8');
const version = packageJson.version;

if (!version) {
    throw new Error('package.json version is required');
}

const formatDate = (date: Date) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());

    return `${day}.${month}.${year}`;
};

const releaseDate = process.env.RELEASE_DATE || formatDate(new Date());
const headingPattern = new RegExp(`^## ${version}$`, 'm');

if (!headingPattern.test(changelog)) {
    process.exit(0);
}

const updatedChangelog = changelog.replace(
    headingPattern,
    `## ${version} - ${releaseDate}`
);

fs.writeFileSync(changelogPath, updatedChangelog);
