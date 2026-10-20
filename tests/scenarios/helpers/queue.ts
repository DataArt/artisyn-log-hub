/**
 * queue.ts — waits until the stand's upload queue has processed everything a user sent
 * (impl-plan DD C12). `POST /api/v2/logs` only enqueues; scenarios call this before asserting on
 * sessions, stats or the UI.
 *
 * Polls `upload_queue` (server/src/database/schema/index.ts, `uploadQueue`) every 100 ms through
 * the `db` fixture's pool, whose search_path is the stand's schema.
 */
import type { Pool } from 'pg';

/** Statuses that mean "still being worked on". */
const BUSY_STATUSES = new Set(['pending', 'processing']);
/** Terminal statuses that fail the wait unless `allowFailed` is set. */
const FAILED_STATUSES = new Set(['failed', 'rejected_foreign_session']);

export interface WaitForQueueIdleOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Accept `failed` / `rejected_foreign_session` rows (scenarios that provoke them). */
  allowFailed?: boolean;
}

export type QueueStatusCounts = Record<string, number>;

/** `{ status: count }` of the user's upload_queue rows. */
export async function queueStatusCounts(db: Pool, userId: number): Promise<QueueStatusCounts> {
  const { rows } = await db.query<{ status: string; count: string }>(
    'SELECT status, count(*) AS count FROM upload_queue WHERE user_id = $1 GROUP BY status',
    [userId],
  );
  const counts: QueueStatusCounts = {};
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

async function failureDetails(db: Pool, userId: number): Promise<string> {
  const { rows } = await db.query<{ id: number; status: string; session_id: string; error_message: string | null }>(
    `SELECT id, status, session_id, error_message FROM upload_queue
      WHERE user_id = $1 AND status IN ('failed', 'rejected_foreign_session')
      ORDER BY id LIMIT 10`,
    [userId],
  );
  return rows
    .map((r) => `  #${r.id} ${r.status} session=${r.session_id}${r.error_message ? `: ${r.error_message}` : ''}`)
    .join('\n');
}

/**
 * Resolves with the final status counts once the user has no `pending`/`processing` rows.
 * Rejects as soon as a `failed`/`rejected_foreign_session` row appears (unless `allowFailed`),
 * or when `timeoutMs` passes.
 */
export async function waitForQueueIdle(
  db: Pool,
  userId: number,
  { timeoutMs = 15_000, pollIntervalMs = 100, allowFailed = false }: WaitForQueueIdleOptions = {},
): Promise<QueueStatusCounts> {
  const deadline = Date.now() + timeoutMs;
  let counts: QueueStatusCounts = {};
  for (;;) {
    counts = await queueStatusCounts(db, userId);
    const statuses = Object.keys(counts);
    if (!allowFailed && statuses.some((s) => FAILED_STATUSES.has(s))) {
      throw new Error(
        `upload_queue for user ${userId} has failed rows ${JSON.stringify(counts)}:\n${await failureDetails(db, userId)}`,
      );
    }
    if (!statuses.some((s) => BUSY_STATUSES.has(s))) return counts;
    if (Date.now() >= deadline) {
      throw new Error(`upload_queue for user ${userId} not idle after ${timeoutMs} ms: ${JSON.stringify(counts)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
