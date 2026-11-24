import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';

/** How many levels {@link isTombstoned} climbs upward at most (DD-27 of 2026-11-23-session-logs-streaming). */
export const TOMBSTONE_MAX_DEPTH = 64;

/**
 * Tombstone check (DD-27 of 2026-11-23-session-logs-streaming): true when `sessionId` or one of
 * its ancestors was deleted, so an upload for it must write nothing.
 *
 * Walks at most {@link TOMBSTONE_MAX_DEPTH} levels upward from `sessionId`. The next id is the
 * current row's `sessions.parent_session_id`; when the starting id has no `sessions` row yet
 * (a first sub-agent upload, or a session whose row was hard-purged), the given
 * `parentSessionId` is the next id instead. An id is a tombstone when its `sessions` row is
 * `deleted = true` or a `deleted_session_log` row carries it — the latter survives the
 * retention hard purge, which removes the `sessions` row itself.
 *
 * Pass the ingest transaction to make the answer authoritative: called after the tree's
 * ingest lock (`lockSessionTreeForIngest`), it cannot race a `deleteSession` of the same tree,
 * which takes that lock too.
 */
export async function isTombstoned(
  db: DrizzleDb,
  sessionId: string,
  parentSessionId?: string | null,
): Promise<boolean> {
  const parent = parentSessionId || null;
  const res = await db.execute(sql`
    WITH RECURSIVE walk AS (
      SELECT ${sessionId}::varchar AS cur, 0 AS depth
      UNION ALL
      SELECT
        CASE
          WHEN s.id IS NOT NULL THEN s.parent_session_id
          WHEN w.depth = 0 THEN ${parent}::varchar
          ELSE NULL
        END,
        w.depth + 1
      FROM walk w
      LEFT JOIN sessions s ON s.session_id = w.cur
      WHERE w.cur IS NOT NULL AND w.depth < ${TOMBSTONE_MAX_DEPTH}
    )
    SELECT EXISTS (
      SELECT 1 FROM walk w
      WHERE w.cur IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = w.cur AND s.deleted = true)
          OR EXISTS (SELECT 1 FROM deleted_session_log d WHERE d.session_id = w.cur)
        )
    ) AS hit
  `);
  const row = (res.rows as unknown as { hit: boolean }[])[0];
  return row?.hit === true;
}

/**
 * Fresh start (DD-29 of 2026-11-23-session-logs-streaming): removes the tombstones of a deleted
 * owner or repository, so the same session ids can be uploaded again later.
 *
 * 1. selects `session_pk` of the `deleted_session_log` rows with that `owner_user_id` or
 *    `repository_url`;
 * 2. hard-deletes the `sessions` rows among them that are `deleted` (their child data was
 *    purged at delete time; whatever still hangs off them cascades);
 * 3. deletes those `deleted_session_log` rows.
 *
 * Rows written before migration 0096 carry no `repository_url` and so are never cleared by a
 * repository deletion — accepted by the plan. Runs inside the caller's transaction.
 */
export async function clearSessionTombstones(
  tx: DrizzleDb,
  by: { ownerUserId: number } | { repositoryUrl: string },
): Promise<number> {
  const match =
    'ownerUserId' in by
      ? sql`owner_user_id = ${by.ownerUserId}`
      : sql`repository_url = ${by.repositoryUrl}`;
  const res = await tx.execute(sql`
    WITH tomb AS (
      SELECT id, session_pk FROM deleted_session_log WHERE ${match}
    ),
    gone_sessions AS (
      DELETE FROM sessions s
      USING tomb t
      WHERE s.id = t.session_pk AND s.deleted = true
      RETURNING s.id
    ),
    gone_log AS (
      DELETE FROM deleted_session_log d
      USING tomb t
      WHERE d.id = t.id
      RETURNING d.id
    )
    SELECT (SELECT count(*) FROM gone_log) AS cleared,
           (SELECT count(*) FROM gone_sessions) AS sessions_removed
  `);
  const row = (res.rows as unknown as { cleared: string | number }[])[0];
  return Number(row?.cleared ?? 0);
}

/**
 * Injectable face of {@link isTombstoned} for the ingest services (DD-27). Stateless: every
 * call takes the connection or transaction to read through.
 */
@Injectable()
export class SessionTombstoneService {
  isTombstoned(
    db: DrizzleDb,
    sessionId: string,
    parentSessionId?: string | null,
  ): Promise<boolean> {
    return isTombstoned(db, sessionId, parentSessionId);
  }
}
