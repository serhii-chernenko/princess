import fs from 'node:fs';
import path from 'node:path';

export type D1DatabaseTarget = 'production' | 'beta';

const d1DatabaseIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zeroDatabaseId = '00000000-0000-0000-0000-000000000000';

export const d1DatabaseNames: Record<D1DatabaseTarget, string> = {
    production: 'princess-production',
    beta: 'princess-beta'
};

export const d1DatabaseIdEnvironmentNames: Record<D1DatabaseTarget, string> = {
    production: 'CLOUDFLARE_DATABASE_ID',
    beta: 'CLOUDFLARE_BETA_DATABASE_ID'
};

const readRecord = (value: unknown, location: string) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${location} must be an object`);
    }

    return value as Record<string, unknown>;
};

export const validateD1DatabaseId = (value: unknown, location: string) => {
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

const readDatabaseBindingRecord = (
    environments: Record<string, unknown>,
    target: D1DatabaseTarget
) => {
    const environment = readRecord(
        environments[target],
        `Wrangler ${target} environment`
    );
    const databases = environment.d1_databases;

    if (!Array.isArray(databases)) {
        throw new Error(
            `Wrangler ${target} environment d1_databases must be an array`
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
            `Wrangler ${target} environment must define exactly one DB binding`
        );
    }

    return readRecord(databaseBindings[0], `Wrangler ${target} DB binding`);
};

const readDatabaseBinding = (
    environments: Record<string, unknown>,
    target: D1DatabaseTarget
) => {
    const databaseBinding = readDatabaseBindingRecord(environments, target);
    const databaseId = validateD1DatabaseId(
        databaseBinding.database_id,
        `Wrangler ${target} DB database_id`
    );

    if (databaseBinding.database_name !== d1DatabaseNames[target]) {
        throw new Error(
            `Wrangler ${target} DB database_name must be ${d1DatabaseNames[target]}`
        );
    }

    return {
        databaseId,
        databaseName: d1DatabaseNames[target]
    };
};

const parseWranglerEnvironments = (configSource: string) => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(configSource) as unknown;
    } catch (error) {
        throw new Error(
            `wrangler.jsonc must remain strict JSON for D1 target validation: ${String(error)}`
        );
    }

    const config = readRecord(parsed, 'Wrangler config');

    return readRecord(config.env, 'Wrangler config env');
};

export const parseD1Target = (
    configSource: string,
    target: D1DatabaseTarget
) => {
    const environments = parseWranglerEnvironments(configSource);
    const resolvedTarget = readDatabaseBinding(environments, target);

    if (target === 'beta') {
        const productionBinding = readDatabaseBindingRecord(
            environments,
            'production'
        );

        if (
            productionBinding.database_id === resolvedTarget.databaseId ||
            productionBinding.database_name === resolvedTarget.databaseName
        ) {
            throw new Error(
                'Wrangler beta DB binding must not share the production database'
            );
        }
    }

    return resolvedTarget;
};

export const parseD1DatabaseId = (
    configSource: string,
    target: D1DatabaseTarget
) => {
    return parseD1Target(configSource, target).databaseId;
};

export const resolveD1DatabaseId = (
    configPath: string,
    target: D1DatabaseTarget,
    environmentDatabaseId?: string
) => {
    const environmentName = d1DatabaseIdEnvironmentNames[target];
    const configDatabaseId = parseD1DatabaseId(
        fs.readFileSync(path.resolve(configPath), 'utf8'),
        target
    );

    if (environmentDatabaseId === undefined) {
        throw new Error(
            `${environmentName} confirmation is required for destructive ${target} D1 operations`
        );
    }

    const validatedEnvironmentDatabaseId = validateD1DatabaseId(
        environmentDatabaseId,
        environmentName
    );

    if (validatedEnvironmentDatabaseId !== configDatabaseId) {
        throw new Error(
            `${environmentName} does not match the ${target} DB binding in wrangler.jsonc`
        );
    }

    return configDatabaseId;
};

export const resolveProductionD1DatabaseId = (
    configPath: string,
    environmentDatabaseId?: string
) => {
    return resolveD1DatabaseId(configPath, 'production', environmentDatabaseId);
};

export const resolveBetaD1DatabaseId = (
    configPath: string,
    environmentDatabaseId?: string
) => {
    return resolveD1DatabaseId(configPath, 'beta', environmentDatabaseId);
};
