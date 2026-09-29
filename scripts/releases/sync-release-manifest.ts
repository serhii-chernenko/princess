import fs from 'node:fs';

import { parseChangelog } from './changelog-parser';

const releases = parseChangelog(fs.readFileSync('CHANGELOG.md', 'utf8'));

fs.writeFileSync(
    'releases.generated.json',
    `${JSON.stringify(releases, null, 4)}\n`
);
