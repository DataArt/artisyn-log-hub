// F20 — analytics: timeline, work time, tools, tokens, productivity, active sessions, Claude
// versions (docs/qaa-overview/scenarios/05 §F20). Owner on R1, January 2026: the listed root
// sessions w1-s01 (10th), w1-s02 (11th, with its child w1-s03) and w1-s04 (12th).
//
// Token and line totals cover the session TREE (root + sub-agent children); work time and
// turns are the root's own (sub-agents run inside the root's wall-clock span).
import type { ContractFamily } from '../types';
import { listedRootsSql, treeCostSql } from './oracle-sql';

export const MONTH = { startDate: '2026-01-01', endDate: '2026-01-31' };

/**
 * `roots`: the listed root sessions of repo `$1` started in January 2026; `tree`: every member
 * (root and sub-agent children) of each root's tree, tagged with `root_id`.
 */
export const ROOTS_AND_TREES = `
  WITH RECURSIVE roots AS (SELECT * FROM ${listedRootsSql('$1')} r
                            WHERE r.start_time >= '2026-01-01' AND r.start_time < '2026-02-01'),
       tree AS (SELECT r.id AS root_id, r.id, r.session_id FROM roots r
                UNION ALL
                SELECT t.root_id, c.id, c.session_id
                  FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id)`;

export const f20Analytics: ContractFamily = {
  id: 'F20',
  name: 'analytics',
  cases: [
    {
      id: 'F20-timeline',
      route: 'GET /api/v1/repositories/:repoId/analytics/timeline',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT r.session_id, r.start_time, r.end_time, r.first_prompt, r.git_branch,
                     (SELECT email FROM users WHERE id = r.user_id) AS user_email,
                     NULL::text AS grp,
                     ss.work_time_ms, ${treeCostSql('r.id')} AS total_cost,
                     '[]'::jsonb AS unpriced_models,
                     ss.files_edited_written, ss.cache_read_tokens, ss.cache_write_tokens,
                     (SELECT sum(k.lines_changed) FROM tree t JOIN session_stats k ON k.session_id = t.id
                       WHERE t.root_id = r.id) AS lines_changed,
                     (SELECT jsonb_array_length(c.body) FROM logs c
                       WHERE c.session_id = r.id AND c.log_type = 'claude') AS log_lines,
                     coalesce((SELECT jsonb_object_agg(f.category_name,
                                        jsonb_build_object('files', f.file_count, 'bytes', f.byte_count))
                                 FROM session_file_stats f
                                WHERE f.session_id = r.id AND f.user_id = $2 AND f.team_id IS NULL),
                              '{}'::jsonb) AS file_stats,
                     EXISTS (SELECT 1 FROM user_favorite_sessions fs
                              WHERE fs.session_id = r.id AND fs.user_id = $2) AS is_favorite
                FROM roots r JOIN session_stats ss ON ss.session_id = r.id
               ORDER BY r.start_time`,
        args: ['@R1.id', '@owner.id'],
        shape: 'array',
        fields: {
          sessionId: 'session_id',
          startTime: { col: 'start_time', as: 'iso' },
          endTime: { col: 'end_time', as: 'iso' },
          firstPrompt: 'first_prompt',
          gitBranch: 'git_branch',
          userEmail: 'user_email',
          group: 'grp',
          workTimeMs: { col: 'work_time_ms', as: 'number' },
          totalCost: { col: 'total_cost', as: 'numeric' },
          unpricedModels: { col: 'unpriced_models', as: 'json' },
          filesEditedWritten: 'files_edited_written',
          linesChanged: { col: 'lines_changed', as: 'number' },
          logLineCount: 'log_lines',
          fileStatsByCategory: { col: 'file_stats', as: 'json' },
          cacheReadTokens: { col: 'cache_read_tokens', as: 'number' },
          cacheWriteTokens: { col: 'cache_write_tokens', as: 'number' },
          isFavorite: 'is_favorite',
        },
      },
    },
    {
      id: 'F20-timeline-group-by-user',
      route: 'GET /api/v1/repositories/:repoId/analytics/timeline',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { ...MONTH, groupBy: 'user' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT r.session_id, (SELECT email FROM users WHERE id = r.user_id) AS grp
                FROM roots r ORDER BY r.start_time`,
        args: ['@R1.id'],
        shape: 'array',
        fields: { sessionId: 'session_id', group: 'grp' },
      },
    },
    {
      id: 'F20-timeline-outsider',
      route: 'GET /api/v1/repositories/:repoId/analytics/timeline',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // Minutes of listed-root wall-clock time per UTC day, every day of the range (zero-filled).
      id: 'F20-work-time',
      route: 'GET /api/v1/repositories/:repoId/analytics/work-time',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 31 },
      read: {
        sql: `WITH roots AS (SELECT * FROM ${listedRootsSql('$1')} r),
                   days AS (SELECT generate_series(timestamptz '2026-01-01 00:00Z',
                                                   timestamptz '2026-01-31 00:00Z',
                                                   interval '1 day') AS day)
              SELECT d.day, NULL::text AS grp,
                     coalesce((SELECT sum(extract(epoch FROM
                                        least(r.end_time, d.day + interval '1 day')
                                        - greatest(r.start_time, d.day)) / 60)
                                 FROM roots r
                                WHERE r.start_time < d.day + interval '1 day'
                                  AND r.end_time > d.day), 0) AS minutes
                FROM days d ORDER BY d.day`,
        args: ['@R1.id'],
        shape: 'array',
        fields: {
          day: { col: 'day', as: 'iso' },
          group: 'grp',
          workTimeMinutes: { col: 'minutes', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F20-work-time-bad-group',
      route: 'GET /api/v1/repositories/:repoId/analytics/work-time',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { ...MONTH, groupBy: 'planet' },
      expect: { status: 400 },
    },
    {
      // Per tool over the trees: successes = calls - failures - unresolved. Percentiles and
      // means come from the duration histogram (algorithm) and are not compared.
      id: 'F20-tools',
      route: 'GET /api/v1/repositories/:repoId/analytics/tools',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        minRows: 3,
        bodyMatches: { totalCalls: 4, parallelBatchCalls: 0 },
      },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT ts.tool_name, sum(ts.calls) AS calls, sum(ts.failures) AS failures,
                     sum(ts.unresolved) AS unresolved,
                     sum(ts.calls - ts.failures - ts.unresolved) AS successes,
                     sum(ts.duration_covered_calls) AS covered, max(ts.duration_ms_max) AS max_ms,
                     sum(ts.parallel_batch_calls) AS parallel
                FROM tree t JOIN session_tool_stats ts ON ts.session_id = t.id
               GROUP BY ts.tool_name`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'tools',
        sortBy: 'tool',
        fields: {
          tool: 'tool_name',
          calls: { col: 'calls', as: 'number' },
          successes: { col: 'successes', as: 'number' },
          failures: { col: 'failures', as: 'number' },
          unresolved: { col: 'unresolved', as: 'number' },
          durationCoveredCalls: { col: 'covered', as: 'number' },
          durationMaxMs: { col: 'max_ms', as: 'number' },
          parallelBatchCalls: { col: 'parallel', as: 'number' },
        },
      },
    },
    {
      id: 'F20-tokens-totals',
      route: 'GET /api/v1/repositories/:repoId/analytics/tokens',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT sum(k.input_tokens) AS input, sum(k.output_tokens) AS output,
                     sum(k.cache_read_tokens) AS cache_read, sum(k.cache_write_tokens) AS cache_write,
                     sum(k.cache_write_5m_tokens) AS w5m, sum(k.cache_write_1h_tokens) AS w1h
                FROM tree t JOIN session_stats k ON k.session_id = t.id`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'totals',
        fields: {
          input: { col: 'input', as: 'number' },
          output: { col: 'output', as: 'number' },
          cacheRead: { col: 'cache_read', as: 'number' },
          cacheCreation: { col: 'cache_write', as: 'number' },
          cacheWrite5m: { col: 'w5m', as: 'number' },
          cacheWrite1h: { col: 'w1h', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F20-tokens-buckets',
      route: 'GET /api/v1/repositories/:repoId/analytics/tokens',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket,
                     sum(k.input_tokens) AS input, sum(k.output_tokens) AS output,
                     sum(k.cache_read_tokens) AS cache_read, sum(k.cache_write_tokens) AS cache_write,
                     sum(k.cache_write_5m_tokens) AS w5m, sum(k.cache_write_1h_tokens) AS w1h
                FROM roots r JOIN tree t ON t.root_id = r.id
                JOIN session_stats k ON k.session_id = t.id
               GROUP BY 1 ORDER BY 1`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'buckets',
        fields: {
          bucket: 'bucket',
          input: { col: 'input', as: 'number' },
          output: { col: 'output', as: 'number' },
          cacheRead: { col: 'cache_read', as: 'number' },
          cacheCreation: { col: 'cache_write', as: 'number' },
          cacheWrite5m: { col: 'w5m', as: 'number' },
          cacheWrite1h: { col: 'w1h', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F20-productivity',
      route: 'GET /api/v1/repositories/:repoId/analytics/productivity',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT sum(k.lines_added) AS added, sum(k.lines_removed) AS removed,
                     sum(k.commit_count) AS commits, sum(k.pr_count) AS prs,
                     sum(k.diff_lines_covered_calls) AS covered,
                     sum(k.diff_lines_total_calls) AS total
                FROM tree t JOIN session_stats k ON k.session_id = t.id`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'totals',
        fields: {
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
          commits: { col: 'commits', as: 'number' },
          pullRequests: { col: 'prs', as: 'number' },
          diffCoveredCalls: { col: 'covered', as: 'number' },
          diffTotalCalls: { col: 'total', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F20-productivity-buckets',
      route: 'GET /api/v1/repositories/:repoId/analytics/productivity',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket,
                     sum(k.lines_added) AS added, sum(k.lines_removed) AS removed,
                     sum(k.commit_count) AS commits, sum(k.pr_count) AS prs
                FROM roots r JOIN tree t ON t.root_id = r.id
                JOIN session_stats k ON k.session_id = t.id
               GROUP BY 1 ORDER BY 1`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'buckets',
        fields: {
          bucket: 'bucket',
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
          commits: { col: 'commits', as: 'number' },
          pullRequests: { col: 'prs', as: 'number' },
        },
        strict: true,
      },
    },
    {
      // Newest activity first. Tokens and lines cover the tree; work time and turns the root.
      id: 'F20-active-sessions',
      route: 'GET /api/v1/repositories/:repoId/analytics/active-sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        minRows: 3,
        bodyMatches: { limit: 100, truncated: false },
      },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT r.session_id, r.first_prompt, r.git_branch, r.end_time,
                     (SELECT email FROM users WHERE id = r.user_id) AS user_email,
                     ss.work_time_ms, ss.turn_count, ${treeCostSql('r.id')} AS total_cost,
                     CASE WHEN ${treeCostSql('r.id')} IS NULL THEN 'unknown-model' END
                       AS cost_unavailable_reason,
                     CASE WHEN ${treeCostSql('r.id')} IS NULL THEN jsonb_build_array(ss.model)
                          ELSE '[]'::jsonb END AS unpriced_models,
                     (SELECT sum(k.input_tokens + k.output_tokens + k.cache_read_tokens
                                 + k.cache_write_tokens)
                        FROM tree t JOIN session_stats k ON k.session_id = t.id
                       WHERE t.root_id = r.id) AS tokens,
                     (SELECT coalesce(sum(ts.calls), 0)
                        FROM tree t JOIN session_tool_stats ts ON ts.session_id = t.id
                       WHERE t.root_id = r.id) AS tool_calls,
                     (SELECT ts.tool_name
                        FROM tree t JOIN session_tool_stats ts ON ts.session_id = t.id
                       WHERE t.root_id = r.id ORDER BY ts.calls DESC, ts.tool_name LIMIT 1) AS top_tool,
                     (SELECT sum(k.lines_added) FROM tree t JOIN session_stats k ON k.session_id = t.id
                       WHERE t.root_id = r.id) AS added,
                     (SELECT sum(k.lines_removed) FROM tree t JOIN session_stats k ON k.session_id = t.id
                       WHERE t.root_id = r.id) AS removed
                FROM roots r JOIN session_stats ss ON ss.session_id = r.id
               ORDER BY r.end_time DESC`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'sessions',
        fields: {
          sessionId: 'session_id',
          firstPrompt: 'first_prompt',
          userEmail: 'user_email',
          gitBranch: 'git_branch',
          lastActivity: { col: 'end_time', as: 'iso' },
          workTimeMs: { col: 'work_time_ms', as: 'number' },
          turns: 'turn_count',
          totalTokens: { col: 'tokens', as: 'number' },
          totalCost: { col: 'total_cost', as: 'numeric' },
          unpricedModels: { col: 'unpriced_models', as: 'json' },
          costUnavailableReason: 'cost_unavailable_reason',
          toolCalls: { col: 'tool_calls', as: 'number' },
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
          topTool: 'top_tool',
        },
        strict: true,
      },
    },
    {
      // `limit` caps the list and flags the cut.
      id: 'F20-active-sessions-limit',
      route: 'GET /api/v1/repositories/:repoId/analytics/active-sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { ...MONTH, limit: 1 },
      expect: {
        status: 200,
        minRows: 1,
        bodyMatches: { limit: 1, truncated: true },
      },
      read: {
        sql: `SELECT 'w1-s04-favorite' AS session_id`,
        shape: 'array',
        path: 'sessions',
        fields: { sessionId: 'session_id' },
      },
    },
    {
      // Sessions on a Claude version older than the stable one known at the time count as
      // outdated; the world's 2.1.99 never is.
      id: 'F20-claude-versions',
      route: 'GET /api/v1/repositories/:repoId/analytics/claude-versions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT r.user_id, u.email, count(*) AS checked, 0 AS outdated
                FROM roots r JOIN users u ON u.id = r.user_id
                JOIN session_stats ss ON ss.session_id = r.id
               WHERE coalesce(ss.claude_version, ss.claude_version_otel) IS NOT NULL
               GROUP BY r.user_id, u.email`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'rows',
        fields: {
          userId: 'user_id',
          userEmail: 'email',
          sessionsChecked: { col: 'checked', as: 'number' },
          outdatedSessions: 'outdated',
        },
        strict: true,
      },
    },
    {
      id: 'F20-claude-versions-outsider',
      route: 'GET /api/v1/repositories/:repoId/analytics/claude-versions',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // The admin role grants no data access (2026-10-21-private-repo-visibility).
      id: 'F20-timeline-admin',
      route: 'GET /api/v1/repositories/:repoId/analytics/timeline',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
  ],
};
