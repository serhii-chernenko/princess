import { drizzle } from 'drizzle-orm/d1';

import { relations } from './relations';
import * as schema from './schema';
import type { WorkerBindings } from '../worker/env';

export const createDb = (env: WorkerBindings) => {
    return drizzle(env.DB, { schema, relations });
};

export type AppDb = ReturnType<typeof createDb>;
