// F18 — session deletion and the retention view (docs/qaa-overview/scenarios/05 §F18).
//
// Deleting a session soft-deletes the `sessions` row (and its children), drops every per-session
// row and the session's logs, removes the root's session tags, and writes one audit row.
import { WORLD_V1 } from '../fixtures/world-v1.sql';
import type { ContractFamily, WriteSpec } from '../types';

/** The projected OTEL tables `purgeSessionChildData` empties for the deleted root. */
const OTEL_TABLES = [
  'otel_session_state',
  'otel_calls',
  'otel_spans',
  'otel_cost_buckets',
  'otel_reclass_queue',
];

/**
 * The tables that used to outlive a soft delete and are purged since 2026-11-23
 * session-logs-streaming (DD-28), keyed by `sessions.id`.
 */
const SURVIVOR_TABLES = [
  'logs_otel',
  'otel_api_calls',
  'session_request_ids',
  'session_tool_stats',
  'session_harness_usage',
  'session_changed_paths',
  'session_cause_stats',
  'session_attribution',
  'session_attribution_runs',
  'session_prompt_watermark',
];

/** Every table a session deletion may touch. */
const SESSION_TABLES = [
  'sessions',
  'logs',
  'log_repositories',
  'session_tags',
  'session_stats',
  'session_costs',
  'session_file_stats',
  ...SURVIVOR_TABLES,
  // DD-28: keyed by the `session_id` string (no foreign key), purged with the survivors.
  'turn_end_advisor_runs',
  'user_favorite_sessions',
  'deleted_session_log',
  // DD-11 steps g/h: every purge unconditionally nulls the deleted session's
  // harness_snapshot_id and sweeps harness_snapshots rows no session references any more.
  'harness_snapshots',
  // T-26: the purge deletes the session's Tools/MCP rows.
  'session_tool_usage',
  // 2026-10-30 OTEL tabs (DD-25): the purge deletes the root's projected OTEL rows.
  ...OTEL_TABLES,
];

function deleteSession(
  pk: string,
  sessionId: string,
  actor: string,
  /** `repositories.repo_url` of the session's repository (DD-29). */
  repositoryUrl: string,
  /** `@ref` of the snapshot id this session was bound to, if the sweep should delete its row. */
  boundSnapshotRef?: string,
): WriteSpec {
  return {
    watch: SESSION_TABLES,
    delta: {
      updated: [
        {
          table: 'sessions',
          where: `id = ${pk}`,
          changed: { deleted: true, harness_snapshot_id: null },
        },
      ],
      deleted: [
        { table: 'logs', where: `session_id = ${pk}`, count: 'all' },
        ...(boundSnapshotRef
          ? [
              {
                table: 'harness_snapshots',
                where: `snapshot_id = ${boundSnapshotRef}`,
              },
            ]
          : []),
        {
          table: 'log_repositories',
          where: `log_id IN (SELECT id FROM logs WHERE session_id = ${pk})`,
          count: 'all',
        },
        // 2026-11-24 otel-session-tags: the root's tags go with it — soft delete keeps the
        // sessions row, so the FK cascade does not cover them.
        { table: 'session_tags', where: `session_id = ${pk}`, count: 'all' },
        { table: 'session_stats', where: `session_id = ${pk}`, count: 'all' },
        { table: 'session_costs', where: `session_id = ${pk}`, count: 'all' },
        {
          table: 'session_file_stats',
          where: `session_id = ${pk}`,
          count: 'all',
        },
        {
          table: 'user_favorite_sessions',
          where: `session_id = ${pk}`,
          count: 'all',
        },
        {
          table: 'session_tool_usage',
          where: `session_id = ${pk}`,
          count: 'all',
        },
        ...OTEL_TABLES.map((table) => ({
          table,
          where: `session_id = ${pk}`,
          count: 'all' as const,
        })),
        // DD-28 (2026-11-23 session-logs-streaming): the former survivors are emptied too —
        // what 05 §F18 always expected.
        ...SURVIVOR_TABLES.map((table) => ({
          table,
          where: `session_id = ${pk}`,
          count: 'all' as const,
        })),
        {
          table: 'turn_end_advisor_runs',
          where: `session_id = '${sessionId}'`,
          count: 'all',
        },
      ],
      inserted: [
        {
          table: 'deleted_session_log',
          where: `session_id = '${sessionId}'`,
          check: [
            `session_pk = ${pk}`,
            `deleted_by_user_id = ${actor}`,
            `owner_user_id = ${actor}`,
            `repository_url = '${repositoryUrl}'`,
          ],
        },
      ],
    },
    keys: { session_file_stats: ['session_id', 'category_name'] },
    // No survivor row of the session is left behind (DD-28), whatever the world seeds.
    after: [
      ...SURVIVOR_TABLES.map(
        (table) =>
          `NOT EXISTS (SELECT 1 FROM ${table} WHERE session_id = ${pk})`,
      ),
      `NOT EXISTS (SELECT 1 FROM turn_end_advisor_runs WHERE session_id = '${sessionId}')`,
    ],
  };
}

export const f18SessionDeleteRetention: ContractFamily = {
  id: 'F18',
  name: 'session-delete-retention',
  cases: [
    {
      // s01 seeds a row in most former survivor tables (request ids, tool stats, changed
      // paths, harness usage, attribution + runs, prompt watermark): after the delete none of
      // them holds a row of the session (DD-28, `after` in deleteSession).
      id: 'F18-delete',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'owner',
      params: { sessionId: '@s01.sessionId' },
      expect: { status: 204 },
      write: deleteSession(
        '@s01.id',
        'w1-s01-plain',
        '@owner.id',
        WORLD_V1.repos.R1.url,
      ),
    },
    {
      // s04 is bound to a harness snapshot: deleting it also sweeps that snapshot row.
      id: 'F18-delete-bound-snapshot',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'owner',
      params: { sessionId: '@s04.sessionId' },
      expect: { status: 204 },
      write: deleteSession(
        '@s04.id',
        'w1-s04-favorite',
        '@owner.id',
        WORLD_V1.repos.R1.url,
        '@harnessSnapshotId',
      ),
    },
    {
      // Deleting a session is owner-only: the admin role grants no override.
      id: 'F18-delete-by-admin',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'admin',
      params: { sessionId: '@s04.sessionId' },
      expect: { status: 403 },
    },
    {
      id: 'F18-delete-not-owner',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'member',
      params: { sessionId: '@s01.sessionId' },
      expect: { status: 403 },
    },
    {
      id: 'F18-delete-unknown',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'owner',
      params: { sessionId: 'w1-no-such-session' },
      expect: { status: 404 },
    },
    {
      // Totals over sessions that still have logs, dated by their last log end (UTC days).
      id: 'F18-retention',
      route: 'GET /api/v1/admin/retention',
      actor: 'admin',
      expect: { status: 200 },
      read: {
        sql: `WITH per AS (SELECT l.session_id, max(l.end_time) AS last_end
                             FROM logs l JOIN sessions s ON s.id = l.session_id AND NOT s.deleted
                            GROUP BY l.session_id)
              SELECT 36500 AS retention_days, min(last_end) AS oldest, max(last_end) AS youngest,
                     count(*) AS total,
                     -- 2026-10-30 OTEL tabs (DD-25): realtime-only roots (OTEL data, no logs).
                     (SELECT count(*) FROM sessions s
                       WHERE NOT s.deleted AND s.parent_session_id IS NULL
                         AND EXISTS (SELECT 1 FROM otel_session_state st WHERE st.session_id = s.id)
                         AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.session_id = s.id)) AS otel_only
                FROM per`,
        shape: 'object',
        fields: {
          retentionDays: 'retention_days',
          oldestSessionAt: { col: 'oldest', as: 'iso?' },
          youngestSessionAt: { col: 'youngest', as: 'iso?' },
          totalSessionCount: { col: 'total', as: 'number' },
          otelOnlySessions: { col: 'otel_only', as: 'number' },
        },
        ignore: ['dailySeries'],
        strict: true,
      },
    },
    {
      id: 'F18-retention-daily',
      route: 'GET /api/v1/admin/retention',
      actor: 'admin',
      expect: { status: 200, minRows: 5 },
      read: {
        sql: `WITH per AS (SELECT l.session_id, max(l.end_time) AS last_end,
                                  sum(pg_column_size(l.body)) AS bytes
                             FROM logs l JOIN sessions s ON s.id = l.session_id AND NOT s.deleted
                            GROUP BY l.session_id),
                   days AS (SELECT generate_series(date_trunc('day', min(last_end) AT TIME ZONE 'UTC'),
                                                   date_trunc('day', max(last_end) AT TIME ZONE 'UTC'),
                                                   interval '1 day') AS day
                              FROM per)
              SELECT d.day AT TIME ZONE 'UTC' AS day,
                     (SELECT count(*) FROM per
                       WHERE date_trunc('day', last_end AT TIME ZONE 'UTC') = d.day) AS sessions,
                     (SELECT coalesce(sum(bytes), 0) FROM per
                       WHERE date_trunc('day', last_end AT TIME ZONE 'UTC') = d.day) AS bytes
                FROM days d ORDER BY d.day`,
        shape: 'array',
        path: 'dailySeries',
        fields: {
          day: { col: 'day', as: 'iso' },
          sessionCount: { col: 'sessions', as: 'number' },
          totalSizeBytes: { col: 'bytes', as: 'number' },
        },
        strict: true,
      },
    },
    {
      // AdminOrTeamOwner: a team owner sees the retention view too.
      id: 'F18-retention-team-owner',
      route: 'GET /api/v1/admin/retention',
      actor: 'owner',
      expect: { status: 200 },
      sameExpectedAs: 'F18-retention',
    },
    {
      id: 'F18-retention-member',
      route: 'GET /api/v1/admin/retention',
      actor: 'member',
      expect: { status: 403 },
    },
  ],
};
