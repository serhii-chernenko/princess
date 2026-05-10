import fs from 'node:fs';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const dotenvPath = process.env.DOTENV_CONFIG_PATH ?? '.dev.vars.production';

if (fs.existsSync(dotenvPath)) {
    config({
        path: dotenvPath,
        override: false
    });
}

export default defineConfig({
    out: './drizzle',
    schema: './src/db/schemas/index.ts',
    dialect: 'sqlite',
    driver: 'd1-http',
    dbCredentials: {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
        databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
        token: process.env.CLOUDFLARE_D1_TOKEN ?? ''
    }
});
