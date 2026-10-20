import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';

/** `model_pricing_meta.model_id` is `varchar(255)`; longer ids are dropped, never inserted. */
const MAX_MODEL_ID_LENGTH = 255;

/**
 * Registers model ids seen at ingest that have no effective price as unpriced, so the
 * admin sees them in the Model Pricing tab instead of their cost silently reading as $0.
 *
 * Ids are normalized like cost lookups do (trimmed, trailing `-YYYYMMDD` date stripped);
 * `''`, `'<synthetic>'`, over-long ids and duplicates are dropped. One statement inserts a
 * `model_pricing_meta (model_id, first_seen_at = now())` row for each id without an effective
 * `model_pricing` row, `ON CONFLICT DO NOTHING`. No advisory lock: it never touches prices.
 *
 * Runs on the caller's handle (so it joins the ingest transaction) and does not swallow errors.
 * A no-op for an empty list. Has no Nest dependencies — called from the logs module's helpers.
 */
export async function registerUnpricedModels(
  db: DrizzleDb,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  const normalized = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim().replace(/-\d{8}$/, '');
    if (id === '' || id === '<synthetic>' || id.length > MAX_MODEL_ID_LENGTH)
      continue;
    normalized.add(id);
  }
  if (normalized.size === 0) return;

  const values = sql.join(
    [...normalized].map((id) => sql`(${id}::varchar)`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO model_pricing_meta (model_id, first_seen_at)
    SELECT v.model_id, now()
      FROM (VALUES ${values}) AS v(model_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM model_pricing mp
        WHERE mp.model_id = v.model_id
          AND mp.effective_from <= CURRENT_DATE
     )
    ON CONFLICT (model_id) DO NOTHING
  `);
}
