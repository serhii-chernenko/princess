import fs from 'node:fs';
import path from 'node:path';

import { validateChangesetBody } from './changeset-validator';

const changesetDir = '.changeset';

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

    validateChangesetBody(fileName, parts.slice(2).join('---'));
}
