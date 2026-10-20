// F21 — reports (docs/qaa-overview/scenarios/05 §F21). Five reports are twins of F20 analytics
// on the same services: they carry `sameExpectedAs` and are compared answer-to-answer, the SQL is
// not repeated. Owner on R1, January 2026 (see F20 for the session set).
import type { ContractFamily } from '../types';
import { MONTH, ROOTS_AND_TREES } from './f20-analytics';
import { treeCostSql } from './oracle-sql';

export const f21Reports: ContractFamily = {
  id: 'F21',
  name: 'reports',
  cases: [
    {
      // Totals over the period: cost includes sub-agents; lines over the trees; work time and
      // session length are the roots' own. Nothing is excluded (every root model is priced).
      id: 'F21-executive-summary',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        bodyMatches: {
          teamSize: null,
          excludedModels: [],
          previousPeriod: null,
        },
      },
      read: {
        sql: `${ROOTS_AND_TREES},
              per AS (SELECT r.id, r.user_id, ss.work_time_ms, ${treeCostSql('r.id')} AS cost,
                             (SELECT sum(k.lines_changed) FROM tree t
                                JOIN session_stats k ON k.session_id = t.id
                               WHERE t.root_id = r.id) AS lines
                        FROM roots r JOIN session_stats ss ON ss.session_id = r.id)
              SELECT sum(cost) AS total_cost, count(*) AS sessions,
                     count(DISTINCT user_id) AS users, sum(cost) / count(*) AS avg_cost,
                     sum(lines) AS lines, sum(cost) / sum(lines) AS cost_per_line,
                     sum(lines) / (sum(work_time_ms) / 3600000.0) AS lines_per_hour,
                     avg(work_time_ms) AS avg_length, 0 AS excluded
                FROM per`,
        args: ['@R1.id'],
        shape: 'object',
        fields: {
          totalCost: { col: 'total_cost', as: 'numeric' },
          totalSessions: { col: 'sessions', as: 'number' },
          activeUsers: { col: 'users', as: 'number' },
          avgCostPerSession: { col: 'avg_cost', as: 'numeric' },
          totalLinesChanged: { col: 'lines', as: 'number' },
          avgCostPerLine: { col: 'cost_per_line', as: 'numeric' },
          avgLinesPerHour: { col: 'lines_per_hour', as: 'numeric' },
          avgSessionLengthMs: { col: 'avg_length', as: 'numeric' },
          excludedSessionCount: 'excluded',
        },
      },
    },
    {
      // Golden constant for the period's cost (1.725 + 1.8 + 0.4).
      id: 'F21-executive-summary-golden',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `SELECT 3.925 AS total_cost, 3 AS sessions`,
        shape: 'object',
        fields: {
          totalCost: { col: 'total_cost', as: 'numeric' },
          totalSessions: 'sessions',
        },
      },
    },
    {
      // One row per root model; cost share of the period total.
      id: 'F21-executive-summary-model-mix',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `${ROOTS_AND_TREES},
              per AS (SELECT ss.model, ${treeCostSql('r.id')} AS cost
                        FROM roots r JOIN session_stats ss ON ss.session_id = r.id)
              SELECT model, count(*) AS sessions,
                     count(*)::numeric / (SELECT count(*) FROM per) AS share,
                     sum(cost) AS cost, sum(cost) / (SELECT sum(cost) FROM per) AS cost_share
                FROM per GROUP BY model`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'modelMix',
        sortBy: 'model',
        fields: {
          model: 'model',
          sessionCount: { col: 'sessions', as: 'number' },
          share: { col: 'share', as: 'numeric' },
          cost: { col: 'cost', as: 'numeric' },
          costShare: { col: 'cost_share', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      // Most expensive first. startTime is Postgres' text form of the timestamp, not ISO.
      id: 'F21-executive-summary-top-sessions',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT r.start_time::text AS start_time,
                     (SELECT email FROM users WHERE id = r.user_id) AS email, r.git_branch,
                     ss.work_time_ms, ${treeCostSql('r.id')} AS cost, ss.model,
                     ss.input_tokens, ss.output_tokens, ss.cache_read_tokens,
                     ss.cache_write_tokens, NULL::text AS reason
                FROM roots r JOIN session_stats ss ON ss.session_id = r.id
               ORDER BY cost DESC`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'topSessions',
        fields: {
          startTime: { col: 'start_time', as: 'raw' },
          userEmail: 'email',
          branch: 'git_branch',
          workTimeMs: { col: 'work_time_ms', as: 'number' },
          cost: { col: 'cost', as: 'numeric' },
          model: 'model',
          inputTokens: { col: 'input_tokens', as: 'number' },
          outputTokens: { col: 'output_tokens', as: 'number' },
          cacheReadTokens: { col: 'cache_read_tokens', as: 'number' },
          cacheWriteTokens: { col: 'cache_write_tokens', as: 'number' },
          costUnavailableReason: 'reason',
        },
        strict: true,
      },
    },
    {
      // What the post-turn advisor itself cost in the period.
      id: 'F21-executive-summary-advisor-spend',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT count(*) AS runs, count(DISTINCT t.session_id) AS sessions,
                     sum(t.cost_usd) AS cost
                FROM roots r JOIN turn_end_advisor_runs t ON t.session_id = r.session_id`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'advisorSpend',
        fields: {
          evaluationCount: { col: 'runs', as: 'number' },
          distinctInvokingSessions: { col: 'sessions', as: 'number' },
          costUsd: { col: 'cost', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F21-executive-summary-attribution-spend',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT count(*) AS runs, count(DISTINCT a.invoking_session_id) AS sessions,
                     sum(a.cost_usd) AS cost
                FROM roots r JOIN session_attribution_runs a ON a.session_id = r.id`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'attributionSpend',
        fields: {
          evaluationCount: { col: 'runs', as: 'number' },
          distinctInvokingSessions: { col: 'sessions', as: 'number' },
          costUsd: { col: 'cost', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F21-executive-summary-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/executive-summary',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // ratio = cache read / (cache read + cache write) — the code's definition (05 §F21 wrote
      // input into the denominator; the code does not). Costs at the root model's cache rates.
      id: 'F21-cache-read-ratio',
      route: 'GET /api/v1/repositories/:repoId/reports/cache-read-ratio',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES},
              priced AS (SELECT ss.*, (SELECT p.price_cache_r FROM model_pricing p
                                        WHERE p.model_id = ss.model AND p.effective_from <= current_date
                                        ORDER BY p.effective_from DESC LIMIT 1) AS pr,
                                      (SELECT p.price_cache_w_5m FROM model_pricing p
                                        WHERE p.model_id = ss.model AND p.effective_from <= current_date
                                        ORDER BY p.effective_from DESC LIMIT 1) AS p5,
                                      (SELECT p.price_cache_w_1h FROM model_pricing p
                                        WHERE p.model_id = ss.model AND p.effective_from <= current_date
                                        ORDER BY p.effective_from DESC LIMIT 1) AS p1
                           FROM roots r JOIN session_stats ss ON ss.session_id = r.id)
              SELECT count(*) AS sessions, sum(cache_read_tokens) AS cr,
                     sum(cache_write_tokens) AS cw, sum(cache_write_5m_tokens) AS w5,
                     sum(cache_write_1h_tokens) AS w1,
                     sum(cache_read_tokens)::numeric
                       / nullif(sum(cache_read_tokens) + sum(cache_write_tokens), 0) AS ratio,
                     sum(cache_read_tokens * pr) / 1000000.0 AS read_cost,
                     sum(cache_write_5m_tokens * p5 + cache_write_1h_tokens * p1) / 1000000.0
                       AS write_cost,
                     0 AS undefined_ratio
                FROM priced`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'root',
        fields: {
          sessionCount: { col: 'sessions', as: 'number' },
          cacheReadTokens: { col: 'cr', as: 'number' },
          cacheWriteTokens: { col: 'cw', as: 'number' },
          cacheWrite5mTokens: { col: 'w5', as: 'number' },
          cacheWrite1hTokens: { col: 'w1', as: 'number' },
          ratio: { col: 'ratio', as: 'numeric' },
          cacheReadCost: { col: 'read_cost', as: 'numeric' },
          cacheWriteCost: { col: 'write_cost', as: 'numeric' },
          undefinedRatioSessionCount: 'undefined_ratio',
        },
        strict: true,
      },
    },
    {
      id: 'F21-cache-read-ratio-descendants',
      route: 'GET /api/v1/repositories/:repoId/reports/cache-read-ratio',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT count(*) AS sessions, sum(k.cache_read_tokens) AS cr,
                     sum(k.cache_write_tokens) AS cw
                FROM tree t JOIN session_stats k ON k.session_id = t.id`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'withDescendants',
        fields: {
          sessionCount: { col: 'sessions', as: 'number' },
          cacheReadTokens: { col: 'cr', as: 'number' },
          cacheWriteTokens: { col: 'cw', as: 'number' },
        },
      },
    },
    {
      id: 'F21-cache-read-ratio-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/cache-read-ratio',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // Inventory elements of the repository plus anything the sessions used; a never-used
      // element shows with zero uses. Percentages are shares of the totals (not compared).
      id: 'F21-harness-usage',
      route: 'GET /api/v1/repositories/:repoId/reports/harness-usage',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        minRows: 3,
        bodyMatches: {
          inventoryReported: true,
          elementCount: 3,
          neverUsedCount: 1,
          totalUses: 3,
          sessionCount: 3,
        },
      },
      read: {
        sql: `${ROOTS_AND_TREES},
              used AS (SELECT h.kind, h.name, sum(h.uses) AS uses,
                              sum(h.input_tokens) AS input, sum(h.output_tokens) AS output
                         FROM tree t JOIN session_harness_usage h ON h.session_id = t.id
                        GROUP BY h.kind, h.name),
              keys AS (SELECT kind, name FROM harness_elements WHERE repo_id = $1
                       UNION SELECT kind, name FROM used)
              SELECT k.kind, k.name, coalesce(u.uses, 0) AS uses,
                     coalesce(u.input, 0) AS input, coalesce(u.output, 0) AS output,
                     e.mcp_connected, e.schema_size_tokens, e.first_seen, e.last_seen, e.source
                FROM keys k
                LEFT JOIN used u ON u.kind = k.kind AND u.name = k.name
                LEFT JOIN harness_elements e ON e.repo_id = $1 AND e.kind = k.kind AND e.name = k.name`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'rows',
        sortBy: 'name',
        fields: {
          kind: 'kind',
          name: 'name',
          uses: { col: 'uses', as: 'number' },
          inputTokens: { col: 'input', as: 'number' },
          outputTokens: { col: 'output', as: 'number' },
          mcpConnected: 'mcp_connected',
          schemaSizeTokens: 'schema_size_tokens',
          firstSeen: { col: 'first_seen', as: 'iso?' },
          lastSeen: { col: 'last_seen', as: 'iso?' },
          source: 'source',
        },
      },
    },
    {
      id: 'F21-harness-usage-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/harness-usage',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // One section per attribute; a row per stored value, plus "Not determined" (evaluated, no
      // value) and "Unattributed" (never evaluated). Golden.
      id: 'F21-attribution-breakdown',
      route: 'GET /api/v1/repositories/:repoId/reports/attribution-breakdown',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        minRows: 4,
        bodyMatches: { totalSessionCount: 3, orphanedSessionCount: 0 },
      },
      read: {
        sql: `SELECT * FROM (VALUES ('ARR-1', 1, 1 / 3.0, 1.725), ('ARR-2', 1, 1 / 3.0, 0.4),
                                    ('Not determined', 0, 0, 0), ('Unattributed', 1, 1 / 3.0, 1.8))
                         AS g(value, sessions, share, cost)`,
        shape: 'array',
        path: 'sections.0.rows',
        fields: {
          value: 'value',
          sessionCount: 'sessions',
          share: { col: 'share', as: 'numeric' },
          costUsd: { col: 'cost', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F21-attribution-breakdown-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/attribution-breakdown',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // What the attribution evaluations cost, over the runs of the period's sessions.
      id: 'F21-attribution-usage',
      route: 'GET /api/v1/repositories/:repoId/reports/attribution-usage',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT count(*) AS runs, count(DISTINCT a.session_id) AS sessions,
                     sum(a.cost_usd) AS cost, avg(a.cost_usd) AS avg_cost
                FROM roots r JOIN session_attribution_runs a ON a.session_id = r.id`,
        args: ['@R1.id'],
        shape: 'object',
        fields: {
          evaluationCount: { col: 'runs', as: 'number' },
          distinctSessionCount: { col: 'sessions', as: 'number' },
          totalCostUsd: { col: 'cost', as: 'numeric' },
          avgCostUsd: { col: 'avg_cost', as: 'numeric' },
        },
      },
    },
    {
      id: 'F21-attribution-usage-outcomes',
      route: 'GET /api/v1/repositories/:repoId/reports/attribution-usage',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `${ROOTS_AND_TREES}
              SELECT o.outcome,
                     (SELECT count(*) FROM roots r JOIN session_attribution_runs a
                         ON a.session_id = r.id WHERE a.outcome = o.outcome) AS runs,
                     (SELECT coalesce(sum(a.cost_usd), 0) FROM roots r JOIN session_attribution_runs a
                         ON a.session_id = r.id WHERE a.outcome = o.outcome) AS cost
                FROM unnest(ARRAY['applied', 'ignored_stale', 'failed']) WITH ORDINALITY AS o(outcome, n)
               ORDER BY o.n`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'outcomeBreakdown',
        fields: {
          outcome: 'outcome',
          count: { col: 'runs', as: 'number' },
          costUsd: { col: 'cost', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F21-attribution-usage-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/attribution-usage',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      id: 'F21-tool-analytics',
      route: 'GET /api/v1/repositories/:repoId/reports/tool-analytics',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      sameExpectedAs: 'F20-tools',
    },
    {
      id: 'F21-token-usage',
      route: 'GET /api/v1/repositories/:repoId/reports/token-usage',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      sameExpectedAs: 'F20-tokens-totals',
    },
    {
      id: 'F21-productivity-counters',
      route: 'GET /api/v1/repositories/:repoId/reports/productivity-counters',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      sameExpectedAs: 'F20-productivity',
    },
    {
      id: 'F21-active-sessions',
      route: 'GET /api/v1/repositories/:repoId/reports/active-sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      sameExpectedAs: 'F20-active-sessions',
    },
    {
      id: 'F21-claude-versions',
      route: 'GET /api/v1/repositories/:repoId/reports/claude-versions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      sameExpectedAs: 'F20-claude-versions',
    },
    {
      id: 'F21-twin-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/tool-analytics',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
  ],
};
