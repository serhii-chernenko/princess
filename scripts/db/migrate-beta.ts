import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runRemoteMigration } from './migrate-production';

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    try {
        runRemoteMigration('beta');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
