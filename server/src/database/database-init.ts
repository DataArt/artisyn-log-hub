import { LoggerService } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { AppLogger } from '../common/app-logger';
import { isProduction } from '../common/runtime-env';
import { TOOL_USAGE_EXTRACTOR_VERSION } from '../logs/tool-monitoring/tool-usage.constants';
import { OTEL_PROJECTION_VERSION } from '../logs/otel/otel-facts.constants';
import {
  loadAppliedMigrations,
  verifyAppliedMigrations,
  verifyMigrationFilesAgainstLock,
} from './migration-lock-check';
import { validateMigrationFiles } from './migration-validator';
import { resolveSessionSecret } from './server-secrets';
import { resolveSearchPathOption } from './test-schema';

/** Process-wide advisory lock, so concurrent cluster workers migrate one at a time. */
const MIGRATION_LOCK_KEY = 4242_4242;

const CONTEXT = 'DatabaseInit';

/** Printed (and thrown) when `migrate --reset` is attempted in production. */
export const RESET_REFUSED_IN_PRODUCTION_MESSAGE =
  'Refusing to reset the database in production (NODE_ENV=production)';

export interface DatabaseInitOptions {
  /** Drop and recreate the `public` schema first (`npm run migrate:reset`). */
  reset?: boolean;
  /** Defaults to a fresh `AppLogger`; pass the app's own so output interleaves. */
  logger?: LoggerService;
}

/**
 * Locates the migrations folder. In the ncc bundle `__dirname` is `dist/`, so
 * migrations sit at `dist/drizzle/migrations`; in dev `__dirname` is
 * `server/src/database/`, so they sit at `../../drizzle/migrations`.
 */
function resolveMigrationsFolder(): string {
  const bundlePath = join(__dirname, 'drizzle/migrations');
  const devPath = join(__dirname, '../../drizzle/migrations');
  const migrationsFolder = existsSync(bundlePath) ? bundlePath : devPath;

  if (!existsSync(migrationsFolder)) {
    throw new Error(
      `Migrations folder not found at: ${migrationsFolder}. Server cannot start without migrations.`,
    );
  }
  return migrationsFolder;
}

/**
 * Brings the database to a usable state, start to finish, in one call.
 *
 * This runs BEFORE the NestJS context exists — `main.ts` awaits it ahead of
 * `NestFactory.create()`, and the contract suite's global setup awaits it
 * ahead of compiling its test module. That ordering is the whole point:
 * every provider, scheduler and background timer in the app is constructed
 * against a database whose schema is already final, so none of them can
 * observe a half-migrated database. Doing this inside a lifecycle hook
 * instead (the previous design) left the app's own `setInterval`-driven
 * schedulers free to fire mid-migration and query tables that did not exist
 * yet.
 *
 * It owns a short-lived pool of its own rather than the app's, so it does not
 * depend on the DI container being up. `npm run migrate` calls the exact same
 * function, so the CLI path and the startup path can never drift apart.
 */
export async function initializeDatabase(
  options: DatabaseInitOptions = {},
): Promise<void> {
  // Defence in depth for the destructive reset: the CLI (migrate.ts) already
  // exits before getting here, but any other caller is refused too — before a
  // pool is even created.
  if (options.reset && isProduction()) {
    throw new Error(RESET_REFUSED_IN_PRODUCTION_MESSAGE);
  }

  const logger = options.logger ?? new AppLogger();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: resolveSearchPathOption(),
  });

  try {
    // 1. Fail fast if the migration files themselves are missing or malformed,
    //    before touching the database at all.
    const migrationsFolder = resolveMigrationsFolder();
    validateMigrationFiles(migrationsFolder);
    // Committed migrations are immutable: each file must still match its row
    // in meta/migrations.lock.json (see src/database/migration-lock-check.ts).
    verifyMigrationFilesAgainstLock(migrationsFolder);

    // 2. Optional destructive reset (`npm run migrate:reset`).
    if (options.reset) {
      logger.log(
        'Resetting DB: dropping public schema and drizzle migration records...',
        CONTEXT,
      );
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
      await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC');
      try {
        await pool.query('DELETE FROM drizzle.__drizzle_migrations');
      } catch {
        // The drizzle schema may not exist yet on a brand-new database.
      }
      logger.log('Reset complete.', CONTEXT);
    }

    // 3. Run the migrations under an advisory lock, so that when several cluster
    //    workers start at once exactly one of them migrates and the rest wait.
    const client = await pool.connect();
    try {
      logger.log('Acquiring migration advisory lock...', CONTEXT);
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

      // Like Liquibase's checksum check, which drizzle lacks: every migration
      // already applied must be one we know, with a hash the manifest accepts.
      verifyAppliedMigrations(
        migrationsFolder,
        await loadAppliedMigrations(
          client,
          process.env.E2E_DB_SCHEMA ?? 'drizzle',
        ),
      );

      const started = Date.now();
      logger.log(`Running migrations from: ${migrationsFolder}`, CONTEXT);
      // migrationsSchema unset (undefined) outside the e2e run -> drizzle's
      // default 'drizzle' schema. Set, it scopes the "__drizzle_migrations"
      // tracking table into the same fresh per-run schema search_path already
      // points at, so that schema always starts with zero tracked migrations
      // and runs every one of them, instead of skipping them because a
      // differently-schemaed run already marked them applied.
      await migrate(drizzle(pool), {
        migrationsFolder,
        migrationsSchema: process.env.E2E_DB_SCHEMA,
      });
      logger.log(`Migrations done in ${Date.now() - started}ms`, CONTEXT);

      // 3b. Re-queue tool-usage rows built by an older extractor (DD-7): NULL marks the
      //     session as pending, and the background drain rebuilds it. A no-op until
      //     TOOL_USAGE_EXTRACTOR_VERSION is bumped. Still under the lock, so concurrently
      //     starting workers run it once each at most, harmlessly. The partial index
      //     idx_sessions_tool_usage_version (migration 0077) keeps it from scanning sessions.
      const requeued = await client.query(
        'UPDATE sessions SET tool_usage_version = NULL WHERE tool_usage_version < $1',
        [TOOL_USAGE_EXTRACTOR_VERSION],
      );
      if (requeued.rowCount) {
        logger.log(
          `Tool usage: ${requeued.rowCount} session(s) queued for rebuild (extractor v${TOOL_USAGE_EXTRACTOR_VERSION})`,
          CONTEXT,
        );
      }

      // 3c. Re-queue OTEL chunks projected by an older projection version, or whose
      //     projection failed (-1) (DD-16): NULL marks the logs_otel row as pending, and the
      //     projection drain projects it again. Every row is projected at most once per
      //     version, so after the drain this touches no rows. Still under the lock.
      const otelRequeued = await client.query(
        'UPDATE logs_otel SET otel_projection_version = NULL WHERE otel_projection_version < $1',
        [OTEL_PROJECTION_VERSION],
      );
      if (otelRequeued.rowCount) {
        logger.log(
          `OTEL facts: ${otelRequeued.rowCount} chunk(s) queued for projection (projection v${OTEL_PROJECTION_VERSION})`,
          CONTEXT,
        );
      }

      // 4. Resolve SESSION_SECRET (env -> stored row -> generated), still under
      //    the lock so concurrently starting workers agree on one value. Runs on
      //    this client's connection, after the migration that creates
      //    server_secrets. See src/database/server-secrets.ts.
      const secretSource = await resolveSessionSecret(drizzle(client));
      logger.log(`SESSION_SECRET source: ${secretSource}`, CONTEXT);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_LOCK_KEY,
        ]);
      } catch (err) {
        logger.warn(
          `Failed to release advisory lock (probably ok): ${
            err instanceof Error ? err.message : String(err)
          }`,
          CONTEXT,
        );
      }
      client.release();
    }
  } catch (err) {
    logger.error(
      `CRITICAL: database init failed - server cannot start: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err instanceof Error ? err.stack : undefined,
      CONTEXT,
    );
    throw err;
  } finally {
    // 5. Always hand the connections back — the app builds its own pool.
    await pool.end();
  }
}
