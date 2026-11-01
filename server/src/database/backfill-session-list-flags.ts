import { LoggerService } from '@nestjs/common';
import { PoolClient } from 'pg';
import { SESSION_LIST_FLAGS_VERSION } from '../logs/session-list-flags';

const CONTEXT = 'DatabaseInit';

/**
 * Builds the set-based UPDATE that fills the session-list flag columns
 * (`main_model`, `has_main_assistant`, `has_workflow`, `list_flags_version`, migration 0080;
 * `claude_line_count`, 0081) for pending `session_stats` rows (`list_flags_version IS NULL` —
 * 0081 resets version-1 rows to NULL so they are recomputed with the version-2 column).
 *
 * `pendingFilter` narrows the pending set (per repository); empty = every pending row.
 * The `assistant_lines` / model aggregate is the session-list rule
 * (repositories.controller.ts, cost query) and the Workflow predicate mirrors
 * `extractWorkflows` — the same rules `computeSessionListFlags` applies at ingest.
 */
function buildBackfillSql(pendingFilter: string): string {
  return `
    WITH pending AS (
      SELECT ss.session_id
      FROM session_stats ss
      WHERE ss.list_flags_version IS NULL
        ${pendingFilter}
    ),
    assistant_lines AS (
      SELECT DISTINCT ON (cl.session_id, COALESCE(evt->'message'->>'id', evt->>'uuid'))
        cl.session_id AS session_row_id,
        ord,
        evt
      FROM logs cl
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(cl.body) = 'array' THEN cl.body ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS t(evt, ord)
      WHERE cl.log_type = 'claude'
        AND cl.session_id IN (SELECT session_id FROM pending)
        AND (evt->>'type') = 'assistant'
        AND (evt->>'isSidechain') IS DISTINCT FROM 'true'
      ORDER BY cl.session_id, COALESCE(evt->'message'->>'id', evt->>'uuid'), ord DESC
    ),
    main AS (
      SELECT
        session_row_id,
        (ARRAY_AGG(evt->'message'->>'model' ORDER BY ord) FILTER (
          WHERE (evt->'message'->>'model') IS NOT NULL
        ))[1] AS model
      FROM assistant_lines
      GROUP BY session_row_id
    ),
    wf AS (
      SELECT DISTINCT cl.session_id AS session_row_id
      FROM logs cl
      WHERE cl.log_type = 'claude'
        AND cl.session_id IN (SELECT session_id FROM pending)
        AND cl.body @> '[{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Workflow"}]}}]'::jsonb
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(cl.body) = 'array' THEN cl.body ELSE '[]'::jsonb END
               ) AS ev(e),
               jsonb_array_elements(
                 CASE WHEN jsonb_typeof(ev.e -> 'message' -> 'content') = 'array'
                      THEN ev.e -> 'message' -> 'content' ELSE '[]'::jsonb END
               ) AS blk(tu)
          WHERE ev.e ->> 'type' = 'assistant'
            AND blk.tu ->> 'type' = 'tool_use'
            AND blk.tu ->> 'name' = 'Workflow'
            AND jsonb_typeof(blk.tu -> 'id') = 'string'
            AND blk.tu ->> 'id' <> ''
        )
    ),
    line_counts AS (
      -- Version 2: the claude log's line count, as the analytics timeline counted it.
      SELECT cl.session_id AS session_row_id, jsonb_array_length(cl.body) AS line_count
      FROM logs cl
      WHERE cl.log_type = 'claude'
        AND cl.session_id IN (SELECT session_id FROM pending)
        AND jsonb_typeof(cl.body) = 'array'
    )
    UPDATE session_stats ss
    SET main_model = m.model,
        has_main_assistant = (m.session_row_id IS NOT NULL),
        has_workflow = (w.session_row_id IS NOT NULL),
        claude_line_count = lc.line_count,
        list_flags_version = ${SESSION_LIST_FLAGS_VERSION}
    FROM pending p
    LEFT JOIN main m ON m.session_row_id = p.session_id
    LEFT JOIN wf w ON w.session_row_id = p.session_id
    LEFT JOIN line_counts lc ON lc.session_row_id = p.session_id
    WHERE ss.session_id = p.session_id
  `;
}

const PER_REPO_SQL = buildBackfillSql(`
        AND ss.session_id IN (
          SELECT l.session_id
          FROM logs l
          JOIN log_repositories lr ON lr.log_id = l.id
          WHERE lr.repo_id = $1
        )`);

const CATCH_ALL_SQL = buildBackfillSql('');

/**
 * Startup step 3d (DD "Backfill batching"): computes the session-list flag columns for
 * every `session_stats` row written before migration 0080. One autocommitted UPDATE per
 * repository (so an interrupted run resumes where it stopped), then one catch-all UPDATE
 * for the rest (sub-agent rows, sessions linked to no repository). The partial index
 * `idx_session_stats_list_flags_pending` makes the "anything pending?" probe free on
 * every later start. Runs under the migration advisory lock on its client.
 */
export async function backfillSessionListFlags(
  client: PoolClient,
  logger: LoggerService,
): Promise<void> {
  const probe = await client.query(
    'SELECT 1 FROM session_stats WHERE list_flags_version IS NULL LIMIT 1',
  );
  if (probe.rowCount === 0) return;

  const started = Date.now();
  let updated = 0;
  const repos = await client.query<{ repo_id: string | number }>(
    'SELECT DISTINCT repo_id FROM log_repositories ORDER BY repo_id',
  );
  for (const row of repos.rows) {
    const res = await client.query(PER_REPO_SQL, [row.repo_id]);
    updated += res.rowCount ?? 0;
  }
  const rest = await client.query(CATCH_ALL_SQL);
  updated += rest.rowCount ?? 0;

  logger.log(
    `Session list flags: backfilled ${updated} session_stats row(s) in ${Date.now() - started}ms (v${SESSION_LIST_FLAGS_VERSION})`,
    CONTEXT,
  );
}
