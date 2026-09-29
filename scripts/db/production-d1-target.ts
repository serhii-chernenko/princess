import fs from 'node:fs';
import path from 'node:path';

const d1DatabaseIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zeroDatabaseId = '00000000-0000-0000-0000-000000000000';
const productionDatabaseName = 'princess-production';

const readRecord = (value: unknown, location: string) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${location} must be an object`);
    }

    return value as Record<string, unknown>;
};

export const validateProductionD1DatabaseId = (
    value: unknown,
    location: string
) => {
    if (
        typeof value !== 'string' ||
        value.startsWith('REPLACE_WITH_') ||
        !d1DatabaseIdPattern.test(value) ||
        value === zeroDatabaseId
    ) {
        throw new Error(
            `${location} must be a real lowercase Cloudflare D1 database UUID`
        );
    }

    return value;
};

const readDatabaseBinding = (
    environments: Record<string, unknown>,
    environmentName: 'production' | 'beta'
) => {
    const environment = readRecord(
        environments[environmentName],
        `Wrangler ${environmentName} environment`
    );
    const databases = environment.d1_databases;

    if (!Array.isArray(databases)) {
        throw new Error(
            `Wrangler ${environmentName} environment d1_databases must be an array`
        );
    }

    const databaseBindings = databases.filter(database => {
        return (
            typeof database === 'object' &&
            database !== null &&
            !Array.isArray(database) &&
            'binding' in database &&
            database.binding === 'DB'
        );
    });

    if (databaseBindings.length !== 1) {
        throw new Error(
            `Wrangler ${environmentName} environment must define exactly one DB binding`
        );
    }

    const databaseBinding = readRecord(
        databaseBindings[0],
        `Wrangler ${environmentName} DB binding`
    );
    const databaseId = validateProductionD1DatabaseId(
        databaseBinding.database_id,
        `Wrangler ${environmentName} DB database_id`
    );

    if (databaseBinding.database_name !== productionDatabaseName) {
        throw new Error(
            `Wrangler ${environmentName} DB database_name must be ${productionDatabaseName}`
        );
    }

    return {
        databaseId,
        databaseName: productionDatabaseName
    };
};

export const parseProductionD1Target = (configSource: string) => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(configSource) as unknown;
    } catch (error) {
        throw new Error(
            `wrangler.jsonc must remain strict JSON for production D1 target validation: ${String(error)}`
        );
    }

    const config = readRecord(parsed, 'Wrangler config');
    const environments = readRecord(config.env, 'Wrangler config env');
    const productionTarget = readDatabaseBinding(environments, 'production');
    const betaTarget = readDatabaseBinding(environments, 'beta');

    if (
        betaTarget.databaseId !== productionTarget.databaseId ||
        betaTarget.databaseName !== productionTarget.databaseName
    ) {
        throw new Error(
            'Wrangler beta DB binding must match the shared production DB binding'
        );
    }

    return productionTarget;
};

export const parseProductionD1DatabaseId = (configSource: string) => {
    return parseProductionD1Target(configSource).databaseId;
};

export const resolveProductionD1DatabaseId = (
    configPath: string,
    environmentDatabaseId?: string
) => {
    const resolvedConfigPath = path.resolve(configPath);
    const configDatabaseId = parseProductionD1DatabaseId(
        fs.readFileSync(resolvedConfigPath, 'utf8')
    );

    if (environmentDatabaseId === undefined) {
        throw new Error(
            'CLOUDFLARE_DATABASE_ID confirmation is required for destructive production D1 operations'
        );
    }

    const validatedEnvironmentDatabaseId = validateProductionD1DatabaseId(
        environmentDatabaseId,
        'CLOUDFLARE_DATABASE_ID'
    );

    if (validatedEnvironmentDatabaseId !== configDatabaseId) {
        throw new Error(
            'CLOUDFLARE_DATABASE_ID does not match the production DB binding in wrangler.jsonc'
        );
    }

    return configDatabaseId;
};
