import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';

/**
 * The tree's edit revision (DD-21 of 2026-11-23-session-logs-streaming): `edit_records_sha256`
 * of the nearest ancestor-or-self of `sessionRowId` that has an `artisyn` log — the same upward
 * walk as `loadSessionTreeEditRecords` (`change-surface/changed-paths.sql.ts`). `''` when no
 * such log exists or its value is NULL. A transcript's `stats_edit_sha256` is this value, read
 * before its body is written; the hash skip compares the two.
 *
 * Lives in its own file (re-exported from `logs.service.ts`) so `SessionReextractService` can
 * use it without importing `logs.service.ts`, which injects that service.
 */
export async function readTreeEditSha(
  tx: DrizzleDb,
  sessionRowId: number,
): Promise<string> {
  const result = await tx.execute<{ sha: string | null }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, session_id, parent_session_id, 0 AS depth
      FROM sessions
      WHERE id = ${sessionRowId}
      UNION ALL
      SELECT p.id, p.session_id, p.parent_session_id, a.depth + 1
      FROM sessions p
      JOIN ancestors a ON a.parent_session_id = p.session_id
      WHERE a.depth < 50
    )
    SELECT l.edit_records_sha256 AS sha
    FROM ancestors a
    JOIN logs l ON l.session_id = a.id AND l.log_type = 'artisyn'
    ORDER BY a.depth
    LIMIT 1
  `);
  return result.rows[0]?.sha ?? '';
}
