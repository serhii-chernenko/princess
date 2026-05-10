import fs from 'node:fs';
import path from 'node:path';

const changesetDir = '.changeset';
const allowedGroups = new Set([
    'added',
    'updated',
    'fixed',
    'removed',
    'notes'
]);

if (!fs.existsSync(changesetDir)) {
    process.exit(0);
}

const changesetFiles = fs
    .readdirSync(changesetDir)
    .filter(fileName => fileName.endsWith('.md') && fileName !== 'README.md');

for (const fileName of changesetFiles) {
    const absolutePath = path.join(changesetDir, fileName);
    const fileContent = fs.readFileSync(absolutePath, 'utf8');
    const parts = fileContent.split('---');

    if (parts.length < 3) {
        throw new Error(
            `${fileName} must contain frontmatter and a tagged Markdown body`
        );
    }

    const body = parts.slice(2).join('---').trim();

    if (!body) {
        throw new Error(`${fileName} must include at least one tagged bullet`);
    }

    const bodyLines = body.split('\n');
    let expectingContinuation = false;

    for (const line of bodyLines) {
        if (!line.trim()) {
            continue;
        }

        const bulletMatch = line.match(
            /^- \[(added|updated|fixed|removed|notes)\] .+$/
        );

        if (bulletMatch) {
            const group = bulletMatch[1];

            if (!group || !allowedGroups.has(group)) {
                throw new Error(
                    `${fileName} uses unsupported release group ${group}`
                );
            }

            expectingContinuation = true;
            continue;
        }

        if (expectingContinuation) {
            continue;
        }

        throw new Error(
            `${fileName} has an invalid line. Use '- [added|updated|fixed|removed|notes] ...' bullets.`
        );
    }
}
