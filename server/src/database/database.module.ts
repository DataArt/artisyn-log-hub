import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';
import { DRIZZLE, PG_POOL } from './database.constants';
import { logSqlQuery } from '../common/sql-logger';
import { resolveSearchPathOption } from './test-schema';

export type DrizzleDb = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          max: Number(process.env.DB_POOL_MAX) || 20,
          idleTimeoutMillis: 30_000,
          options: resolveSearchPathOption(),
        });
        // pg emits 'error' on the pool when an idle client's connection drops;
        // an EventEmitter with no 'error' listener treats that as fatal and
        // crashes the whole process (uncaughtException in main.ts).
        pool.on('error', (err) => {
          new Logger('PgPool').error(
            'Idle client connection error (pool recovers automatically)',
            err.stack,
          );
        });
        const originalQuery = pool.query.bind(pool) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        (
          pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }
        ).query = (...args: unknown[]) => {
          const start = Date.now();
          const firstArg = args[0];
          const sql =
            typeof firstArg === 'string'
              ? firstArg
              : ((firstArg as { text?: string })?.text ?? '<unknown>');
          const promise = originalQuery(...args);
          return promise.then(
            (result) => {
              logSqlQuery(sql, Date.now() - start);
              return result;
            },
            (err: unknown) => {
              logSqlQuery(sql, Date.now() - start, err);
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              return Promise.reject(err);
            },
          );
        };
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
/**
 * Owns the app's connection pool only. Schema setup is NOT done here — it runs
 * in `initializeDatabase()` (src/database/database-init.ts), before the NestJS
 * context is created at all, so every provider in the app starts against a
 * database that is already fully migrated.
 */
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
