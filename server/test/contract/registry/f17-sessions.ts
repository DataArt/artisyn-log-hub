// F17 — sessions: lists and subsets (docs/qaa-overview/scenarios/05 §F17). The riskiest family:
// the list endpoint is one large CTE. Costs are proven twice (05 §2.2): by a hand-computed
// golden constant and by an independent SQL formula over session_stats x model_pricing.
//
// World costs (world-model-a 1/2/0.5/1.25/2, world-model-b 2/4/1/2.5/4 USD per 1M tokens):
//   w1-s01 1.725 = 1.0 in + 0.5 out + 0.1 cache-read + 0.125 cache-write-5m;
//   w1-s02 1.4 own (model b: 1.0 + 0.2 + 0.2 cache-write-1h) + 0.4 for its child w1-s03 = 1.8;
//   w1-s04 0.4 = 0.1 + 0.1 + 0.2 cache-read; w1-s06 runs an unpriced model: cost null.
import { createHash } from 'node:crypto';
import {
  WORLD_V1,
  WORLD_V1_LOG_IDS,
  WORLD_V1_S03_SUBAGENT_BODY,
  WORLD_V1_S03_SUBAGENT_LINE_JSONB_TEXT,
} from '../fixtures/world-v1.sql';
import type { ContractCase, ContractFamily, ReadSpec } from '../types';
import {
  isoSql,
  listedRootsSql,
  ownCostSql,
  subagentOtelUsdSql,
  treeCostSql,
  treeCostWithOtelSubagentsSql,
} from './oracle-sql';

const MONTH = { startDate: '2026-01-01', endDate: '2026-01-31' };

// -------------------------------------------------------------------------------------------
// FR-6 (2026-11-03 otel-cost-attribution): sub-agent cost from OTEL for old Claude Code.
//
// Rtwins (owner, no team) holds two roots, newest first in the list: w1-s14 (2.1.310) and
// w1-s12 (2.1.300). Each costs 0.12 USD itself; each sub-agent costs 0.06 USD by its transcript,
// and the root's OTEL calls under the sub-agent's id sum to 0.25 USD. Only s12's sub-agent is
// before the 2.1.307 fix, so s12 counts 0.12 + 0.25 = 0.37 and s14 keeps 0.12 + 0.06 = 0.18.

/** The breakdown of root `$1` (a `sessions.id`) under FR-6. */
const FR6_BREAKDOWN_SQL = `
  SELECT ${ownCostSql('own')} AS main_cost,
         ${treeCostWithOtelSubagentsSql('own.session_id')} - ${ownCostSql('own')} AS subagent_cost,
         ${treeCostWithOtelSubagentsSql('own.session_id')} AS total_cost,
         EXISTS (SELECT 1 FROM sessions c JOIN session_stats k ON k.session_id = c.id
                  WHERE c.parent_session_id = (SELECT session_id FROM sessions WHERE id = own.session_id)
                    AND ${subagentOtelUsdSql('k', 'c.session_id', 'own.session_id')}
                          > coalesce(${ownCostSql('k')}, 0)) AS from_otel,
         false AS flag
    FROM session_stats own WHERE own.session_id = $1`;

const FR6_BREAKDOWN_FIELDS: ReadSpec['fields'] = {
  mainCost: { col: 'main_cost', as: 'numeric' },
  subagentCost: { col: 'subagent_cost', as: 'numeric' },
  calculatedCost: { col: 'total_cost', as: 'numeric' },
  subagentCostFromOtel: 'from_otel',
  subagentPricingMissing: 'flag',
};

const FR6_LIST_ROWS: ContractCase[] = [
  {
    // Golden constants: the old-CC root's total rises by its sub-agent's OTEL excess.
    id: 'F17-list-fr6-golden-cost',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@Rtwins.id' },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `SELECT * FROM (VALUES ('w1-s14-newcc-root', 0.18), ('w1-s12-oldcc-root', 0.37))
              AS g(session_id, cost)`,
      shape: 'array',
      fields: {
        sessionId: 'session_id',
        totalCost: { col: 'cost', as: 'numeric' },
        computedCost: { col: 'cost', as: 'numeric' },
      },
    },
  },
  {
    // The same totals by the FR-6 formula.
    id: 'F17-list-fr6-cost',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@Rtwins.id' },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `SELECT r.session_id, ${treeCostWithOtelSubagentsSql('r.id')} AS total_cost
              FROM ${listedRootsSql('$1')} r
             ORDER BY r.end_time DESC`,
      args: ['@Rtwins.id'],
      shape: 'array',
      fields: {
        sessionId: 'session_id',
        totalCost: { col: 'total_cost', as: 'numeric' },
      },
    },
  },
  {
    // The old-CC root (second in the list): the sub-agent part is the OTEL cost, flagged —
    // what the session header's cost tooltip shows as "Sub-agents (from OTEL)".
    id: 'F17-list-cost-breakdown-subagent-otel',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@Rtwins.id' },
    expect: { status: 200 },
    read: {
      sql: FR6_BREAKDOWN_SQL,
      args: ['@s12.id'],
      shape: 'object',
      path: '1.costBreakdown',
      fields: FR6_BREAKDOWN_FIELDS,
    },
  },
  {
    // The new-CC root (first): the transcript cost stays, no flag.
    id: 'F17-list-cost-breakdown-subagent-transcript',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@Rtwins.id' },
    expect: { status: 200 },
    read: {
      sql: FR6_BREAKDOWN_SQL,
      args: ['@s14.id'],
      shape: 'object',
      path: '0.costBreakdown',
      fields: FR6_BREAKDOWN_FIELDS,
    },
  },
];

/**
 * `subagentStats[<sub-agent>].otelCostUsd` of sub-agent `$1` (a `sessions.session_id`) under
 * root `$2` (a `sessions.id`): its OTEL cost when that exceeds its transcript cost, else NULL.
 */
const FR6_SUBAGENT_OTEL_SQL = `
  SELECT CASE WHEN o.usd > coalesce(${ownCostSql('k')}, 0) THEN o.usd END AS otel_cost
    FROM sessions c
    JOIN session_stats k ON k.session_id = c.id
    CROSS JOIN LATERAL (SELECT ${subagentOtelUsdSql('k', 'c.session_id', '$2::bigint')} AS usd) o
   WHERE c.session_id = $1`;

/** `/logs` and `/logs/delta` (no cursor: every sub-agent is new) of both Rtwins roots. */
const FR6_LOGS_ROWS: ContractCase[] = (
  [
    ['logs', 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs'],
    [
      'logs-delta',
      'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
    ],
  ] as const
).flatMap(([name, route]): ContractCase[] => [
  {
    // Old CC: the OTEL cost (0.25) is above the transcript (0.06) -> sent.
    id: `F17-session-${name}-subagent-otel-cost`,
    route,
    actor: 'owner',
    params: { repoId: '@Rtwins.id', sessionId: '@s12.sessionId' },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: FR6_SUBAGENT_OTEL_SQL,
      args: ['@s13.sessionId', '@s12.id'],
      shape: 'object',
      path: 'subagentStats.agent-w1oldsub',
      fields: { otelCostUsd: { col: 'otel_cost', as: 'numeric' } },
    },
  },
  {
    // New CC: the same OTEL excess is ignored -> null.
    id: `F17-session-${name}-subagent-no-otel-cost`,
    route,
    actor: 'owner',
    params: { repoId: '@Rtwins.id', sessionId: '@s14.sessionId' },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: FR6_SUBAGENT_OTEL_SQL,
      args: ['@s15.sessionId', '@s14.id'],
      shape: 'object',
      path: 'subagentStats.agent-w1newsub',
      fields: { otelCostUsd: { col: 'otel_cost', as: 'numeric' } },
    },
  },
]);

/**
 * A `/logs/delta` cursor v1 (session-logs-delta.ts) holding every line of s03's
 * `claude-subagent` log, under a `ut` (`0`) that never equals the stored `updated_at` — exactly
 * the state a client is in after s03's same body was uploaded again.
 */
const S03_HELD_CURSOR = Buffer.from(
  JSON.stringify({
    v: 1,
    r: [
      [
        WORLD_V1.sessions.s03.id.toString(36),
        's',
        '0',
        WORLD_V1_S03_SUBAGENT_BODY.length,
        createHash('md5')
          .update(WORLD_V1_S03_SUBAGENT_LINE_JSONB_TEXT)
          .digest('hex')
          .slice(0, 12),
      ],
    ],
  }),
  'utf8',
).toString('base64url');

/**
 * `costBreakdown.costExcludesUtilityCalls` (2026-10-30 otel-shared-receiver, DD-30) of the root
 * whose `session_stats` row is aliased `stats`: no OTEL API call in either OTEL table and a
 * reported `otel_state` other than ok (none reported counts as not ok). World: s02 reported none
 * and has no OTEL call -> true; s06 has an OTEL call -> false.
 */
function excludesUtilitySql(stats: string): string {
  return `(NOT EXISTS (SELECT 1 FROM otel_api_calls a WHERE a.session_id = ${stats}.session_id)
           AND NOT EXISTS (SELECT 1 FROM otel_calls c WHERE c.session_id = ${stats}.session_id)
           AND coalesce(${stats}.otel_state, '') <> 'ok')`;
}

/**
 * The listed roots of repository `$1` the `otelReason=$2` filter keeps: no OTEL data (no
 * `otel_session_state` row, reported state neither ok nor partial) and a reported reason —
 * `no-status` without a report — equal to `$2`, in the list's order.
 */
const OTEL_REASON_ROOTS_SQL = `SELECT r.session_id
    FROM ${listedRootsSql('$1')} r
    LEFT JOIN session_stats ss ON ss.session_id = r.id
   WHERE NOT EXISTS (SELECT 1 FROM otel_session_state o WHERE o.session_id = r.id)
     AND coalesce(ss.otel_state, '') NOT IN ('ok', 'partial')
     AND coalesce(ss.otel_reason, 'no-status') = $2
   ORDER BY r.end_time DESC`;

/**
 * `subagentStats['w1-s03-child']` of s02's tree — the same object on `/logs`, `/logs/delta` and
 * the parts manifest, including the TTL split of `cacheWriteTokens` (2026-11-23
 * session-logs-streaming, DD-32) the client prices a sub-agent from without loading its part.
 */
const S03_SUBAGENT_STATS_READ: ReadSpec = {
  sql: `SELECT k.model, k.input_tokens, k.output_tokens, k.cache_read_tokens,
               k.cache_write_tokens, k.cache_write_5m_tokens, k.cache_write_1h_tokens
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
    cacheWrite5mTokens: { col: 'cache_write_5m_tokens', as: 'number' },
    cacheWrite1hTokens: { col: 'cache_write_1h_tokens', as: 'number' },
  },
};

/** The three routes that carry `subagentStats`. */
const SUBAGENT_STATS_ROUTES = [
  ['logs', 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs'],
  [
    'logs-delta',
    'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
  ],
  [
    'log-parts',
    'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
  ],
] as const;

/**
 * The parts manifest of root `$1` (a `sessions.id`; 2026-11-23 session-logs-streaming DD-5,
 * DD-11), written apart from the service's metadata query: the root's own `claude` then
 * `artisyn` row, then the `claude-subagent` row of every live descendant, by session id. A
 * descendant's own `claude` row (s03 has one) is not a part. `logs.body` is NOT NULL, so no row
 * is left out for a missing body. `rev` is `body_rev`, or `u` + `updated_at` in microseconds
 * while the row has none (DD-8).
 */
const PARTS_MANIFEST_SQL = `
  WITH RECURSIVE tree AS (
    SELECT s.id, s.session_id, 0 AS depth FROM sessions s WHERE s.id = $1
    UNION ALL
    SELECT c.id, c.session_id, t.depth + 1
      FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
     WHERE NOT c.deleted
  )
  SELECT s.session_id, l.log_type,
         coalesce(l.body_rev::text,
                  'u' || (extract(epoch FROM l.updated_at) * 1000000)::bigint::text) AS rev,
         s.parent_session_id, s.agent_description, s.workflow_phase, s.workflow_run_id
    FROM tree t
    JOIN sessions s ON s.id = t.id
    JOIN logs l ON l.session_id = s.id
   WHERE (t.depth = 0 AND l.log_type IN ('claude', 'artisyn'))
      OR (t.depth > 0 AND l.log_type = 'claude-subagent')
   ORDER BY t.depth > 0, l.log_type = 'artisyn', s.session_id`;

/** s02's parts manifest (`parts`) by PARTS_MANIFEST_SQL, field by field. */
const PARTS_MANIFEST_READ: ReadSpec = {
  sql: PARTS_MANIFEST_SQL,
  args: ['@s02.id'],
  shape: 'array',
  path: 'parts',
  fields: {
    sessionId: 'session_id',
    logType: 'log_type',
    rev: 'rev',
    parentSessionId: 'parent_session_id',
    agentDescription: 'agent_description',
    workflowPhase: 'workflow_phase',
    workflowRunId: 'workflow_run_id',
  },
  strict: true,
};

/**
 * 2026-11-24 traffic-optimization (DD-10, DD-23): a gzip-accepting client (superagent sends
 * `Accept-Encoding: gzip, deflate`) gets a gzipped JSON answer — the contract suite sets
 * API_GZIP_MIN_BYTES=1 — and every `/api` JSON answer varies on Accept-Encoding.
 */
const GZIPPED = { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };

/** `Accept-Encoding: identity`: the same answer, uncompressed. */
const IDENTITY = { 'Content-Encoding': null, Vary: 'Accept-Encoding' };

/** The parts API of s04 (owner, R1): `/logs/parts/<partSessionId>/<logType>`. */
const PART_ROUTE =
  'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts/:partSessionId/:logType';

// -------------------------------------------------------------------------------------------
// 2026-11-24 otel-session-tags. World tags (session_tags, always on the root): s01 jira=ARR-1
// (config AND otel), feature=checkout, team.name=Fremen; s02 feature=checkout + feature=billing
// (multi-value); s04 jira=ARR-2 (config), feature=billing; the member's s06 jira=ARR-6 (config).

/**
 * The deduped `tags` array of root `rootExpr`: each (key, value) once, `otel` when any of its
 * rows is `otel`, sorted by key then value (byte order); `[]` when untagged.
 */
function tagsJsonSql(rootExpr: string): string {
  return `coalesce((SELECT jsonb_agg(jsonb_build_object('key', p.key, 'value', p.value,
                                                        'source', p.source)
                                     ORDER BY p.key COLLATE "C", p.value COLLATE "C")
                      FROM (SELECT st.key, st.value,
                                   CASE WHEN bool_or(st.source = 'otel') THEN 'otel'
                                        ELSE 'config' END AS source
                              FROM session_tags st WHERE st.session_id = ${rootExpr}
                             GROUP BY st.key, st.value) p), '[]'::jsonb)`;
}

/** Discovery map (`tags`) over the given root-id derived table: key -> [{value, sessionCount}]. */
function tagValuesMapSql(rootsTable: string): string {
  return `SELECT kv.key,
                 jsonb_agg(jsonb_build_object('value', kv.value, 'sessionCount', kv.n)
                           ORDER BY kv.n DESC, kv.value) AS entries
            FROM (SELECT st.key, st.value, count(DISTINCT r.id) AS n
                    FROM ${rootsTable} r
                    JOIN session_tags st ON st.session_id = r.id
                   GROUP BY st.key, st.value) kv
           GROUP BY kv.key`;
}

/** Golden discovery map of R1's owner sessions (s01, s02, s04) — the T2 manager's view too. */
const R1_OWNER_TAG_VALUES = `
  SELECT * FROM (VALUES
    ('feature', '[{"value":"billing","sessionCount":2},{"value":"checkout","sessionCount":2}]'::jsonb),
    ('jira', '[{"value":"ARR-1","sessionCount":1},{"value":"ARR-2","sessionCount":1}]'::jsonb),
    ('team.name', '[{"value":"Fremen","sessionCount":1}]'::jsonb)
  ) AS g(key, entries)`;

const TAG_ROWS: ContractCase[] = [
  {
    // FR-8 discovery over R1's listed roots in January.
    id: 'F17-tag-values',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: MONTH,
    expect: { status: 200, minRows: 3, bodyMatches: { noisyKeys: [] } },
    read: {
      sql: tagValuesMapSql(listedRootsSql('$1')),
      args: ['@R1.id'],
      shape: 'map',
      path: 'tags',
      mapKey: 'key',
      mapValue: { col: 'entries', as: 'json' },
    },
  },
  {
    id: 'F17-tag-values-golden',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    expect: { status: 200, minRows: 3 },
    read: {
      sql: R1_OWNER_TAG_VALUES,
      shape: 'map',
      path: 'tags',
      mapKey: 'key',
      mapValue: { col: 'entries', as: 'json' },
    },
  },
  {
    // Branch scope: only s04 is on feature/sandworm.
    id: 'F17-tag-values-branch',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { branch: 'feature/sandworm' },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `SELECT * FROM (VALUES
              ('feature', '[{"value":"billing","sessionCount":1}]'::jsonb),
              ('jira', '[{"value":"ARR-2","sessionCount":1}]'::jsonb)) AS g(key, entries)`,
      shape: 'map',
      path: 'tags',
      mapKey: 'key',
      mapValue: { col: 'entries', as: 'json' },
    },
  },
  {
    // Transparent T1: the member's own s06 adds jira=ARR-6.
    id: 'F17-tag-values-team-transparent',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T1.id' },
    expect: { status: 200, minRows: 3 },
    read: {
      sql: `SELECT * FROM (VALUES
              ('feature', '[{"value":"billing","sessionCount":2},{"value":"checkout","sessionCount":2}]'::jsonb),
              ('jira', '[{"value":"ARR-1","sessionCount":1},{"value":"ARR-2","sessionCount":1},{"value":"ARR-6","sessionCount":1}]'::jsonb),
              ('team.name', '[{"value":"Fremen","sessionCount":1}]'::jsonb)
            ) AS g(key, entries)`,
      shape: 'map',
      path: 'tags',
      mapKey: 'key',
      mapValue: { col: 'entries', as: 'json' },
    },
  },
  {
    // Restricted T2: the manager must not see another member's pairs (s06's ARR-6).
    id: 'F17-tag-values-team-restricted-manager',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'manager',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id' },
    expect: { status: 200, minRows: 3 },
    read: {
      sql: R1_OWNER_TAG_VALUES,
      shape: 'map',
      path: 'tags',
      mapKey: 'key',
      mapValue: { col: 'entries', as: 'json' },
    },
  },
  {
    id: 'F17-tag-values-outsider',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    expect: { status: 403 },
  },
  {
    // The admin role grants no session data.
    id: 'F17-tag-values-admin',
    route: 'GET /api/v1/repositories/:repoId/session-tags/values',
    actor: 'admin',
    params: { repoId: '@R1.id' },
    expect: { status: 403 },
  },
  {
    // Every list row carries its root's deduped tags.
    id: 'F17-list-tags',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    expect: { status: 200, minRows: 3 },
    read: {
      sql: `SELECT r.session_id, ${tagsJsonSql('r.id')} AS tags
              FROM ${listedRootsSql('$1')} r
             ORDER BY r.end_time DESC`,
      args: ['@R1.id'],
      shape: 'array',
      fields: { sessionId: 'session_id', tags: { col: 'tags', as: 'json' } },
    },
  },
  {
    // Golden for s01: jira=ARR-1 is stored under both sources and reported once, as `otel`.
    id: 'F17-list-tags-golden',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    expect: { status: 200 },
    read: {
      sql: `SELECT '[{"key":"feature","value":"checkout","source":"otel"},
                     {"key":"jira","value":"ARR-1","source":"otel"},
                     {"key":"team.name","value":"Fremen","source":"otel"}]'::jsonb AS tags`,
      shape: 'object',
      path: '2',
      fields: { tags: { col: 'tags', as: 'json' } },
    },
  },
  {
    // tag=<key>:<value>: OR within a key — feature billing → s04, s02 (newest first).
    id: 'F17-list-tag-filter',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { tag: 'feature:billing' },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `SELECT r.session_id FROM ${listedRootsSql('$1')} r
             WHERE EXISTS (SELECT 1 FROM session_tags st
                            WHERE st.session_id = r.id AND st.key = 'feature'
                              AND st.value = 'billing')
             ORDER BY r.end_time DESC`,
      args: ['@R1.id'],
      shape: 'array',
      fields: { sessionId: 'session_id' },
    },
  },
  {
    // AND across keys, a bare key = any value: feature (any) AND jira=ARR-1 → s01 only.
    id: 'F17-list-tag-filter-and',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { tag: ['feature', 'jira:ARR-1'] },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: `SELECT * FROM (VALUES ('w1-s01-plain')) AS g(session_id)`,
      shape: 'array',
      fields: { sessionId: 'session_id' },
    },
  },
  {
    id: 'F17-list-tag-filter-empty-key',
    route: 'GET /api/v1/repositories/:repoId/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { tag: ':checkout' },
    expect: { status: 400 },
  },
  {
    // `sessions/branches` honours tag= too: jira (any) → s01 on main, s04 on feature/sandworm.
    id: 'F17-branches-tag-filter',
    route: 'GET /api/v1/repositories/:repoId/sessions/branches',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...MONTH, tag: 'jira' },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `SELECT r.git_branch, count(*) AS session_count
              FROM ${listedRootsSql('$1')} r
             WHERE EXISTS (SELECT 1 FROM session_tags st
                            WHERE st.session_id = r.id AND st.key = 'jira')
             GROUP BY r.git_branch`,
      args: ['@R1.id'],
      shape: 'array',
      sortBy: 'branch',
      fields: {
        branch: 'git_branch',
        sessionCount: { col: 'session_count', as: 'number' },
      },
    },
  },
  {
    // The session detail carries the root's tags and the FR-10 verdict (s02: two values of
    // `feature`, far below the noisy threshold, no OTEL pair limit reached).
    id: 'F17-session-logs-tags',
    route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
    actor: 'owner',
    params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
    expect: { status: 200 },
    read: {
      sql: `SELECT ${tagsJsonSql('$1')} AS tags,
                   '{"noisyKeys":[],"atLimit":false}'::jsonb AS tag_noise`,
      args: ['@s02.id'],
      shape: 'object',
      fields: {
        tags: { col: 'tags', as: 'json' },
        tagNoise: { col: 'tag_noise', as: 'json' },
      },
    },
  },
  {
    // The parts manifest carries the same tags.
    id: 'F17-session-log-parts-tags',
    route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
    actor: 'owner',
    params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
    expect: { status: 200 },
    read: {
      sql: `SELECT ${tagsJsonSql('$1')} AS tags,
                   '{"noisyKeys":[],"atLimit":false}'::jsonb AS tag_noise`,
      args: ['@s04.id'],
      shape: 'object',
      fields: {
        tags: { col: 'tags', as: 'json' },
        tagNoise: { col: 'tag_noise', as: 'json' },
      },
    },
  },
];

export const f17Sessions: ContractFamily = {
  id: 'F17',
  name: 'sessions',
  cases: [
    {
      id: 'F17-list',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      // 2026-11-24 traffic-optimization (DD-10, DD-23): gzipped for a gzip-accepting client,
      // the suite runs with API_GZIP_MIN_BYTES=1.
      expect: { status: 200, minRows: 3, headers: GZIPPED },
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
                       ORDER BY ar.finished_at DESC LIMIT 1) AS last_run,
                     ${tagsJsonSql('r.id')} AS tags
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
          tags: { col: 'tags', as: 'json' },
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
                     '[]'::jsonb AS unpriced_models,
                     ${excludesUtilitySql('own')} AS excludes_utility
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
          costExcludesUtilityCalls: 'excludes_utility',
          // FR-6: s03 runs 2.1.99 (before the fix), but s02 has no OTEL call under its id.
          subagentCostFromOtel: 'flag',
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
                     jsonb_build_array(ss.model) AS unpriced_models,
                     ${excludesUtilitySql('ss')} AS excludes_utility
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
          costExcludesUtilityCalls: 'excludes_utility',
          subagentCostFromOtel: 'flag',
        },
        strict: true,
      },
    },
    ...FR6_LIST_ROWS,
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
      // otelReason= (2026-10-30 otel-shared-receiver): in R1 only s02 (no OTEL data, reported
      // none / project-only) is kept; s01 and s04 have OTEL rows.
      id: 'F17-list-otel-reason',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { otelReason: 'project-only' },
      expect: { status: 200, minRows: 1 },
      read: {
        sql: OTEL_REASON_ROOTS_SQL,
        args: ['@R1.id', 'project-only'],
        shape: 'array',
        fields: { sessionId: 'session_id' },
      },
    },
    {
      // no-status: R1 has no root without OTEL data and without a report (s02 reported one),
      // so the list is empty although R1 lists three roots.
      id: 'F17-list-otel-reason-no-status',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { otelReason: 'no-status' },
      expect: { status: 200 },
      read: {
        sql: OTEL_REASON_ROOTS_SQL,
        args: ['@R1.id', 'no-status'],
        shape: 'array',
        fields: { sessionId: 'session_id' },
      },
    },
    {
      // An unknown reason is refused like the other enum filters.
      id: 'F17-list-otel-reason-unknown',
      route: 'GET /api/v1/repositories/:repoId/sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { otelReason: 'galaxy' },
      expect: { status: 400 },
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
      // 2026-11-24 otel-session-tags: the root's `session_tags`, each pair once (s01 holds
      // jira=ARR-1 under both sources), sorted by key then value.
      read: {
        sql: `SELECT DISTINCT st.key, st.value FROM session_tags st
               WHERE st.session_id = $1
               ORDER BY st.key, st.value`,
        args: ['@s01.id'],
        shape: 'array',
        fields: { key: 'key', value: 'value' },
        strict: true,
      },
    },
    ...TAG_ROWS,
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
    // The child w1-s03 is reported as a sub-agent with its own token totals, on `/logs`,
    // `/logs/delta` (no cursor) and the parts manifest alike.
    ...SUBAGENT_STATS_ROUTES.map(
      ([name, route]): ContractCase => ({
        id: `F17-session-${name}-subagent-stats`,
        route,
        actor: 'owner',
        params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
        expect: { status: 200 },
        read: S03_SUBAGENT_STATS_READ,
      }),
    ),
    {
      // Sub-agent `.meta.json` labels (2026-10-21 workflow-agent-meta-labels, FR-3): every
      // `subagents[]` entry carries its session's `agentDescription` / `workflowPhase` (s03 is
      // seeded with 'contract-desc' / 'Implement').
      id: 'F17-session-logs-subagent-meta',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      // The oracle keeps only rows with the seeded values, so a server that drops them fails.
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `WITH RECURSIVE tree AS (
                SELECT s.id, s.session_id FROM sessions s WHERE s.id = $1
                UNION ALL
                SELECT c.id, c.session_id FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
              )
              SELECT s.session_id, s.parent_session_id, s.agent_description, s.workflow_phase
                FROM tree t
                JOIN sessions s ON s.id = t.id
                JOIN logs l ON l.session_id = s.id AND l.log_type = 'claude-subagent'
               WHERE s.id <> $1
                 AND s.agent_description = 'contract-desc'
                 AND s.workflow_phase = 'Implement'
               ORDER BY s.session_id`,
        args: ['@s02.id'],
        shape: 'array',
        path: 'subagents',
        sortBy: 'sessionId',
        fields: {
          sessionId: 'session_id',
          parentSessionId: 'parent_session_id',
          agentDescription: 'agent_description',
          workflowPhase: 'workflow_phase',
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
      // Session Map delta (2026-11-01 session-map-tab, DD-4..8): with no cursor the answer is a
      // full snapshot — the root's artisyn and claude bodies, element for element.
      id: 'F17-session-logs-delta',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: {
        status: 200,
        bodyMatches: { reload: false, subagentAppends: [], newSubagents: [] },
      },
      read: {
        sql: `SELECT coalesce((SELECT body FROM logs WHERE session_id = $1 AND log_type = 'artisyn'),
                              '[]'::jsonb) AS artisyn,
                     (SELECT body FROM logs WHERE session_id = $1 AND log_type = 'claude') AS claude`,
        args: ['@s04.id'],
        shape: 'object',
        fields: {
          rootArtisynLines: { col: 'artisyn', as: 'json' },
          rootClaudeLines: { col: 'claude', as: 'json' },
        },
      },
    },
    {
      // A descendant contributes only its claude-subagent row (the /logs rule): `newSubagents`
      // is every such row of s02's tree with its linkage, ordered by session id.
      id: 'F17-session-logs-delta-subagents',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        bodyMatches: { reload: false, subagentAppends: [] },
      },
      read: {
        sql: `WITH RECURSIVE tree AS (
                SELECT s.id, s.session_id FROM sessions s WHERE s.id = $1
                UNION ALL
                SELECT c.id, c.session_id FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
              )
              SELECT s.session_id, s.parent_session_id, s.workflow_run_id,
                     s.agent_description, s.workflow_phase, l.body AS logs
                FROM tree t
                JOIN sessions s ON s.id = t.id
                JOIN logs l ON l.session_id = s.id AND l.log_type = 'claude-subagent'
               WHERE s.id <> $1
               ORDER BY s.session_id`,
        args: ['@s02.id'],
        shape: 'array',
        path: 'newSubagents',
        fields: {
          sessionId: 'session_id',
          parentSessionId: 'parent_session_id',
          workflowRunId: 'workflow_run_id',
          agentDescription: 'agent_description',
          workflowPhase: 'workflow_phase',
          logs: { col: 'logs', as: 'json' },
        },
        strict: true,
      },
    },
    ...FR6_LOGS_ROWS,
    {
      // DD-15 (2026-10-21 workflow-agent-meta-labels): the cursor already holds all of s03's
      // lines, but under an older `updated_at` — what a re-upload of the same body (now carrying
      // `.meta.json` labels) leaves behind. No new lines, yet s03 still comes back as a
      // `subagentAppends` entry with `lines: []` and its meta, so an open Session Map gets the
      // labels live. The root rows are not in the cursor, so they come back in full.
      id: 'F17-session-logs-delta-meta-only-append',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { cursor: S03_HELD_CURSOR },
      expect: {
        status: 200,
        minRows: 1,
        bodyMatches: { reload: false, newSubagents: [] },
      },
      read: {
        sql: `SELECT s.session_id, '[]'::jsonb AS lines, s.agent_description, s.workflow_phase
                FROM sessions s
               WHERE s.id = $1 AND s.agent_description IS NOT NULL`,
        args: ['@s03.id'],
        shape: 'array',
        path: 'subagentAppends',
        fields: {
          sessionId: 'session_id',
          lines: { col: 'lines', as: 'json' },
          agentDescription: 'agent_description',
          workflowPhase: 'workflow_phase',
        },
        strict: true,
      },
    },
    {
      id: 'F17-session-logs-delta-outsider',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: { status: 403 },
    },
    {
      // DD-4: an undecodable cursor is treated as empty — a full snapshot, never a 400.
      id: 'F17-session-logs-delta-bad-cursor',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      query: { cursor: 'not-a-cursor!!' },
      expect: { status: 200, bodyMatches: { reload: false } },
      read: {
        sql: `SELECT body AS claude FROM logs WHERE session_id = $1 AND log_type = 'claude'`,
        args: ['@s04.id'],
        shape: 'object',
        fields: { rootClaudeLines: { col: 'claude', as: 'json' } },
      },
    },
    // ---------------------------------------------------------------------------------------
    // Session-log parts (2026-11-23 session-logs-streaming, DD-11/DD-12/DD-14): the manifest
    // of a tree's stored log blobs, then one blob's body.
    {
      // s02's tree: the root claude and artisyn parts, then s03's claude-subagent part with its
      // `.meta.json` labels. No upload of the tree waits in the queue: not lagging.
      id: 'F17-session-log-parts',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        minRows: 3,
        headers: GZIPPED,
        bodyMatches: { derivedLagging: false },
      },
      read: PARTS_MANIFEST_READ,
    },
    {
      // DD-10: `Accept-Encoding: identity` gets the same decoded manifest uncompressed.
      id: 'F17-session-log-parts-identity',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      headers: { 'Accept-Encoding': 'identity' },
      expect: {
        status: 200,
        minRows: 3,
        headers: IDENTITY,
        bodyMatches: { derivedLagging: false },
      },
      read: PARTS_MANIFEST_READ,
    },
    {
      // The manifest's top-level shape: exactly the small figures `/logs` carries plus `parts`,
      // `derivedLagging`, `liveness` and `serverTime` (their values depend on OTEL rows other
      // cases write to the shared schema; @S-OTEL-01 checks them). s04 has no sub-agent and no
      // workflow run; its `harnessSnapshot` is the bound row's body, as on `/logs`.
      id: 'F17-session-log-parts-shape',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: {
        status: 200,
        bodyMatches: {
          subagentStats: {},
          workflows: [],
          derivedLagging: false,
        },
      },
      read: {
        sql: `SELECT body AS harness_snapshot FROM harness_snapshots
               WHERE user_id = $1 AND snapshot_id = $2`,
        args: ['@owner.id', '@harnessSnapshotId'],
        shape: 'object',
        fields: { harnessSnapshot: { col: 'harness_snapshot', as: 'json' } },
        ignore: [
          'parts',
          'subagentStats',
          'rootStats',
          'workflows',
          'turnEndAdvisor',
          'sessionAttribution',
          'derivedLagging',
          'liveness',
          'serverTime',
          // Compared by F17-session-log-parts-tags.
          'tags',
          'tagNoise',
        ],
        strict: true,
      },
    },
    {
      id: 'F17-session-log-parts-outsider',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
      expect: { status: 403 },
    },
    {
      // The manifest shares `/logs`' 422 for a root claude log whose body is NULL — a branch no
      // fixture can reach: `logs.body` is `jsonb NOT NULL`, and `/logs` has no 422 row either.
      id: 'F17-session-log-parts-null-body',
      route: 'GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts',
      kind: 'excluded',
      reason:
        'logs.body is NOT NULL: a root claude log with a NULL body cannot exist, so the 422 branch is unreachable',
    },
    {
      // A part's body is the stored log, element for element (served from the gzip copy or
      // from body::text — the client sees the same JSON array either way).
      id: 'F17-session-log-part-body',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s04.sessionId',
        partSessionId: '@s04.sessionId',
        logType: 'claude',
      },
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT e.line
                FROM logs l CROSS JOIN jsonb_array_elements(l.body) WITH ORDINALITY AS e(line, n)
               WHERE l.session_id = $1 AND l.log_type = 'claude'
               ORDER BY e.n`,
        args: ['@s04.id'],
        shape: 'array',
        scalar: { col: 'line', as: 'json' },
      },
    },
    {
      id: 'F17-session-log-part-body-artisyn',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s04.sessionId',
        partSessionId: '@s04.sessionId',
        logType: 'artisyn',
      },
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT e.line
                FROM logs l CROSS JOIN jsonb_array_elements(l.body) WITH ORDINALITY AS e(line, n)
               WHERE l.session_id = $1 AND l.log_type = 'artisyn'
               ORDER BY e.n`,
        args: ['@s04.id'],
        shape: 'array',
        scalar: { col: 'line', as: 'json' },
      },
    },
    {
      // A sub-agent's part is addressed under its root: s03's claude-subagent log in s02's tree.
      id: 'F17-session-log-part-body-subagent',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s02.sessionId',
        partSessionId: '@s03.sessionId',
        logType: 'claude-subagent',
      },
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT e.line
                FROM logs l CROSS JOIN jsonb_array_elements(l.body) WITH ORDINALITY AS e(line, n)
               WHERE l.session_id = $1 AND l.log_type = 'claude-subagent'
               ORDER BY e.n`,
        args: ['@s03.id'],
        shape: 'array',
        scalar: { col: 'line', as: 'json' },
      },
    },
    {
      // DD-12: the ETag is the part's revision; the world pins `body_rev` to the log id
      // (fixtures/world-v1.sql.ts), so a matching `If-None-Match` answers 304 with no body.
      id: 'F17-session-log-part-body-not-modified',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s04.sessionId',
        partSessionId: '@s04.sessionId',
        logType: 'claude',
      },
      headers: { 'If-None-Match': `"${WORLD_V1_LOG_IDS.s04.claude}"` },
      expect: { status: 304 },
      noDb: true,
    },
    {
      // s01 is a root of its own, outside s04's tree.
      id: 'F17-session-log-part-body-outside-tree',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s04.sessionId',
        partSessionId: '@s01.sessionId',
        logType: 'claude',
      },
      expect: { status: 404 },
    },
    {
      // s03's own `claude` row is not a part of s02's tree (a descendant contributes only its
      // claude-subagent row): a logType that does not match the node is 404 too.
      id: 'F17-session-log-part-body-wrong-type',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s02.sessionId',
        partSessionId: '@s03.sessionId',
        logType: 'claude',
      },
      expect: { status: 404 },
    },
    {
      id: 'F17-session-log-part-body-bad-type',
      route: PART_ROUTE,
      actor: 'owner',
      params: {
        repoId: '@R1.id',
        sessionId: '@s04.sessionId',
        partSessionId: '@s04.sessionId',
        logType: 'claude-otel',
      },
      expect: { status: 400 },
    },
    {
      id: 'F17-session-log-part-body-outsider',
      route: PART_ROUTE,
      actor: 'outsider',
      params: {
        repoId: '@R1.id',
        sessionId: '@s04.sessionId',
        partSessionId: '@s04.sessionId',
        logType: 'claude',
      },
      expect: { status: 403 },
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
