// F17 — sessions: lists and subsets (docs/qaa-overview/scenarios/05 §F17). The riskiest family:
// the list endpoint is one large CTE. Costs are proven twice (05 §2.2): by a hand-computed
// golden constant and by an independent SQL formula over session_stats x model_pricing.
//
// World costs (world-model-a 1/2/0.5/1.25/2, world-model-b 2/4/1/2.5/4 USD per 1M tokens):
//   w1-s01 1.725 = 1.0 in + 0.5 out + 0.1 cache-read + 0.125 cache-write-5m;
//   w1-s02 1.4 own (model b: 1.0 + 0.2 + 0.2 cache-write-1h) + 0.4 for its child w1-s03 = 1.8;
//   w1-s04 0.4 = 0.1 + 0.1 + 0.2 cache-read; w1-s06 runs an unpriced model: cost null.
import type { ContractFamily } from '../types';
import { isoSql, listedRootsSql, ownCostSql, treeCostSql } from './oracle-sql';

const MONTH = { startDate: '2026-01-01', endDate: '2026-01-31' };

export const f17Sessions: ContractFamily = {
  id: 'F17',
  name: 'sessions',
  cases: [
    {
      id: 'F17-list',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT r.session_id, r.first_prompt, r.start_time, r.end_time, r.git_branch,
                     u.email AS user_email, r.user_id,
                     ${treeCostSql('r.id')} AS total_cost,
                     CASE WHEN ${ownCostSql('ss')} IS NULL THEN 'unknown-model' END
                       AS cost_unavailable_reason,
                     EXISTS (SELECT 1 FROM user_favorite_sessions f
                              WHERE f.session_id = r.id AND f.user_id = $2) AS is_favorite,
                     EXISTS (SELECT 1 FROM logs h WHERE h.session_id = r.id
                                AND h.body @> '[{"event":"hook_service"}]') AS is_hook_service,
                     -- Same predicate as repositories.controller.ts (hasWorkflowSet): an
                     -- assistant tool_use block named Workflow with a non-empty string id in
                     -- one of the session's claude logs — never a text match.
                     EXISTS (SELECT 1 FROM logs cl
                              WHERE cl.session_id = r.id AND cl.log_type = 'claude'
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
                                     AND blk.tu ->> 'id' <> ''))
                       AS has_workflow,
                     EXISTS (SELECT 1 FROM turn_end_advisor_runs t
                              WHERE t.session_id = r.session_id AND t.outcome = 'submitted')
                       AS has_advice,
                     coalesce(ss.claude_version, ss.claude_version_otel) AS claude_version,
                     (SELECT jsonb_build_object('values', sa.values,
                                                'promptWatermark', sa.prompt_watermark,
                                                'updatedAt', ${isoSql('sa.updated_at')})
                        FROM session_attribution sa WHERE sa.session_id = r.id) AS attribution,
                     (SELECT jsonb_build_object('outcome', ar.outcome,
                                                'finishedAt', ${isoSql('ar.finished_at')},
                                                'failureReason', ar.failure_reason)
                        FROM session_attribution_runs ar WHERE ar.session_id = r.id
                       ORDER BY ar.finished_at DESC LIMIT 1) AS last_run
                FROM ${listedRootsSql('$1')} r
                JOIN users u ON u.id = r.user_id
                LEFT JOIN session_stats ss ON ss.session_id = r.id
               ORDER BY r.end_time DESC`,
        args: ['@R1.id', '@owner.id'],
        shape: 'array',
        fields: {
          sessionId: 'session_id',
          firstPrompt: 'first_prompt',
          startTime: { col: 'start_time', as: 'iso' },
          endTime: { col: 'end_time', as: 'iso' },
          gitBranch: 'git_branch',
          userEmail: 'user_email',
          userId: 'user_id',
          totalCost: { col: 'total_cost', as: 'numeric' },
          computedCost: { col: 'total_cost', as: 'numeric' },
          costUnavailableReason: 'cost_unavailable_reason',
          isFavorite: 'is_favorite',
          isHookService: 'is_hook_service',
          hasWorkflow: 'has_workflow',
          hasAdvisorAdvice: 'has_advice',
          claudeVersion: 'claude_version',
          attribution: { col: 'attribution', as: 'json' },
          lastRun: { col: 'last_run', as: 'json' },
        },
        // costBreakdown has its own row; hasCostDiscrepancy needs OTEL cost, which the world
        // has none of.
        ignore: ['costBreakdown', 'hasCostDiscrepancy'],
        strict: true,
      },
    },
    {
      // Golden constants, independent of the SQL formula above.
      id: 'F17-list-golden-cost',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT * FROM (VALUES ('w1-s04-favorite', 0.4), ('w1-s02-parent', 1.8),
                                    ('w1-s01-plain', 1.725)) AS g(session_id, cost)`,
        shape: 'array',
        fields: {
          sessionId: 'session_id',
          totalCost: { col: 'cost', as: 'numeric' },
        },
      },
    },
    {
      // w1-s02 is the list's second row: its own cost plus the child w1-s03 as sub-agent cost.
      id: 'F17-list-cost-breakdown',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT ${ownCostSql('own')} AS main_cost,
                     ${treeCostSql('own.session_id')} - ${ownCostSql('own')} AS subagent_cost,
                     ${treeCostSql('own.session_id')} AS total_cost,
                     0 AS utility_cost, NULL::numeric AS telemetry_cost, false AS flag,
                     '[]'::jsonb AS unpriced_models
                FROM session_stats own WHERE own.session_id = $1`,
        args: ['@s02.id'],
        shape: 'object',
        path: '1.costBreakdown',
        fields: {
          mainCost: { col: 'main_cost', as: 'numeric' },
          subagentCost: { col: 'subagent_cost', as: 'numeric' },
          utilityCost: { col: 'utility_cost', as: 'numeric' },
          calculatedCost: { col: 'total_cost', as: 'numeric' },
          telemetryCost: 'telemetry_cost',
          mismatch: 'flag',
          utilityPricingMissing: 'flag',
          subagentPricingMissing: 'flag',
          unpricedModels: { col: 'unpriced_models', as: 'json' },
        },
        strict: true,
      },
    },
    {
      // The member's own w1-s06 (first in the T1 list) runs world-model-unpriced: no
      // calculated cost at all (never a partial sum), and the model is named for the
      // `$???` hint.
      id: 'F17-list-cost-breakdown-unpriced',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'member',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT NULL::numeric AS main_cost, 0 AS zero, NULL::numeric AS total_cost,
                     NULL::numeric AS telemetry_cost, false AS flag,
                     jsonb_build_array(ss.model) AS unpriced_models
                FROM session_stats ss WHERE ss.session_id = $1`,
        args: ['@s06.id'],
        shape: 'object',
        path: '0.costBreakdown',
        fields: {
          mainCost: { col: 'main_cost', as: 'numeric' },
          subagentCost: { col: 'zero', as: 'numeric' },
          utilityCost: { col: 'zero', as: 'numeric' },
          calculatedCost: { col: 'total_cost', as: 'numeric' },
          telemetryCost: 'telemetry_cost',
          mismatch: 'flag',
          utilityPricingMissing: 'flag',
          subagentPricingMissing: 'flag',
          unpricedModels: { col: 'unpriced_models', as: 'json' },
        },
        strict: true,
      },
    },
    {
      // Transparent team T1: the member sees every T1 member's sessions in the URL, prompts
      // included — their own unpriced w1-s06 too (cost null). Golden.
      id: 'F17-list-team-transparent',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'member',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 200, minRows: 4 },
      read: {
        sql: `SELECT * FROM (VALUES
                ('w1-s06-member', 'member@arrakis.test', 'Translate the stillsuit manual', NULL::numeric),
                ('w1-s04-favorite', 'owner@arrakis.test', 'Sketch the sandworm detector', 0.4),
                ('w1-s02-parent', 'owner@arrakis.test', 'Refactor the harvester scheduler', 1.8),
                ('w1-s01-plain', 'owner@arrakis.test', 'Add a spice-yield endpoint', 1.725)
              ) AS g(session_id, email, prompt, cost)`,
        shape: 'array',
        fields: {
          sessionId: 'session_id',
          userEmail: 'email',
          firstPrompt: 'prompt',
          totalCost: { col: 'cost', as: 'numeric' },
        },
      },
    },
    {
      // Restricted team T2: the manager sees the owner's sessions with the prompt masked; the
      // member has not acknowledged T2's disclosure, so their session is not shown at all.
      id: 'F17-list-team-restricted-manager',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'manager',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T2.id' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT * FROM (VALUES ('w1-s04-favorite', NULL), ('w1-s02-parent', NULL),
                                    ('w1-s01-plain', NULL)) AS g(session_id, prompt)`,
        shape: 'array',
        fields: { sessionId: 'session_id', firstPrompt: 'prompt' },
      },
    },
    {
      // Not the owner, no teamId: no access.
      id: 'F17-list-member-no-team',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'member',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-list-outsider',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-ids',
      route: 'GET /api/v1/repositories/:repoId/sessions/ids',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT r.session_id FROM ${listedRootsSql('$1')} r`,
        args: ['@R1.id'],
        shape: 'array',
        scalar: 'session_id',
        // The endpoint has no ORDER BY.
        unordered: true,
      },
    },
    {
      // totalCost is the sum of the roots' tree costs (sub-agents included), as the session
      // list shows them. latestEndTime is Postgres' text form of the timestamp, not ISO.
      id: 'F17-branches',
      route: 'GET /api/v1/repositories/:repoId/sessions/branches',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT b.git_branch, count(*) AS session_count, max(b.end_time)::text AS latest_end,
                     sum(b.work_time) AS work_time, sum(b.lines_own) AS lines_own,
                     sum(b.lines_own + b.lines_kids) AS lines_all, sum(b.tree_cost) AS tree_cost
                FROM (SELECT r.git_branch, r.end_time, ss.work_time_ms AS work_time,
                             ss.lines_changed AS lines_own,
                             coalesce((SELECT sum(k.lines_changed) FROM sessions c
                                         JOIN session_stats k ON k.session_id = c.id
                                        WHERE c.parent_session_id = r.session_id), 0) AS lines_kids,
                             ${treeCostSql('r.id')} AS tree_cost
                        FROM ${listedRootsSql('$1')} r
                        JOIN session_stats ss ON ss.session_id = r.id) b
               GROUP BY b.git_branch`,
        args: ['@R1.id'],
        shape: 'array',
        sortBy: 'branch',
        fields: {
          branch: 'git_branch',
          sessionCount: { col: 'session_count', as: 'number' },
          latestEndTime: { col: 'latest_end', as: 'raw' },
          totalWorkTimeMs: { col: 'work_time', as: 'number' },
          totalLinesChanged: { col: 'lines_all', as: 'number' },
          totalLinesChangedOwn: { col: 'lines_own', as: 'number' },
          totalCost: { col: 'tree_cost', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F17-branches-outsider',
      route: 'GET /api/v1/repositories/:repoId/sessions/branches',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // attribute key -> [{value, sessionCount}] over the listed sessions with stored values.
      id: 'F17-attribution-values',
      route: 'GET /api/v1/repositories/:repoId/session-attribution/values',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT kv.key,
                     jsonb_agg(jsonb_build_object('value', kv.value, 'sessionCount', kv.n)
                               ORDER BY kv.value) AS entries
                FROM (SELECT e.key, e.value #>> '{}' AS value, count(*) AS n
                        FROM ${listedRootsSql('$1')} r
                        JOIN session_attribution sa ON sa.session_id = r.id
                        CROSS JOIN jsonb_each(sa.values) e
                       GROUP BY e.key, e.value #>> '{}') kv
               GROUP BY kv.key`,
        args: ['@R1.id'],
        shape: 'map',
        mapKey: 'key',
        mapValue: { col: 'entries', as: 'json' },
      },
    },
    {
      id: 'F17-session-contexts',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/contexts',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT DISTINCT c.context_key, c.context_value
                FROM contexts c
                JOIN log_contexts lc ON lc.context_id = c.id
                JOIN logs l ON l.id = lc.log_id
               WHERE l.session_id = $1`,
        args: ['@s01.id'],
        shape: 'array',
        sortBy: 'value',
        fields: { key: 'context_key', value: 'context_value' },
        strict: true,
      },
    },
    {
      id: 'F17-session-contexts-outsider',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/contexts',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: { status: 403 },
    },
    {
      // `main` is the session's log bodies, element for element: the artisyn log, then claude.
      id: 'F17-session-logs',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: { status: 200 },
      read: {
        sql: `SELECT jsonb_agg(e.line ORDER BY l.id, e.n) AS main
                FROM logs l CROSS JOIN jsonb_array_elements(l.body) WITH ORDINALITY AS e(line, n)
               WHERE l.session_id = $1`,
        args: ['@s04.id'],
        shape: 'object',
        fields: { main: { col: 'main', as: 'json' } },
      },
    },
    {
      // The child w1-s03 is reported as a sub-agent with its own token totals.
      id: 'F17-session-logs-subagent-stats',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: { status: 200 },
      read: {
        sql: `SELECT k.model, k.input_tokens, k.output_tokens, k.cache_read_tokens,
                     k.cache_write_tokens
                FROM sessions c JOIN session_stats k ON k.session_id = c.id
               WHERE c.parent_session_id = $1`,
        args: ['@s02.sessionId'],
        shape: 'object',
        path: 'subagentStats.w1-s03-child',
        fields: {
          model: 'model',
          inputTokens: { col: 'input_tokens', as: 'number' },
          outputTokens: { col: 'output_tokens', as: 'number' },
          cacheReadTokens: { col: 'cache_read_tokens', as: 'number' },
          cacheWriteTokens: { col: 'cache_write_tokens', as: 'number' },
        },
      },
    },
    {
      id: 'F17-session-logs-outsider',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: { status: 403 },
    },
    {
      // DD-12: s04 is bound to the seeded harness_snapshots row, and the response's
      // `harnessSnapshot` is that row's `body` verbatim (no `type`, carries its own `snapshotId`).
      id: 'F17-session-logs-snapshot',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: { status: 200 },
      read: {
        sql: `SELECT body AS harness_snapshot FROM harness_snapshots
               WHERE user_id = $1 AND snapshot_id = $2`,
        args: ['@owner.id', '@harnessSnapshotId'],
        shape: 'object',
        fields: { harnessSnapshot: { col: 'harness_snapshot', as: 'json' } },
      },
    },
    {
      // s01 predates the snapshot feature (no harness_snapshot_id bound) — DD-12 answers null,
      // not an empty object.
      id: 'F17-session-logs-no-snapshot',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: { status: 200, bodyMatches: { harnessSnapshot: null } },
      noDb: true,
    },
    {
      id: 'F17-export-scope',
      route: 'GET /api/v1/repositories/:repoId/sessions/export-scope',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { from: '2026-01-01', to: '2026-01-31' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT r.session_id, r.first_prompt, r.start_time, r.end_time, r.user_id,
                     (SELECT email FROM users WHERE id = r.user_id) AS user_email
                FROM ${listedRootsSql('$1')} r
               WHERE r.start_time >= '2026-01-01' AND r.start_time < '2026-02-01'
               ORDER BY r.end_time DESC`,
        args: ['@R1.id'],
        shape: 'array',
        fields: {
          sessionId: 'session_id',
          firstPrompt: 'first_prompt',
          startTime: { col: 'start_time', as: 'iso' },
          endTime: { col: 'end_time', as: 'iso' },
          userId: 'user_id',
          userEmail: 'user_email',
        },
        strict: true,
      },
    },
    {
      id: 'F17-export-scope-no-from',
      route: 'GET /api/v1/repositories/:repoId/sessions/export-scope',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 400 },
    },
    {
      id: 'F17-favorite-on',
      route: 'POST /api/v1/repositories/:repoId/sessions/:sessionId/favorite',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      body: { favorite: true },
      expect: { status: 201 },
      write: {
        watch: ['user_favorite_sessions'],
        delta: {
          inserted: [
            {
              table: 'user_favorite_sessions',
              where: 'user_id = @owner.id AND session_id = @s01.id',
            },
          ],
        },
      },
    },
    {
      id: 'F17-favorite-off',
      route: 'POST /api/v1/repositories/:repoId/sessions/:sessionId/favorite',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      body: { favorite: false },
      expect: { status: 201 },
      write: {
        watch: ['user_favorite_sessions'],
        delta: {
          deleted: [
            {
              table: 'user_favorite_sessions',
              where: 'user_id = @owner.id AND session_id = @s04.id',
            },
          ],
        },
      },
    },
    {
      id: 'F17-favorite-outsider',
      route: 'POST /api/v1/repositories/:repoId/sessions/:sessionId/favorite',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      body: { favorite: true },
      expect: { status: 403 },
    },
    {
      // The admin role grants no data access (2026-10-21-private-repo-visibility). Personal route (R1 owner's, R3 outsider's) and team route (not a T1 member).
      id: 'F17-list-admin',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-list-admin-r3',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'admin',
      params: { repoId: '@R3.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-list-admin-team',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-branches-admin',
      route: 'GET /api/v1/repositories/:repoId/sessions/branches',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-session-logs-admin',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'admin',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: { status: 403 },
    },
    {
      id: 'F17-session-logs-admin-team',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'admin',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      query: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F17-export-scope-admin',
      route: 'GET /api/v1/repositories/:repoId/sessions/export-scope',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: { from: '2026-01-01', to: '2026-01-31' },
      expect: { status: 403 },
    },
    {
      id: 'F17-export-scope-admin-team',
      route: 'GET /api/v1/repositories/:repoId/sessions/export-scope',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id', from: '2026-01-01', to: '2026-01-31' },
      expect: { status: 403 },
    },
  ],
};
