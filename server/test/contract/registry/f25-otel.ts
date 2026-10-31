// F25 — OTEL tabs (2026-10-30 otel-tabs-traces): the hook's realtime ingest
// (`POST /api/v2/otel-realtime`, API key) and the three read routes of the repository, session and
// team OTEL tabs (cookie session).
//
// World (fixtures/world-v1.sql.ts, `otelStatements`): projected OTEL facts for the owner's s01
// (R1; a main call 0.70 USD confirmed by both channels, a hidden prompt_suggestion call 0.02 USD,
// one interaction trace and one standalone llm_request trace, seq 3) and s04 (R1 + Rdesert, main
// 0.50 USD), the member's s06 (R1member, 0.30 USD) and the owner's s11 (Rdesert only, no git
// branch, hidden 0.10 USD). T2 (restricted) links R1's URL and Rdesert; its members are the owner,
// the member (plain, disclosure not acknowledged), the manager and the trainer (ADLC trainer only).
// The projection drain is parked for the run (setup/global-setup.ts).
//
// The SQL below is written from the documented rules, not copied from otel-facts-read.sql.ts:
// one sub-query per metric over the scoped roots' non-zero buckets of the window.
import type {
  CallCase,
  ContractCase,
  ContractFamily,
  ReadSpec,
} from '../types';

const R1_URL = 'https://github.com/arrakis/spice-harvester';

/** January 2026, the world's month: 31 days -> the `auto` interval is `1d`. */
const JAN = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
};

// -------------------------------------------------------------------------------------------
// Scoped roots

/** Personal view: user `$2`'s roots whose artisyn log is linked to repository `$1`. */
const PERSONAL_ROOTS = `
  SELECT DISTINCT l.session_id AS id
    FROM logs l
    JOIN log_repositories lr ON lr.log_id = l.id
    JOIN sessions s ON s.id = l.session_id
   WHERE l.log_type = 'artisyn' AND lr.repo_id = $1 AND l.user_id = $2 AND NOT s.deleted`;

/**
 * Team view of team `$1`: roots whose artisyn log is linked to a team member's repository of a
 * URL the team links. `acknowledgedOnly` = a restricted team seen by its owner or a manager: only
 * members who acknowledged the disclosure. `urlParam` narrows to one URL.
 */
function teamRoots(acknowledgedOnly: boolean, urlParam?: string): string {
  return `
  SELECT DISTINCT l.session_id AS id
    FROM logs l
    JOIN log_repositories lr ON lr.log_id = l.id
    JOIN repositories r ON r.id = lr.repo_id
    JOIN sessions s ON s.id = l.session_id
   WHERE l.log_type = 'artisyn' AND NOT s.deleted
     AND r.user_id IN (SELECT user_id FROM team_members WHERE team_id = $1)
     AND r.repo_url IN (SELECT repo_url FROM team_repositories WHERE team_id = $1)
     ${urlParam ? `AND r.repo_url = ${urlParam}` : ''}
     ${
       acknowledgedOnly
         ? `AND l.user_id IN (SELECT user_id FROM team_members
                               WHERE team_id = $1 AND disclosure_acknowledged_at IS NOT NULL)`
         : ''
     }`;
}

/** `WITH roots AS (…), b AS (…)`: the roots' non-zero buckets in `[from, to)`. */
function bucketsOf(roots: string, from: string, to: string): string {
  return `WITH roots AS (${roots}),
  b AS (SELECT * FROM otel_cost_buckets
         WHERE session_id IN (SELECT id FROM roots)
           AND bucket_start >= ${from}::timestamptz AND bucket_start < ${to}::timestamptz
           AND calls <> 0)`;
}

// -------------------------------------------------------------------------------------------
// KPIs

function kpiSql(roots: string, from: string, to: string): string {
  return `${bucketsOf(roots, from, to)}
  SELECT
    (SELECT coalesce(sum(cost_usd_micros), 0) FROM b)::text AS total,
    (SELECT count(DISTINCT (bucket_start AT TIME ZONE 'UTC')::date) FROM b) AS days,
    (SELECT (sum(cost_usd_micros)::bigint / nullif(count(DISTINCT (bucket_start AT TIME ZONE 'UTC')::date), 0))::text
       FROM b) AS per_day,
    (SELECT (sum(cost_usd_micros)::bigint / nullif(count(DISTINCT session_id), 0))::text FROM b) AS per_session,
    (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c))::bigint::text
       FROM (SELECT sum(cost_usd_micros) AS c FROM b GROUP BY session_id) x) AS median,
    (SELECT coalesce(sum(calls), 0) FROM b) AS calls,
    (SELECT count(DISTINCT model) FROM b WHERE model <> '') AS models,
    (SELECT coalesce(sum(cost_usd_micros), 0) FROM b WHERE structure = 'hidden')::text AS hidden,
    (SELECT coalesce(sum(calls), 0) FROM b WHERE structure = 'hidden') AS hidden_calls,
    (SELECT coalesce((SELECT sum(cost_usd_micros) FROM b WHERE structure = 'hidden')::float8
                     / nullif((SELECT sum(cost_usd_micros) FROM b), 0), 0)) AS hidden_share,
    (SELECT count(DISTINCT session_id) FROM b) AS sessions,
    (SELECT count(DISTINCT user_id) FROM b) AS users,
    (SELECT (sum(cost_usd_micros)::bigint / nullif(count(DISTINCT user_id), 0))::text FROM b) AS per_user,
    (SELECT coalesce(sum(input_tokens), 0) FROM b)::text AS input_tokens,
    (SELECT coalesce(sum(output_tokens), 0) FROM b)::text AS output_tokens,
    (SELECT coalesce(sum(cache_read_tokens), 0) FROM b)::text AS cache_read_tokens,
    (SELECT coalesce(sum(cache_write_tokens), 0) FROM b)::text AS cache_write_tokens`;
}

const KPI_FIELDS: ReadSpec['fields'] = {
  totalCostUsdMicros: 'total',
  activeDays: { col: 'days', as: 'number' },
  perDayCostUsdMicros: 'per_day',
  perSessionCostUsdMicros: 'per_session',
  medianSessionCostUsdMicros: 'median',
  apiCalls: { col: 'calls', as: 'number' },
  modelCount: { col: 'models', as: 'number' },
  hiddenCostUsdMicros: 'hidden',
  hiddenCalls: { col: 'hidden_calls', as: 'number' },
  hiddenShare: { col: 'hidden_share', as: 'numeric', tol: 1e-9 },
  sessions: { col: 'sessions', as: 'number' },
  users: { col: 'users', as: 'number' },
  perUserCostUsdMicros: 'per_user',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_tokens',
  cacheWriteTokens: 'cache_write_tokens',
};

// -------------------------------------------------------------------------------------------
// OTEL coverage (2026-10-30 otel-shared-receiver, DD-29)

/**
 * The coverage of `roots` over the window `[from, to)`: the roots whose artisyn log was active
 * in it (started before `to`, ended — or, still open, started — at or after `from`). A root is
 * covered when it has an `otel_session_state` row or a reported `otel_state` of `ok` / `partial`;
 * the others are counted per reported reason (`no-status` without one), most frequent first.
 */
function coverageSql(roots: string, from: string, to: string): string {
  return `WITH roots AS (${roots}),
  active AS (
    SELECT r.id FROM roots r
     WHERE EXISTS (SELECT 1 FROM logs al
                    WHERE al.session_id = r.id AND al.log_type = 'artisyn'
                      AND al.start_time < ${to}::timestamptz
                      AND coalesce(al.end_time, al.start_time) >= ${from}::timestamptz)),
  marked AS (
    SELECT a.id,
           (a.id IN (SELECT session_id FROM otel_session_state)
            OR a.id IN (SELECT session_id FROM session_stats
                         WHERE otel_state = 'ok' OR otel_state = 'partial')) AS covered,
           coalesce((SELECT otel_reason FROM session_stats WHERE session_id = a.id),
                    'no-status') AS reason
      FROM active a)
  SELECT
    (SELECT count(*) FROM marked WHERE covered) AS otel_sessions,
    (SELECT count(*) FROM marked) AS total_sessions,
    (SELECT count(DISTINCT l.user_id)
       FROM marked m JOIN logs l ON l.session_id = m.id AND l.log_type = 'artisyn'
      WHERE m.covered) AS otel_users,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'count', x.n)
                               ORDER BY x.n DESC, x.reason), '[]'::jsonb)
       FROM (SELECT reason, count(*)::int AS n FROM marked WHERE NOT covered GROUP BY reason) x)
      AS reasons`;
}

const COVERAGE_FIELDS: ReadSpec['fields'] = {
  otelSessions: { col: 'otel_sessions', as: 'number' },
  totalSessions: { col: 'total_sessions', as: 'number' },
  otelUsers: { col: 'otel_users', as: 'number' },
  reasons: { col: 'reasons', as: 'json' },
};

// -------------------------------------------------------------------------------------------
// Cost flow and sessions table

/** One row per (model, user, branch of the root's artisyn log), most expensive first. */
function flowSql(roots: string, from: string, to: string): string {
  return `${bucketsOf(roots, from, to)}
  SELECT nullif(b.model, '') AS model, u.email, al.git_branch AS branch,
         sum(b.cost_usd_micros)::text AS cost, sum(b.calls) AS calls,
         count(DISTINCT b.session_id) AS sessions
    FROM b
    JOIN logs al ON al.session_id = b.session_id AND al.log_type = 'artisyn'
    JOIN users u ON u.id = al.user_id
   GROUP BY 1, 2, 3
   ORDER BY sum(b.cost_usd_micros) DESC`;
}

const FLOW_FIELDS: ReadSpec['fields'] = {
  model: 'model',
  userEmail: 'email',
  branch: 'branch',
  repository: { col: 'repository', as: 'raw' },
  other: { col: 'other', as: 'raw' },
  costUsdMicros: 'cost',
  calls: { col: 'calls', as: 'number' },
  sessions: { col: 'sessions', as: 'number' },
};

/** The flow SQL plus the two constant columns of the repository route. */
function repoFlowSql(roots: string, from: string, to: string): string {
  return `SELECT f.*, NULL::text AS repository, false AS other
            FROM (${flowSql(roots, from, to)}) f`;
}

/**
 * The sessions table: one row per root with buckets, newest artisyn start first. `masked` =
 * the caller is a manager of a restricted team (`team-no-prompts`) viewing another member.
 */
function sessionsSql(
  roots: string,
  from: string,
  to: string,
  masked: boolean,
): string {
  return `${bucketsOf(roots, from, to)},
  ps AS (SELECT session_id, sum(calls) AS calls, sum(cost_usd_micros)::text AS cost,
                coalesce(sum(cost_usd_micros) FILTER (WHERE structure = 'hidden'), 0)::text AS hidden,
                max(nullif(cc_version, '')) AS cc
           FROM b GROUP BY session_id)
  SELECT s.session_id AS sid, al.start_time,
         ${masked ? 'NULL::text' : 'al.first_prompt'} AS first_prompt,
         u.email, ps.cc, ps.calls, ps.cost, ps.hidden,
         coalesce(st.has_spans, false) AS has_spans, false AS live,
         (SELECT count(*) FROM otel_calls c
           WHERE c.session_id = ps.session_id AND st.rt_last_at IS NOT NULL
             AND (c.source_mask & 2) = 0) AS unconfirmed
    FROM ps
    JOIN sessions s ON s.id = ps.session_id
    JOIN logs al ON al.session_id = ps.session_id AND al.log_type = 'artisyn'
    JOIN users u ON u.id = al.user_id
    LEFT JOIN otel_session_state st ON st.session_id = ps.session_id
   ORDER BY al.start_time DESC`;
}

const SESSION_FIELDS: ReadSpec['fields'] = {
  sessionId: 'sid',
  startedAt: { col: 'start_time', as: 'iso' },
  firstPrompt: { col: 'first_prompt', as: 'raw' },
  userEmail: 'email',
  ccVersion: 'cc',
  calls: { col: 'calls', as: 'number' },
  costUsdMicros: 'cost',
  hiddenCostUsdMicros: 'hidden',
  hasTraces: 'has_spans',
  live: 'live',
  unconfirmedCalls: { col: 'unconfirmed', as: 'number' },
};

// -------------------------------------------------------------------------------------------
// Session route

/** s01's calls (`$1` = sessions.id), all or with `seq > $2`, in the route's order. */
function callsSql(delta: boolean): string {
  return `SELECT call_key, request_id, query_source, model, event_time, structure, provisional,
                 (source_mask & 2) <> 0 AS confirmed, cost_usd_micros::text AS cost,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                 agent_id, prompt_id, change_kind
            FROM otel_calls
           WHERE session_id = $1 ${delta ? 'AND seq > $2' : ''}
           ORDER BY event_time, call_key`;
}

const CALL_FIELDS: ReadSpec['fields'] = {
  callKey: 'call_key',
  requestId: 'request_id',
  querySource: 'query_source',
  model: 'model',
  eventTime: { col: 'event_time', as: 'iso' },
  structure: 'structure',
  provisional: 'provisional',
  confirmed: 'confirmed',
  costUsdMicros: 'cost',
  inputTokens: { col: 'input_tokens', as: 'number' },
  outputTokens: { col: 'output_tokens', as: 'number' },
  cacheReadTokens: { col: 'cache_read_tokens', as: 'number' },
  cacheWriteTokens: { col: 'cache_write_tokens', as: 'number' },
  agentId: 'agent_id',
  promptId: 'prompt_id',
  changeKind: 'change_kind',
};

/**
 * s01's spans (`$1` = sessions.id) with the hidden flag of the call their request id names;
 * a delta keeps spans changed after `$2` and spans whose call changed after `$2`.
 */
function spansSql(delta: boolean, masked: boolean): string {
  return `SELECT sp.trace_id, sp.span_id, sp.parent_span_id, sp.name, sp.start_time, sp.end_time,
                 sp.request_id, sp.agent_id, sp.query_source, sp.context,
                 sp.cost_usd_micros::text AS cost, sp.rollup_cost_usd_micros::text AS rollup,
                 CASE WHEN c.call_key IS NULL THEN NULL ELSE c.structure = 'hidden' END AS hidden,
                 (sp.source_mask & 2) <> 0 AS confirmed,
                 ${masked ? 'NULL::jsonb' : 'sp.attributes'} AS attributes, sp.change_kind
            FROM otel_spans sp
            LEFT JOIN otel_calls c ON c.session_id = sp.session_id AND c.request_id = sp.request_id
           WHERE sp.session_id = $1 ${delta ? 'AND (sp.seq > $2 OR c.seq > $2)' : ''}
           ORDER BY sp.start_time, sp.trace_id, sp.span_id`;
}

const SPAN_FIELDS: ReadSpec['fields'] = {
  traceId: 'trace_id',
  spanId: 'span_id',
  parentSpanId: 'parent_span_id',
  name: 'name',
  startTime: { col: 'start_time', as: 'iso' },
  endTime: { col: 'end_time', as: 'iso?' },
  requestId: 'request_id',
  agentId: 'agent_id',
  querySource: 'query_source',
  context: 'context',
  costUsdMicros: 'cost',
  rollupCostUsdMicros: 'rollup',
  hidden: { col: 'hidden', as: 'raw' },
  confirmed: 'confirmed',
  attributes: { col: 'attributes', as: 'json' },
  changeKind: 'change_kind',
};

/** s01's status, hand-computed from its state row (DD-14, DD-15); `masked` per DD-22. */
function s01Status(masked: boolean) {
  return {
    hasOtel: true,
    hasSpans: true,
    // The world's dates are long past OTEL_SESSION_ENDED_MS.
    live: false,
    // rt_last_at is set -> realtime was on.
    slowUpdates: false,
    slowReason: null,
    otelHookVersion: '2.29.0',
    attributesMasked: masked,
    // 2026-10-30 otel-shared-receiver DD-28 / DD-30: s01's hook never reported an
    // `otel-status` event (no session_stats otel columns) and s01 has OTEL calls.
    otelStatus: null,
    costExcludesUtilityCalls: false,
    realtime: {
      active: false,
      // Every s01 call and span carries the chunk bit (2).
      unconfirmedCalls: 0,
      unconfirmedSpans: 0,
      lastRealtimeAt: '2026-01-10T10:06:05.000Z',
      lastChunkAt: '2026-01-10T10:10:00.000Z',
      // rt_last_at - chunk_last_at < 0, far below OTEL_CHUNK_DELAY_MS.
      chunkDelayed: false,
      gap: false,
    },
  };
}

/**
 * The session route's `status.otelStatus` and `status.costExcludesUtilityCalls`
 * (2026-10-30 otel-shared-receiver, DD-28, DD-30) for root `$1` (a `sessions.id`): the stored
 * columns as the DTO (null when the hook never reported), and the marker = no OTEL API call in
 * either table and a state other than ok.
 */
const SESSION_OTEL_STATUS_SQL = `
  SELECT CASE WHEN ss.otel_state IS NULL AND ss.otel_status IS NULL THEN NULL
              ELSE jsonb_build_object(
                     'state', ss.otel_state,
                     'reason', ss.otel_reason,
                     'detail', ss.otel_status -> 'detail',
                     'received', ss.otel_status -> 'received',
                     'claudeVersion', ss.otel_status -> 'claudeVersion',
                     'hookVersion', ss.otel_status -> 'hookVersion',
                     'receiverVersion', ss.otel_status -> 'receiverVersion',
                     'forward', ss.otel_status -> 'forward')
         END AS otel_status,
         (SELECT count(*) FROM otel_api_calls a WHERE a.session_id = s.id) = 0
           AND (SELECT count(*) FROM otel_calls c WHERE c.session_id = s.id) = 0
           AND coalesce(ss.otel_state, '') <> 'ok' AS excludes
    FROM sessions s
    LEFT JOIN session_stats ss ON ss.session_id = s.id
   WHERE s.id = $1`;

const SESSION_OTEL_STATUS_FIELDS: ReadSpec['fields'] = {
  otelStatus: { col: 'otel_status', as: 'json' },
  costExcludesUtilityCalls: 'excludes',
};

/** A session with no OTEL data, or outside the caller's scope (never 404). */
const EMPTY_SESSION = {
  cursor: 'v1.0',
  full: true,
  interval: '5m',
  buckets: [],
  calls: [],
  spans: [],
  kpis: null,
  querySources: null,
};

// -------------------------------------------------------------------------------------------
// Realtime ingest

const RT_SESSION = 'w1-rt-new';

/** One `claude_code.api_request` line as the hook's receiver writes it. */
function apiRequestLine(a: {
  requestId: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  costMicros: number;
  at: string;
  nanos: string;
  ccVersion: string;
  promptId?: string;
}) {
  const s = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  const i = (key: string, value: number) => ({
    key,
    value: { intValue: String(value) },
  });
  return {
    signal: 'logs',
    receivedAt: a.at,
    hookVersion: '2.29.0',
    resource: { 'service.version': a.ccVersion },
    scope: { name: 'com.anthropic.claude_code.events' },
    record: {
      timeUnixNano: a.nanos,
      body: { stringValue: 'claude_code.api_request' },
      attributes: [
        s('event.timestamp', a.at),
        s('request_id', a.requestId),
        s('query_source', 'repl_main_thread'),
        s('model', a.model),
        i('input_tokens', a.input),
        i('output_tokens', a.output),
        i('cache_read_tokens', a.cacheRead ?? 0),
        i('cache_creation_tokens', a.cacheWrite ?? 0),
        i('cost_usd_micros', a.costMicros),
        ...(a.promptId ? [s('prompt.id', a.promptId)] : []),
      ],
    },
  };
}

const RT_CALL_LINE = apiRequestLine({
  requestId: 'req_rt_1',
  model: 'world-model-a',
  input: 1000,
  output: 100,
  costMicros: 4000,
  at: '2026-01-20T10:00:00.000Z',
  nanos: '1768903200000000000',
  ccVersion: '2.1.99',
});

const RT_SPAN_LINE = {
  signal: 'spans',
  receivedAt: '2026-01-20T10:00:01.000Z',
  hookVersion: '2.29.0',
  resource: { 'service.version': '2.1.99' },
  record: {
    traceId: 'rttrace1',
    spanId: 'rtspan1',
    parentSpanId: '',
    name: 'claude_code.llm_request',
    startTimeUnixNano: '1768903198000000000',
    endTimeUnixNano: '1768903200000000000',
    attributes: [{ key: 'request_id', value: { stringValue: 'req_rt_1' } }],
  },
};

/** s01's realtime call `req_s01_1` exactly as the world stores it (a replayed batch). */
const S01_CALL_LINE = apiRequestLine({
  requestId: 'req_s01_1',
  model: 'world-model-a',
  input: 400_000,
  output: 100_000,
  cacheWrite: 100_000,
  costMicros: 700_000,
  at: '2026-01-10T10:05:00.000Z',
  nanos: '1768039500000000000',
  ccVersion: '2.1.99',
  promptId: 's01-p1',
});

const OTEL_TABLES = [
  'otel_session_state',
  'otel_calls',
  'otel_spans',
  'otel_cost_buckets',
  'otel_reclass_queue',
];

const RT_ROOT = `(SELECT id FROM sessions WHERE session_id = '${RT_SESSION}')`;

// -------------------------------------------------------------------------------------------
// Rows

const realtimeRows: ContractCase[] = [
  {
    // A first batch for an unknown session: the sessions row, the state row (owned by the
    // caller), one call (provisional, main by the transcript fallback), one span costed from
    // that call, one 5-minute bucket.
    id: 'F25-realtime-accepted',
    route: 'POST /api/v2/otel-realtime',
    actor: 'authorKey',
    body: {
      sessionId: RT_SESSION,
      hookVersion: '2.29.0',
      receiverId: 'w1-rt-recv',
      batchSeq: 1,
      droppedLines: 0,
      lines: [RT_CALL_LINE, RT_SPAN_LINE],
    },
    expect: {
      status: 200,
      bodyMatches: { accepted: { calls: 1, spans: 1 }, minIntervalMs: 5000 },
    },
    write: {
      watch: ['sessions', ...OTEL_TABLES],
      delta: {
        inserted: [
          {
            table: 'sessions',
            where: `session_id = '${RT_SESSION}'`,
            check: ['deleted = false', 'parent_session_id IS NULL'],
          },
          {
            table: 'otel_session_state',
            where: `session_id = ${RT_ROOT}`,
            check: [
              'user_id = @author.id',
              `rt_receiver_id = 'w1-rt-recv'`,
              'rt_batch_seq = 1',
              'rt_last_at IS NOT NULL',
              'rt_gap_at IS NULL',
              'chunk_last_at IS NULL',
              `otel_hook_version = '2.29.0'`,
              'has_spans',
              'has_provisional',
              'transcript_seq IS NULL',
              `$cursor = 'v1.' || seq`,
            ],
          },
          {
            table: 'otel_calls',
            where: `session_id = ${RT_ROOT}`,
            check: [
              `call_key = 'req_rt_1'`,
              `structure = 'main'`,
              'provisional',
              'source_mask = 1',
              `change_kind = 'new'`,
              'cost_usd_micros = 4000',
              'input_tokens = 1000 AND output_tokens = 100',
              `event_time = '2026-01-20T10:00:00Z'`,
              `claude_code_version = '2.1.99'`,
            ],
          },
          {
            table: 'otel_spans',
            where: `session_id = ${RT_ROOT}`,
            check: [
              `span_id = 'rtspan1'`,
              'parent_span_id IS NULL',
              `request_id = 'req_rt_1'`,
              'cost_usd_micros = 4000',
              'rollup_cost_usd_micros = 4000',
              'source_mask = 1',
            ],
          },
          {
            table: 'otel_cost_buckets',
            where: `session_id = ${RT_ROOT}`,
            check: [
              `bucket_start = '2026-01-20T10:00:00Z'`,
              'user_id = @author.id',
              `structure = 'main'`,
              'calls = 1',
              'cost_usd_micros = 4000',
            ],
          },
        ],
      },
    },
  },
  {
    // DD-14: the same receiver's batch 4 again (rt_batch_seq is already 4) is a replay: the
    // call is upserted idempotently, no gap, and every total stays as it was.
    id: 'F25-realtime-replay',
    route: 'POST /api/v2/otel-realtime',
    actor: 'ownerKey',
    body: {
      sessionId: '@s01.sessionId',
      hookVersion: '2.29.0',
      receiverId: 'w1-recv-01',
      batchSeq: 4,
      droppedLines: 0,
      lines: [S01_CALL_LINE],
    },
    expect: { status: 200, bodyMatches: { minIntervalMs: 5000 } },
    write: {
      watch: ['sessions', ...OTEL_TABLES],
      delta: {
        updated: [
          {
            table: 'otel_session_state',
            where: 'session_id = @s01.id',
            changed: { rt_batch_seq: 4, rt_gap_at: null },
            anyChange: ['rt_last_at', 'seq'],
          },
        ],
      },
      after: [
        `(SELECT sum(cost_usd_micros) = 720000 AND count(*) = 2
            FROM otel_calls WHERE session_id = @s01.id)`,
        `(SELECT sum(cost_usd_micros) = 720000 AND sum(calls) = 2
            FROM otel_cost_buckets WHERE session_id = @s01.id)`,
        `(SELECT rt_gap_at IS NULL FROM otel_session_state WHERE session_id = @s01.id)`,
      ],
    },
  },
  {
    // DD-25: a soft-deleted session never regrows OTEL rows — 200, nothing written.
    id: 'F25-realtime-deleted',
    route: 'POST /api/v2/otel-realtime',
    actor: 'ownerKey',
    body: {
      sessionId: '@s05.sessionId',
      hookVersion: '2.29.0',
      receiverId: 'w1-rt-recv',
      batchSeq: 1,
      droppedLines: 0,
      lines: [RT_CALL_LINE],
    },
    expect: {
      status: 200,
      bodyMatches: {
        accepted: { calls: 0, spans: 0 },
        ignored: 'deleted',
        minIntervalMs: 5000,
      },
    },
    noDb: true,
  },
  {
    // OTEL_REALTIME_MAX_LINES = 5000.
    id: 'F25-realtime-too-many-lines',
    route: 'POST /api/v2/otel-realtime',
    actor: 'authorKey',
    body: {
      sessionId: RT_SESSION,
      hookVersion: '2.29.0',
      receiverId: 'w1-rt-recv',
      batchSeq: 1,
      droppedLines: 0,
      lines: Array.from({ length: 5001 }, () => ({ signal: 'logs' })),
    },
    expect: { status: 400 },
  },
  {
    id: 'F25-realtime-no-key',
    route: 'POST /api/v2/otel-realtime',
    actor: 'anon',
    body: {
      sessionId: RT_SESSION,
      hookVersion: '2.29.0',
      receiverId: 'w1-rt-recv',
      batchSeq: 1,
      droppedLines: 0,
      lines: [RT_CALL_LINE],
    },
    expect: { status: 401 },
  },
  {
    // s01 belongs to the owner (its logs say so): another user's batch is refused.
    id: 'F25-realtime-foreign-session',
    route: 'POST /api/v2/otel-realtime',
    actor: 'memberKey',
    body: {
      sessionId: '@s01.sessionId',
      hookVersion: '2.29.0',
      receiverId: 'w1-rt-recv',
      batchSeq: 1,
      droppedLines: 0,
      lines: [RT_CALL_LINE],
    },
    expect: { status: 409 },
  },
  {
    // The shared hook body limit (HOOK_API_BODY_LIMIT = 1 MiB) answers before any parsing.
    id: 'F25-realtime-oversize',
    route: 'POST /api/v2/otel-realtime',
    actor: 'authorKey',
    body: {
      sessionId: RT_SESSION,
      hookVersion: '2.29.0',
      receiverId: 'w1-rt-recv',
      batchSeq: 1,
      droppedLines: 0,
      lines: [{ signal: 'logs', padding: 'x'.repeat(1_100_000) }],
    },
    expect: { status: 413 },
  },
];

const REPO_FACTS = 'GET /api/v1/repositories/:repoId/otel/facts' as const;

const repoRows: ContractCase[] = [
  {
    // Owner's personal view of R1 over January: s01 + s04 (s02 has no OTEL data).
    id: 'F25-repo-kpis',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: {
        interval: '1d',
        tz: 'UTC',
        hasOtel: true,
        hasOtelInPeriod: true,
        // R1's hook_version 2.20.0 < 2.29.0.
        slowUpdates: true,
        hookVersion: '2.20.0',
        // The previous 31 days hold no bucket.
        kpisPrev: null,
        realtime: {
          unconfirmedCalls: 0,
          realtimeSessions: 0,
          chunkDelayedSessions: 0,
          gapSessions: 0,
        },
        filterOptions: {
          models: ['world-model-a', 'world-model-b'],
          ccVersions: ['2.1.99', '2.1.98'],
        },
      },
    },
    read: {
      sql: kpiSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@R1.id', '@owner.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'kpis',
      fields: KPI_FIELDS,
      strict: true,
    },
  },
  {
    id: 'F25-repo-buckets',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...JAN, stackBy: 'structure' },
    expect: { status: 200, minRows: 3 },
    read: {
      sql: `${bucketsOf(PERSONAL_ROOTS, '$3', '$4')}
        SELECT date_trunc('day', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start,
               structure AS key, sum(calls) AS calls, sum(cost_usd_micros)::text AS cost,
               sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::text
                 AS tokens,
               (array_agg(change_kind ORDER BY seq DESC))[1] AS change_kind
          FROM b GROUP BY 1, 2 ORDER BY 1, 2`,
      args: ['@R1.id', '@owner.id', JAN.from, JAN.to],
      shape: 'array',
      path: 'buckets',
      fields: {
        start: { col: 'start', as: 'iso' },
        key: 'key',
        calls: { col: 'calls', as: 'number' },
        costUsdMicros: 'cost',
        tokens: 'tokens',
        changeKind: 'change_kind',
      },
      strict: true,
    },
  },
  {
    // DD-28: one flow per (model, user, branch); s01 is on `main`, s04 on `feature/sandworm`.
    id: 'F25-repo-flows',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...JAN },
    expect: { status: 200, minRows: 3 },
    read: {
      sql: repoFlowSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@R1.id', '@owner.id', JAN.from, JAN.to],
      shape: 'array',
      path: 'flows',
      fields: FLOW_FIELDS,
      strict: true,
    },
  },
  {
    // Rdesert holds s04 (feature/sandworm) and s11, whose artisyn log has no git branch: its
    // flow comes back with branch null (the client shows "(unknown)").
    id: 'F25-repo-flows-unknown-branch',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@Rdesert.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      minRows: 2,
      bodyMatches: { hookVersion: '2.29.0', slowUpdates: false },
    },
    read: {
      sql: repoFlowSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@Rdesert.id', '@owner.id', JAN.from, JAN.to],
      shape: 'array',
      path: 'flows',
      fields: FLOW_FIELDS,
      strict: true,
    },
  },
  {
    // DD-28: [Jan 11, Jan 13) holds s04; the previous window of equal length [Jan 9, Jan 11)
    // holds s01, returned as kpisPrev.
    id: 'F25-repo-kpis-prev',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { from: '2026-01-11T00:00:00.000Z', to: '2026-01-13T00:00:00.000Z' },
    expect: { status: 200, bodyMatches: { interval: '1h' } },
    read: {
      sql: kpiSql(PERSONAL_ROOTS, '$3', '$4'),
      args: [
        '@R1.id',
        '@owner.id',
        '2026-01-09T00:00:00.000Z',
        '2026-01-11T00:00:00.000Z',
      ],
      shape: 'object',
      path: 'kpisPrev',
      fields: KPI_FIELDS,
      strict: true,
    },
  },
  {
    // Personal view: the first prompt comes from the root's artisyn log, unmasked.
    id: 'F25-repo-sessions',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...JAN },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: sessionsSql(PERSONAL_ROOTS, '$3', '$4', false),
      args: ['@R1.id', '@owner.id', JAN.from, JAN.to],
      shape: 'array',
      path: 'sessions',
      fields: SESSION_FIELDS,
      strict: true,
    },
  },
  {
    // DD-22: the manager of restricted T2 sees the acknowledged members' sessions (the owner's
    // s01 and s04; the member has not acknowledged) with the first prompt masked.
    id: 'F25-repo-team-masked',
    route: REPO_FACTS,
    actor: 'manager',
    params: { repoId: '@R1.id' },
    query: { ...JAN, teamId: '@T2.id' },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: sessionsSql(teamRoots(true, '$2'), '$3', '$4', true),
      args: ['@T2.id', R1_URL, JAN.from, JAN.to],
      shape: 'array',
      path: 'sessions',
      fields: SESSION_FIELDS,
      strict: true,
    },
  },
  {
    // The member's own repository row without teamId: no analytics gate (s06 only).
    id: 'F25-repo-personal-member',
    route: REPO_FACTS,
    actor: 'member',
    params: { repoId: '@R1member.id' },
    query: { ...JAN },
    expect: { status: 200 },
    read: {
      sql: kpiSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@R1member.id', '@member.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'kpis',
      fields: KPI_FIELDS,
      strict: true,
    },
  },
  {
    // FR-34: a plain member of a restricted team gets no team analytics.
    id: 'F25-repo-team-plain-member',
    route: REPO_FACTS,
    actor: 'member',
    params: { repoId: '@R1member.id' },
    query: { ...JAN, teamId: '@T2.id' },
    expect: { status: 403 },
  },
  {
    // FR-34: an ADLC trainer without the manager flag gets no team analytics either.
    id: 'F25-repo-team-trainer',
    route: REPO_FACTS,
    actor: 'trainer',
    params: { repoId: '@R1.id' },
    query: { ...JAN, teamId: '@T2.id' },
    expect: { status: 403 },
  },
  {
    id: 'F25-repo-bad-tz',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...JAN, tz: 'Mars/Olympus' },
    expect: { status: 400 },
  },
  {
    // OTEL_MAX_PERIOD_DAYS = 93.
    id: 'F25-repo-period-too-long',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
    expect: { status: 400 },
  },
  {
    id: 'F25-repo-foreign',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R3.id' },
    query: { ...JAN },
    expect: { status: 403 },
  },
  {
    // DD-29, mixed: R1's January roots are s01 and s04 (OTEL rows) and s02 (no OTEL data, its
    // hook reported none / project-only). Golden in bodyMatches, formula in the SQL.
    id: 'F25-repo-coverage-mixed',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: {
        coverage: {
          otelSessions: 2,
          totalSessions: 3,
          otelUsers: 1,
          reasons: [{ reason: 'project-only', count: 1 }],
        },
      },
    },
    read: {
      sql: coverageSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@R1.id', '@owner.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'coverage',
      fields: COVERAGE_FIELDS,
      strict: true,
    },
  },
  {
    // DD-29, all-OTEL: Rdesert holds s04 and s11, both with OTEL rows -> no reason left.
    id: 'F25-repo-coverage-all-otel',
    route: REPO_FACTS,
    actor: 'owner',
    params: { repoId: '@Rdesert.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: {
        coverage: {
          otelSessions: 2,
          totalSessions: 2,
          otelUsers: 1,
          reasons: [],
        },
      },
    },
    read: {
      sql: coverageSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@Rdesert.id', '@owner.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'coverage',
      fields: COVERAGE_FIELDS,
      strict: true,
    },
  },
  {
    // DD-29, all-OTEL by the reported state alone: the author's s07 has no OTEL rows, but its
    // hook reported partial (managed-endpoint) -> covered.
    id: 'F25-repo-coverage-reported-partial',
    route: REPO_FACTS,
    actor: 'author',
    params: { repoId: '@R1author.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: {
        hasOtel: false,
        coverage: {
          otelSessions: 1,
          totalSessions: 1,
          otelUsers: 1,
          reasons: [],
        },
      },
    },
    read: {
      sql: coverageSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@R1author.id', '@author.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'coverage',
      fields: COVERAGE_FIELDS,
      strict: true,
    },
  },
  {
    // DD-29, zero-OTEL: the outsider's R3 holds s08 only, no OTEL rows, reported none /
    // receiver-down (port conflict).
    id: 'F25-repo-coverage-zero-otel',
    route: REPO_FACTS,
    actor: 'outsider',
    params: { repoId: '@R3.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: {
        hasOtel: false,
        coverage: {
          otelSessions: 0,
          totalSessions: 1,
          otelUsers: 0,
          reasons: [{ reason: 'receiver-down', count: 1 }],
        },
      },
    },
    read: {
      sql: coverageSql(PERSONAL_ROOTS, '$3', '$4'),
      args: ['@R3.id', '@outsider.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'coverage',
      fields: COVERAGE_FIELDS,
      strict: true,
    },
  },
];

const SESSION_OTEL =
  'GET /api/v1/repositories/:repoId/sessions/:sessionId/otel' as const;

const S01 = { repoId: '@R1.id', sessionId: '@s01.sessionId' };

const sessionSnapshot: CallCase = {
  id: 'F25-session-snapshot',
  route: SESSION_OTEL,
  actor: 'owner',
  params: S01,
  expect: {
    status: 200,
    minRows: 2,
    bodyMatches: {
      cursor: 'v1.3',
      full: true,
      // Both buckets start at 10:05: a zero span -> 5m.
      interval: '5m',
      kpis: {
        totalCostUsdMicros: '720000',
        hiddenCostUsdMicros: '20000',
        hiddenCalls: 1,
        apiCalls: 2,
        subagentCostUsdMicros: '0',
        subagentShare: 0,
      },
      status: s01Status(false),
    },
  },
  read: {
    sql: callsSql(false),
    args: ['@s01.id'],
    shape: 'array',
    path: 'calls',
    fields: CALL_FIELDS,
    strict: true,
  },
};

const sessionRows: ContractCase[] = [
  sessionSnapshot,
  {
    id: 'F25-session-spans',
    route: SESSION_OTEL,
    actor: 'owner',
    params: S01,
    expect: { status: 200, minRows: 3 },
    read: {
      sql: spansSql(false, false),
      args: ['@s01.id'],
      shape: 'array',
      path: 'spans',
      fields: SPAN_FIELDS,
      strict: true,
    },
  },
  {
    // DD-2: the client's cursor equals the stored seq -> nothing changed.
    id: 'F25-session-empty-delta',
    route: SESSION_OTEL,
    actor: 'owner',
    params: S01,
    query: { since: 'v1.3' },
    expect: {
      status: 200,
      bodyMatches: {
        cursor: 'v1.3',
        full: false,
        buckets: [],
        calls: [],
        spans: [],
        kpis: null,
        querySources: null,
      },
    },
    noDb: true,
  },
  {
    // since v1.2: only the rows written at seq 3 (the hidden call).
    id: 'F25-session-delta-calls',
    route: SESSION_OTEL,
    actor: 'owner',
    params: S01,
    query: { since: 'v1.2' },
    expect: {
      status: 200,
      minRows: 1,
      bodyMatches: { cursor: 'v1.3', full: false },
    },
    read: {
      sql: callsSql(true),
      args: ['@s01.id', 2],
      shape: 'array',
      path: 'calls',
      fields: CALL_FIELDS,
      strict: true,
    },
  },
  {
    // since v1.2: the standalone span (seq 3); the interaction trace is unchanged.
    id: 'F25-session-delta-spans',
    route: SESSION_OTEL,
    actor: 'owner',
    params: S01,
    query: { since: 'v1.2' },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: spansSql(true, false),
      args: ['@s01.id', 2],
      shape: 'array',
      path: 'spans',
      fields: SPAN_FIELDS,
      strict: true,
    },
  },
  {
    // DD-2: a cursor above the stored seq gets the full snapshot.
    id: 'F25-session-unknown-cursor',
    route: SESSION_OTEL,
    actor: 'owner',
    params: S01,
    query: { since: 'v1.999' },
    expect: { status: 200 },
    sameExpectedAs: 'F25-session-snapshot',
  },
  {
    // ... and so does a cursor of an unknown version.
    id: 'F25-session-unknown-cursor-version',
    route: SESSION_OTEL,
    actor: 'owner',
    params: S01,
    query: { since: 'v9.3' },
    expect: { status: 200 },
    sameExpectedAs: 'F25-session-snapshot',
  },
  {
    // DD-22: a manager of restricted T2 viewing the owner's session gets no span attributes.
    id: 'F25-session-team-masked',
    route: SESSION_OTEL,
    actor: 'manager',
    params: S01,
    query: { teamId: '@T2.id' },
    expect: {
      status: 200,
      minRows: 3,
      bodyMatches: { cursor: 'v1.3', status: s01Status(true) },
    },
    read: {
      sql: spansSql(false, true),
      args: ['@s01.id'],
      shape: 'array',
      path: 'spans',
      fields: SPAN_FIELDS,
      strict: true,
    },
  },
  {
    // The member's s06 is not in the owner's personal R1 scope: an empty answer, never 404.
    id: 'F25-session-out-of-scope',
    route: SESSION_OTEL,
    actor: 'owner',
    params: { repoId: '@R1.id', sessionId: '@s06.sessionId' },
    expect: { status: 200, bodyMatches: EMPTY_SESSION },
    noDb: true,
  },
  {
    // s02 is in scope but has no OTEL data: the same empty answer.
    id: 'F25-session-no-otel',
    route: SESSION_OTEL,
    actor: 'owner',
    params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
    expect: { status: 200, bodyMatches: EMPTY_SESSION },
    noDb: true,
  },
  {
    id: 'F25-session-foreign-repo',
    route: SESSION_OTEL,
    actor: 'outsider',
    params: S01,
    expect: { status: 403 },
  },
  {
    // DD-28 / DD-30: s02 has no OTEL data, but its hook reported none / project-only; no OTEL
    // call and a state that is not ok -> the computed cost leaves out the utility calls.
    id: 'F25-session-status-reported-no-data',
    route: SESSION_OTEL,
    actor: 'owner',
    params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
    expect: {
      status: 200,
      bodyMatches: { ...EMPTY_SESSION },
    },
    read: {
      sql: SESSION_OTEL_STATUS_SQL,
      args: ['@s02.id'],
      shape: 'object',
      path: 'status',
      fields: SESSION_OTEL_STATUS_FIELDS,
    },
  },
  {
    // DD-28 / DD-30: s04 has OTEL calls and reported ok -> a populated status, no marker.
    id: 'F25-session-status-reported-ok',
    route: SESSION_OTEL,
    actor: 'owner',
    params: { repoId: '@R1.id', sessionId: '@s04.sessionId' },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: SESSION_OTEL_STATUS_SQL,
      args: ['@s04.id'],
      shape: 'object',
      path: 'status',
      fields: SESSION_OTEL_STATUS_FIELDS,
    },
  },
];

const TEAM_FACTS = 'GET /api/v1/teams/:teamId/otel/facts' as const;

const teamRows: ContractCase[] = [
  {
    // DD-29: T2's manager over R1's URL and Rdesert: the DISTINCT roots s01, s04 and s11 — s04
    // is linked to both repositories and counts once.
    id: 'F25-team-kpis',
    route: TEAM_FACTS,
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: { interval: '1d', hasOtel: true, hasOtelInPeriod: true },
    },
    read: {
      sql: kpiSql(teamRoots(true), '$2', '$3'),
      args: ['@T2.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'kpis',
      fields: KPI_FIELDS,
      // The team KPIs add the per-person cost and the repository counts (checked below).
      ignore: [
        'perActivePersonCostUsdMicros',
        'repositories',
        'repositoriesLive',
      ],
      strict: true,
    },
  },
  {
    // ...while each Repositories row counts a session in every repository it is linked to:
    // s04 is in both rows. A team repository is keyed by its lowest member repository id.
    id: 'F25-team-repositories',
    route: TEAM_FACTS,
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: { ...JAN },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `WITH roots AS (${teamRoots(true)}),
        links AS (
          SELECT DISTINCT tr.repo_url,
                 (SELECT min(r2.id) FROM repositories r2
                   WHERE r2.repo_url = tr.repo_url
                     AND r2.user_id IN (SELECT user_id FROM team_members WHERE team_id = $1))
                   AS repo_id,
                 l.session_id, l.user_id
            FROM team_repositories tr
            JOIN repositories r ON r.repo_url = tr.repo_url
            JOIN log_repositories lr ON lr.repo_id = r.id
            JOIN logs l ON l.id = lr.log_id AND l.log_type = 'artisyn'
           WHERE tr.team_id = $1
             AND r.user_id IN (SELECT user_id FROM team_members WHERE team_id = $1)
             AND l.session_id IN (SELECT id FROM roots)),
        cost AS (
          SELECT session_id, sum(cost_usd_micros) AS c,
                 coalesce(sum(cost_usd_micros) FILTER (WHERE structure = 'hidden'), 0) AS h
            FROM otel_cost_buckets
           WHERE bucket_start >= $2::timestamptz AND bucket_start < $3::timestamptz
             AND calls <> 0
           GROUP BY session_id)
        SELECT links.repo_id, links.repo_url, count(DISTINCT links.user_id) AS people,
               count(DISTINCT links.session_id) AS sessions, sum(cost.c)::text AS cost,
               sum(cost.h)::text AS hidden, 0 AS live
          FROM links JOIN cost ON cost.session_id = links.session_id
         GROUP BY links.repo_id, links.repo_url
         ORDER BY sum(cost.c) DESC`,
      args: ['@T2.id', JAN.from, JAN.to],
      shape: 'array',
      path: 'repositories',
      fields: {
        repoId: { col: 'repo_id', as: 'number' },
        repoUrl: 'repo_url',
        people: { col: 'people', as: 'number' },
        sessions: { col: 'sessions', as: 'number' },
        costUsdMicros: 'cost',
        hiddenCostUsdMicros: 'hidden',
        liveSessions: { col: 'live', as: 'number' },
      },
      strict: true,
    },
  },
  {
    // DD-29: the people picker keeps every person with data although the userId filter
    // narrows the tab to the member (transparent T1: owner and member are visible).
    id: 'F25-team-people-options',
    route: TEAM_FACTS,
    actor: 'owner',
    params: { teamId: '@T1.id' },
    query: { ...JAN, userId: ['@member.id'] },
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `${bucketsOf(teamRoots(false), '$2', '$3')}
        SELECT DISTINCT u.id AS user_id, u.email
          FROM b
          JOIN logs l ON l.session_id = b.session_id AND l.log_type = 'artisyn'
          JOIN users u ON u.id = l.user_id
         ORDER BY u.email`,
      args: ['@T1.id', JAN.from, JAN.to],
      shape: 'array',
      path: 'filterOptions.people',
      fields: { userId: { col: 'user_id', as: 'number' }, email: 'email' },
      strict: true,
    },
  },
  {
    // ...while the People table follows the filter: the member alone (s06).
    id: 'F25-team-people-filtered',
    route: TEAM_FACTS,
    actor: 'owner',
    params: { teamId: '@T1.id' },
    query: { ...JAN, userId: ['@member.id'] },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: `${bucketsOf(teamRoots(false), '$2', '$3')}
        SELECT l.user_id, u.email, count(DISTINCT b.session_id) AS sessions,
               sum(b.cost_usd_micros)::text AS cost
          FROM b
          JOIN logs l ON l.session_id = b.session_id AND l.log_type = 'artisyn'
          JOIN users u ON u.id = l.user_id
         WHERE l.user_id = $4
         GROUP BY l.user_id, u.email`,
      args: ['@T1.id', JAN.from, JAN.to, '@member.id'],
      shape: 'array',
      path: 'people',
      fields: {
        userId: { col: 'user_id', as: 'number' },
        email: 'email',
        sessions: { col: 'sessions', as: 'number' },
        costUsdMicros: 'cost',
      },
    },
  },
  {
    // DD-29, team mixed: T2's manager sees the acknowledged members' roots s01, s02, s04 and s11
    // (s04 is linked to both team repositories and counts once); s02 has no OTEL data and
    // reported none / project-only.
    id: 'F25-team-coverage-mixed',
    route: TEAM_FACTS,
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: { ...JAN },
    expect: {
      status: 200,
      bodyMatches: {
        coverage: {
          otelSessions: 3,
          totalSessions: 4,
          otelUsers: 1,
          reasons: [{ reason: 'project-only', count: 1 }],
        },
      },
    },
    read: {
      sql: coverageSql(teamRoots(true), '$2', '$3'),
      args: ['@T2.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'coverage',
      fields: COVERAGE_FIELDS,
      strict: true,
    },
  },
  {
    // DD-29, transparent T1 (owner + member, no acknowledgement filter) over its URLs: the
    // member's s06 (OTEL rows) counts next to the owner's roots — two people with OTEL data.
    id: 'F25-team-coverage-transparent',
    route: TEAM_FACTS,
    actor: 'owner',
    params: { teamId: '@T1.id' },
    query: { ...JAN },
    expect: { status: 200 },
    read: {
      sql: coverageSql(teamRoots(false), '$2', '$3'),
      args: ['@T1.id', JAN.from, JAN.to],
      shape: 'object',
      path: 'coverage',
      fields: COVERAGE_FIELDS,
      strict: true,
    },
  },
  {
    id: 'F25-team-plain-member',
    route: TEAM_FACTS,
    actor: 'member',
    params: { teamId: '@T2.id' },
    query: { ...JAN },
    expect: { status: 403 },
  },
  {
    id: 'F25-team-trainer',
    route: TEAM_FACTS,
    actor: 'trainer',
    params: { teamId: '@T2.id' },
    query: { ...JAN },
    expect: { status: 403 },
  },
  {
    id: 'F25-team-non-member',
    route: TEAM_FACTS,
    actor: 'outsider',
    params: { teamId: '@T2.id' },
    query: { ...JAN },
    expect: { status: 403 },
  },
  {
    id: 'F25-team-bad-stack-by',
    route: TEAM_FACTS,
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: { ...JAN, stackBy: 'galaxy' },
    expect: { status: 400 },
  },
];

export const f25Otel: ContractFamily = {
  id: 'F25',
  name: 'otel',
  cases: [...realtimeRows, ...repoRows, ...sessionRows, ...teamRows],
};
