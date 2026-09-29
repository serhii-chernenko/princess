import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

import { resolveBetaD1DatabaseId } from './scripts/db/production-d1-target';

const betaDatabaseId = resolveBetaD1DatabaseId(
    path.resolve(process.cwd(), 'wrangler.jsonc'),
    process.env.CLOUDFLARE_BETA_DATABASE_ID
);

export default defineConfig({
    out: './drizzle',
    schema: './src/db/schemas/index.ts',
    dialect: 'sqlite',
    driver: 'd1-http',
    dbCredentials: {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
        databaseId: betaDatabaseId,
        token: process.env.CLOUDFLARE_D1_TOKEN ?? ''
    }
});
