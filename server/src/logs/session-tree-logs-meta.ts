import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { getDescendantSessionIds } from './session-tree.sql';

/** The log types a session tree's log rows carry (the `/logs` rule). */
export type TreeLogType = 'claude' | 'artisyn' | 'claude-subagent';

/**
 * One log row of a session tree, without its body (impl-plan DD-5 of
 * 2026-11-23-session-logs-streaming). Shared by the streamed legacy `/logs` and the parts
 * manifest, so both see the same rows in the same order.
 */
export interface TreeLogRowMeta {
  /** `logs.id`. */
  logId: number;
  /** `sessions.id` of the row's session. */
  sessionRowId: number;
  /** `sessions.session_id` (the root's id, or `agent-<id>` for a sub-agent). */
  sessionId: string;
  logType: TreeLogType;
  /** True for the root session's `claude` / `artisyn` rows. */
  isRoot: boolean;
  bodyIsNull: boolean;
  /** `logs.body_rev` as text (bigint); null for a legacy row the gzip builder has not reached. */
  bodyRev: string | null;
  /** `(extract(epoch from updated_at)*1e6)::bigint` as text. */
  updatedAtMicros: string;
  /** The stored gzip copy is valid (DD-9): `body_rev IS NOT NULL AND body_gz_rev = body_rev`. */
  gzReady: boolean;
  parentSessionId: string | null;
  agentDescription: string | null;
  workflowPhase: string | null;
  workflowRunId: string | null;
}

type DbScalar = string | number | null;

interface RawTreeLogRow {
  log_id: DbScalar;
  session_row_id: DbScalar;
  session_id: string;
  log_type: string;
  is_root: boolean;
  body_is_null: boolean;
  body_rev: DbScalar;
  updated_at_micros: DbScalar;
  gz_ready: boolean;
  parent_session_id: string | null;
  agent_description: string | null;
  workflow_phase: string | null;
  workflow_run_id: string | null;
}

function isTreeLogType(value: string): value is TreeLogType {
  return (
    value === 'claude' || value === 'artisyn' || value === 'claude-subagent'
  );
}

/**
 * Metadata of every log row of the tree rooted at `rootRowId` — never a body: the root's
 * `claude` and `artisyn` rows, then each descendant's `claude-subagent` row. Ordered root first
 * (claude, then artisyn), then by `sessions.session_id` (the order `/logs` lists sub-agents in).
 *
 * Descendants come from `getDescendantSessionIds`; a caller that already holds them passes them
 * as `descendantIds` to skip the second recursive walk.
 */
export async function readTreeLogsMeta(
  db: DrizzleDb,
  rootRowId: number,
  descendantIds?: readonly number[],
): Promise<TreeLogRowMeta[]> {
  const descendants =
    descendantIds ??
    (await getDescendantSessionIds(db, [rootRowId])).get(rootRowId) ??
    [];
  const descendantsLiteral = `{${descendants.join(',')}}`;
  const result = await db.execute(sql`
    SELECT l.id AS log_id,
           s.id AS session_row_id,
           s.session_id,
           l.log_type,
           (s.id = ${rootRowId}) AS is_root,
           (l.body IS NULL) AS body_is_null,
           l.body_rev::text AS body_rev,
           (extract(epoch from l.updated_at) * 1e6)::bigint::text AS updated_at_micros,
           (l.body_rev IS NOT NULL AND l.body_gz_rev = l.body_rev) AS gz_ready,
           s.parent_session_id,
           s.agent_description,
           s.workflow_phase,
           s.workflow_run_id
      FROM sessions s
      JOIN logs l ON l.session_id = s.id
     WHERE (s.id = ${rootRowId} AND l.log_type IN ('claude', 'artisyn'))
        OR (s.id = ANY(${descendantsLiteral}::int[])
            AND l.log_type = 'claude-subagent')
     ORDER BY (s.id = ${rootRowId}) DESC,
              CASE l.log_type WHEN 'claude' THEN 0 WHEN 'artisyn' THEN 1 ELSE 2 END,
              s.session_id,
              l.id
  `);
  const out: TreeLogRowMeta[] = [];
  for (const r of result.rows as unknown as RawTreeLogRow[]) {
    if (!isTreeLogType(r.log_type)) continue;
    out.push({
      logId: Number(r.log_id),
      sessionRowId: Number(r.session_row_id),
      sessionId: r.session_id,
      logType: r.log_type,
      isRoot: r.is_root === true,
      bodyIsNull: r.body_is_null === true,
      bodyRev: r.body_rev === null ? null : String(r.body_rev),
      updatedAtMicros: String(r.updated_at_micros ?? '0'),
      gzReady: r.gz_ready === true,
      parentSessionId: r.parent_session_id ?? null,
      agentDescription: r.agent_description ?? null,
      workflowPhase: r.workflow_phase ?? null,
      workflowRunId: r.workflow_run_id ?? null,
    });
  }
  return out;
}
