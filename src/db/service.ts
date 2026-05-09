import { Context, Effect, Layer } from 'effect';

import { createDb, type AppDb } from './client';
import { createRepositories } from './repositories';
import type { WorkerBindings } from '../worker/env';

export interface DatabaseServiceShape {
    readonly db: AppDb;
    readonly repositories: ReturnType<typeof createRepositories>;
}

export const DatabaseService =
    Context.Service<DatabaseServiceShape>('DatabaseService');

export const makeDatabaseService = (
    env: WorkerBindings
): DatabaseServiceShape => {
    const db = createDb(env);

    return {
        db,
        repositories: createRepositories(db)
    };
};

export const makeDatabaseLayer = (env: WorkerBindings) => {
    return Layer.succeed(DatabaseService, makeDatabaseService(env));
};

export const withDatabase = <A>(
    evaluate: (service: DatabaseServiceShape) => Promise<A>
) => {
    return DatabaseService.use(service => {
        return Effect.tryPromise({
            try: () => evaluate(service),
            catch: cause => {
                return new Error(`Database service failure: ${String(cause)}`);
            }
        });
    });
};
