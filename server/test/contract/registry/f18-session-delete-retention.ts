// F18 — session deletion and the retention view (docs/qaa-overview/scenarios/05 §F18).
//
// Deleting a session soft-deletes the `sessions` row (and its children), drops every per-session
// row and the session's logs, removes contexts only that session used, and writes one audit row.
import type { ContractFamily, WriteSpec } from '../types';

/** Every table a session deletion may touch. */
const SESSION_TABLES = [
  'sessions',
  'logs',
  'log_repositories',
  'log_contexts',
  'contexts',
  'session_stats',
  'session_request_ids',
  'session_tool_stats',
  'session_changed_paths',
  'session_file_stats',
  'session_harness_usage',
  'session_attribution',
  'session_attribution_runs',
  'session_prompt_watermark',
  'user_favorite_sessions',
  'deleted_session_log',
  // DD-11 steps g/h: every purge unconditionally nulls the deleted session's
  // harness_snapshot_id and sweeps harness_snapshots rows no session references any more.
  'harness_snapshots',
];

function deleteSession(
  pk: string,
  sessionId: string,
  actor: string,
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
        {
          table: 'log_contexts',
          where: `log_id IN (SELECT id FROM logs WHERE session_id = ${pk})`,
          count: 'all',
        },
        // A context no other session's log uses goes with it.
        {
          table: 'contexts',
          where: `id IN (SELECT lc.context_id FROM log_contexts lc JOIN logs l ON l.id = lc.log_id
                          WHERE l.session_id = ${pk})
                  AND id NOT IN (SELECT lc.context_id FROM log_contexts lc JOIN logs l ON l.id = lc.log_id
                                  WHERE l.session_id <> ${pk})`,
          count: 'all',
        },
        { table: 'session_stats', where: `session_id = ${pk}`, count: 'all' },
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
        // KNOWN DISCREPANCY, pinned as the code behaves today (05 §F18 expects these emptied
        // too): the soft-deleted `sessions` row keeps its session_request_ids,
        // session_tool_stats, session_changed_paths (raw file paths), session_harness_usage,
        // session_attribution (+ runs) and session_prompt_watermark rows. They are watched
        // above, so they must stay exactly as they were. Reported with chunk 23.
      ],
      inserted: [
        {
          table: 'deleted_session_log',
          where: `session_id = '${sessionId}'`,
          check: [`session_pk = ${pk}`, `deleted_by_user_id = ${actor}`],
        },
      ],
    },
    keys: { session_file_stats: ['session_id', 'category_name'] },
  };
}

export const f18SessionDeleteRetention: ContractFamily = {
  id: 'F18',
  name: 'session-delete-retention',
  cases: [
    {
      id: 'F18-delete',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'owner',
      params: { sessionId: '@s01.sessionId' },
      expect: { status: 204 },
      write: deleteSession('@s01.id', 'w1-s01-plain', '@owner.id'),
    },
    {
      id: 'F18-delete-by-admin',
      route: 'DELETE /api/v1/sessions/:sessionId',
      actor: 'admin',
      params: { sessionId: '@s04.sessionId' },
      expect: { status: 204 },
      write: deleteSession(
        '@s04.id',
        'w1-s04-favorite',
        '@admin.id',
        '@harnessSnapshotId',
      ),
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
                     count(*) AS total
                FROM per`,
        shape: 'object',
        fields: {
          retentionDays: 'retention_days',
          oldestSessionAt: { col: 'oldest', as: 'iso?' },
          youngestSessionAt: { col: 'youngest', as: 'iso?' },
          totalSessionCount: { col: 'total', as: 'number' },
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
