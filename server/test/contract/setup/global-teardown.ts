import { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import { Pool } from 'pg';

/**
 * Teardown of the contract suite: closes the shared app, removes the temp
 * directories and drops this run's `contract_<uuid>` schema — even when the run failed.
 */
export default async function globalTeardown(): Promise<void> {
  const app = (global as unknown as { __CONTRACT_APP__?: INestApplication })
    .__CONTRACT_APP__;
  if (app) {
    await app.close();
  }

  const tmpRoot = process.env.CONTRACT_TMP_DIR;
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const schemaName = (global as unknown as { __CONTRACT_DB_SCHEMA__?: string })
    .__CONTRACT_DB_SCHEMA__;
  if (schemaName) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
}
