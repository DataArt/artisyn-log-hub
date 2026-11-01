import type { LoggerService } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { backfillSessionListFlags } from '../../../src/database/backfill-session-list-flags';
import * as schema from '../../../src/database/schema/index';
import { recomputeSessionCosts } from '../../../src/logs/session-cost/session-cost-writer';

const silentLogger: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

/**
 * Fills `session_costs` for every world session, the way ingest would have: world-v1 is loaded
 * with raw SQL, which bypasses the ingest path that writes these rows, and the readers count a
 * missing row as unpriced. Runs on the caller's client so it lands in the same transaction as
 * the world load (global setup and every `resetWorld()`).
 *
 * The same raw load leaves the `session_stats` list-flag columns (`main_model`,
 * `has_main_assistant`, `has_workflow`, migration 0080) unset, and the startup backfill already
 * ran on the empty schema, so it is run again here — exactly as a server start would on rows
 * written before ingest filled them.
 *
 * This is setup, not an oracle: the registry still checks every cost against its own
 * hand-written SQL (`registry/oracle-sql.ts`), so the two cannot agree on the same mistake.
 */
export async function recomputeWorldSessionCosts(
  client: PoolClient,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT session_id AS id FROM session_stats ORDER BY session_id',
  );
  if (rows.length === 0) return;
  await recomputeSessionCosts(
    drizzle(client, { schema }),
    rows.map((r) => Number(r.id)),
  );
  await backfillSessionListFlags(client, silentLogger);
}
