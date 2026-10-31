// Must stay the first import: it snapshots process.env before AppModule's module-level dotenv
// calls (server/.env, then server/.env.local with override) run — see env-snapshot.helper.ts.
import { envBeforeAppModule } from '../../helpers/env-snapshot.helper';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../../../src/app.module';
import { initializeDatabase } from '../../../src/database/database-init';
import { createTestApp } from '../../helpers/create-app.helper';
import { resetWorldV1 } from '../fixtures/world-v1.sql';
import { recomputeWorldSessionCosts } from './world-session-costs';

/**
 * Global setup of the API <-> DB contract suite (docs/qaa-overview/scenarios/05 §2.1,
 * §2.9). A copy of test/setup/global-setup.ts's logic with three differences:
 *
 *  - the schema is `contract_<uuid>` (stale `contract_%` schemas of killed runs are dropped);
 *  - instead of the baseline user, the deterministic world-v1 fixture is loaded with raw SQL
 *    BEFORE the app boots, so no scheduler ever sees a half-filled schema;
 *  - every on-disk directory the app writes (upload queue, export/import) is a throwaway
 *    temp dir, so the suite never shares files with the always-on dev server (05 §5 risk 2).
 *
 * The app object stays in this process (`global.__CONTRACT_APP__`, for global-teardown.ts); spec
 * files reach it over HTTP through `CONTRACT_BASE_URL`, which Jest copies into every worker.
 */

async function dropStaleContractSchemas(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'contract\\_%'`,
  );
  for (const { schema_name: schemaName } of rows) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  }
}

export default async function globalSetup(): Promise<void> {
  // A database URL handed in by the caller wins over whatever server/.env(.local) loaded during
  // the AppModule import. TEST_DATABASE_URL comes first (a dev container points tests at its test
  // DB with it while DATABASE_URL stays the live dev DB), then DATABASE_URL
  // (scripts/scenarios/run.mjs passes the one its preflight checked).
  const callerDatabaseUrl =
    envBeforeAppModule.TEST_DATABASE_URL || envBeforeAppModule.DATABASE_URL;
  if (callerDatabaseUrl) {
    process.env.DATABASE_URL = callerDatabaseUrl;
  }

  // The upload-queue worker is parked (one tick per hour, i.e. never within a run). A contract
  // row proves what ONE request writes: `POST /api/v2/logs` -> one `pending` row plus its staged
  // file, `reprocess-failed` -> `failed` rows back to `pending`. A 50 ms worker would race the
  // "after" snapshot and turn those rows into whatever processing produced. What the worker
  // writes is the ingest scenarios' job (tests/scenarios/ingest/*), not this suite's.
  process.env.UPLOAD_QUEUE_INTERVAL_MS = '3600000';
  // Same reason for the two cleanup sweeps that delete rows on their own: a sweep landing inside
  // a row's measured window would show up as a write the row did not make. The job TTL is pushed
  // out too, so even a sweep never reaps the world's fixed-date export/import jobs.
  process.env.EXPORT_IMPORT_CLEANUP_INTERVAL_MS = '3600000';
  process.env.EXPORT_IMPORT_JOB_TTL_MS = String(100 * 365 * 24 * 3600 * 1000);
  process.env.TURN_END_ADVISOR_ORPHAN_CLEANUP_INTERVAL_MS = '3600000';
  // The tool-usage rebuild drain (T-26 DD-7) is parked too: every world session is pending
  // (`tool_usage_version` NULL), so a 15 s tick would rewrite `session_tool_usage`, `sessions`
  // and `repositories.tool_wrap_status` mid-run. The F24 rows read the world's hand-written
  // `session_tool_usage` rows; what a rebuild produces is the algorithm tests' and scenarios' job.
  process.env.TOOL_USAGE_REBUILD_INTERVAL_MS = '3600000';
  // The OTEL projection drain (2026-10-30 otel-tabs-traces, DD-16) is parked for the same
  // reason: its tick drains `otel_reclass_queue` (filled by any transcript re-read) and
  // finalises idle roots, both writes no row made. The F25 rows read world-v1's hand-written
  // otel_* rows; what the drain produces is the scenarios' job.
  process.env.OTEL_PROJECTION_INTERVAL_MS = '3600000';
  process.env.UPLOAD_QUEUE_LEASE_TIMEOUT_MS = '150';
  process.env.UPLOAD_QUEUE_TICK_BUDGET_MS = '500';
  process.env.AI_TOOL_VERSION_CHECK_ENABLED = 'false';
  process.env.MODEL_PRICING_FETCH_ENABLED = 'false';
  process.env.LOGS_MAX_BODY_MB = '2';
  // Session costs: a pricing write awaits its own re-pricing (`notifySessionCostsStale`), so a
  // write row's "after" snapshot already holds the re-priced `session_costs` rows, and the
  // periodic sweeper is parked like the other background jobs.
  process.env.SESSION_COST_RECOMPUTE_INLINE = 'true';
  process.env.SESSION_COST_RECOMPUTE_INTERVAL_MS = '3600000';
  // Deliberately NOT lowered: the retention tick and the abandoned-partial-upload sweep. The
  // world's dates are fixed in January 2026, so a fast retention tick with the default 30-day
  // window would purge the whole world mid-run. The window is also pushed out to 100 years, so
  // even the production-interval tick (30 min) can never touch a world session.
  delete process.env.SESSION_RETENTION_CHECK_INTERVAL_MS;
  delete process.env.UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS;
  process.env.SESSION_RETENTION_DAYS = '36500';

  const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'artisyn-contract-'));
  process.env.CONTRACT_TMP_DIR = tmpRoot;
  for (const [name, dir] of [
    ['UPLOAD_QUEUE_DIR', 'upload-queue'],
    ['EXPORT_IMPORT_DIR', 'export-import'],
  ] as const) {
    const full = join(tmpRoot, dir);
    fs.mkdirSync(full, { recursive: true });
    process.env[name] = full;
  }

  // Mode 3 (`password-confirm`), the superset mode the contract registry is written against
  // (05 §2.1). Set after the AppModule import, whose `.env.local` override would undo it.
  process.env.AUTH_MODE = 'password-confirm';
  process.env.PASSWORD_POLICY = 'long';
  process.env.AUTH_RATE_LIMIT_POINTS = '1000';
  process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
  process.env.ADMIN_CONTACT_EMAIL ??= 'contract-admin@arrakis.test';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_FROM ??= 'contract@arrakis.test';

  const schemaName = `contract_${randomUUID().replace(/-/g, '')}`;
  const bootstrapPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  try {
    await dropStaleContractSchemas(bootstrapPool);
    await bootstrapPool.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await bootstrapPool.end();
  }
  // Read by DatabaseModule (search_path), runMigrations() (migrationsSchema) and the oracle.
  process.env.E2E_DB_SCHEMA = schemaName;
  (
    global as unknown as { __CONTRACT_DB_SCHEMA__?: string }
  ).__CONTRACT_DB_SCHEMA__ = schemaName;

  await initializeDatabase();

  const worldPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: `-c search_path=${schemaName}`,
  });
  const client = await worldPool.connect();
  try {
    await client.query('BEGIN');
    await resetWorldV1(client, schemaName);
    await recomputeWorldSessionCosts(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await worldPool.end();
  }

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication = await createTestApp(moduleFixture);
  const server: Server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  process.env.CONTRACT_BASE_URL = `http://127.0.0.1:${port}`;

  (
    global as unknown as { __CONTRACT_APP__?: INestApplication }
  ).__CONTRACT_APP__ = app;
}
