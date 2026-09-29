import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

import { resolvePreviewD1DatabaseId } from './scripts/db/production-d1-target';

const previewDatabaseId = resolvePreviewD1DatabaseId(
    path.resolve(process.cwd(), 'wrangler.jsonc'),
    process.env.CLOUDFLARE_PREVIEW_DATABASE_ID
);

export default defineConfig({
    out: './drizzle',
    schema: './src/db/schemas/index.ts',
    dialect: 'sqlite',
    driver: 'd1-http',
    dbCredentials: {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
        databaseId: previewDatabaseId,
        token: process.env.CLOUDFLARE_D1_TOKEN ?? ''
    }
});
