// F24 — Tools/MCP tab (T-26): the hook's monitored-tools config read (API key) and the tab's
// config / summary / calls / call-detail routes (cookie session).
//
// World (fixtures/world-v1.sql.ts, "Tools/MCP tab"): the owner's personal list of R1 monitors
// `ce` + `kubectl` (and a disabled `old`), T1's list of R1's URL monitors `find`, T2 has none.
// R1's `tool_wrap_status` has wrapper data for `ce` only. `session_tool_usage`: s01 holds an MCP
// `postgres` row (two `query` calls, one error) and a CLI `ce` row (one `build` call), s03 (s02's
// sub-agent) an MCP `postgres` row (one `schema` call), the member's s06 a CLI `ce` row (one
// failed `test` call) and the outsider's s08 an MCP `github` row. Every session is still pending
// a rebuild (`tool_usage_version` NULL) and the run parks the rebuild drain.
//
// Visibility follows the Sessions tab (DD-17): without `teamId` the caller's own sessions of the
// repository row, with `teamId` every member's row for the URL under the team's access mode.
import type { ContractCase, ContractFamily, SqlArg } from '../types';

const R1_URL = 'https://github.com/arrakis/spice-harvester';

/** January 2026, the world's month; `to` is a date-only value, so it covers the whole day. */
const RANGE = { from: '2026-01-01', to: '2026-01-31' };
const RANGE_ECHO = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-31T23:59:59.999Z',
};

/**
 * The hook's merged list (DD-2) written as plain SQL: user `$1`'s personal rows for URL `$2`
 * first, then every team list of that URL whose team the user owns or belongs to, by link id;
 * enabled entries only, in stored order. (No name repeats across the world's lists, so the
 * merge's de-duplication never kicks in.)
 */
const HOOK_TOOLS_SQL = `
  SELECT e.t->>'name' AS name, e.t->>'capture' AS capture
    FROM (
      SELECT 0 AS lvl, 0 AS link, c.config
        FROM repo_tool_monitor_config c JOIN repositories r ON r.id = c.repo_id
       WHERE r.user_id = $1 AND r.repo_url = $2
      UNION ALL
      SELECT 1, tr.id, tc.config
        FROM team_repo_tool_monitor_config tc
        JOIN team_repositories tr ON tr.id = tc.team_repository_id
        JOIN teams tm ON tm.id = tr.team_id
       WHERE tr.repo_url = $2
         AND (tm.owner_id = $1 OR EXISTS (SELECT 1 FROM team_members m
                                           WHERE m.team_id = tr.team_id AND m.user_id = $1))
    ) src
    CROSS JOIN LATERAL jsonb_array_elements(src.config->'tools') WITH ORDINALITY AS e(t, ord)
   WHERE (e.t->>'enabled')::boolean
   ORDER BY src.lvl, src.link, e.ord`;

/** One level's stored list, in stored order: `$1` is the jsonb column's row filter value. */
const LEVEL_TOOLS_FIELDS = {
  name: 'name',
  enabled: 'enabled',
  capture: 'capture',
};
const PERSONAL_TOOLS_SQL = `
  SELECT e.t->>'name' AS name, (e.t->>'enabled')::boolean AS enabled, e.t->>'capture' AS capture
    FROM repo_tool_monitor_config c,
         jsonb_array_elements(c.config->'tools') WITH ORDINALITY AS e(t, ord)
   WHERE c.repo_id = $1
   ORDER BY e.ord`;
const TEAM_TOOLS_SQL = `
  SELECT e.t->>'name' AS name, (e.t->>'enabled')::boolean AS enabled, e.t->>'capture' AS capture
    FROM team_repo_tool_monitor_config c
    JOIN team_repositories tr ON tr.id = c.team_repository_id,
         jsonb_array_elements(c.config->'tools') WITH ORDINALITY AS e(t, ord)
   WHERE tr.team_id = $1 AND tr.repo_url = $2
   ORDER BY e.ord`;

/** R1's `tool_wrap_status` as the config GET shows it (no `shells`, no per-tool map). */
const R1_WRAP_STATUS = {
  hookVersion: '2.21.0',
  os: 'win32',
  preflight: { ok: true, reason: null },
  breaker: { global: false, tools: [] },
  reportedAt: '2026-01-10T10:31:00.000Z',
};

/**
 * `tree(id, session_id, root_id)`: the trees whose root has an `artisyn` log linked to one of
 * repository rows `$1` (int[]) uploaded by one of users `$2` (int[]), root not deleted. Used by
 * the summary, calls and pending oracles.
 */
const SCOPED_TREE = `
  WITH RECURSIVE roots AS (
    SELECT DISTINCT s.id, s.session_id
      FROM sessions s
      JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
      JOIN log_repositories lr ON lr.log_id = l.id
     WHERE lr.repo_id = ANY($1::int[]) AND l.user_id = ANY($2::int[]) AND NOT s.deleted
  ),
  tree AS (
    SELECT r.id, r.session_id, r.id AS root_id FROM roots r
    UNION ALL
    SELECT c.id, c.session_id, t.root_id
      FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
  ),
  rows_in_range AS (
    SELECT u.*, t.session_id AS node_session_id
      FROM session_tool_usage u JOIN tree t ON t.id = u.session_id
     WHERE u.last_call_at BETWEEN '2026-01-01T00:00:00Z' AND '2026-01-31T23:59:59.999Z'
  )`;

/** Per tool, summed over its operations; ordered like the endpoint (calls desc, then name). */
const SUMMARY_TOOLS_SQL = `${SCOPED_TREE}
  SELECT u.channel, u.tool,
         sum((op.value->>'calls')::int) AS calls,
         sum((op.value->>'errors')::int) AS errors,
         sum((op.value->>'empty')::int) AS empty,
         sum((op.value->>'retried')::int) AS retried,
         sum((op.value->>'outBytesSum')::int) AS out_bytes,
         count(*) AS operations
    FROM rows_in_range u, jsonb_each(u.aggregates->'operations') op
   GROUP BY u.channel, u.tool
   ORDER BY calls DESC, u.channel || ':' || u.tool`;
const SUMMARY_TOOLS_FIELDS = {
  channel: 'channel',
  tool: 'tool',
  calls: { col: 'calls', as: 'number' },
  errors: { col: 'errors', as: 'number' },
  empty: { col: 'empty', as: 'number' },
  retried: { col: 'retried', as: 'number' },
  outBytes: { col: 'out_bytes', as: 'number' },
} as const;

/** The calls of the rows in scope and range, newest first (DD-18), `$3` = status filter or NULL. */
const CALLS_SQL = `${SCOPED_TREE}
  SELECT u.id AS usage_id, u.node_session_id AS session_id,
         e->>'callId' AS call_id, e->>'tool' AS tool, e->>'operation' AS operation,
         e->>'status' AS status, e->>'ts' AS ts
    FROM rows_in_range u, jsonb_array_elements(u.calls) e
   WHERE ($3::text IS NULL OR e->>'status' = $3::text)
   ORDER BY e->>'ts' DESC`;
const CALLS_FIELDS = {
  usageId: { col: 'usage_id', as: 'number' },
  sessionId: 'session_id',
  callId: 'call_id',
  tool: 'tool',
  operation: 'operation',
  status: 'status',
  ts: 'ts',
} as const;
/** The rest of a list item: compared by the golden rows, never `args` / `cwd` (strict). */
const CALLS_IGNORE = [
  'channel',
  'durationMs',
  'hints',
  'source',
  'shell',
  'exitCode',
  'inBytes',
  'outBytes',
  'agentSawBytes',
  'toolUseId',
  'agentId',
  'agentKind',
  'inputPreview',
  'real',
  'signals',
  'sessionOwner',
];

/** In-scope pending roots overlapping the range (`tool_usage_version IS NULL`). */
const PENDING_SQL = `
  SELECT count(DISTINCT s.id) AS pending
    FROM sessions s
    JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
    JOIN log_repositories lr ON lr.log_id = l.id
   WHERE lr.repo_id = ANY($1::int[]) AND l.user_id = ANY($2::int[])
     AND NOT s.deleted AND s.tool_usage_version IS NULL
     AND l.start_time <= '2026-01-31T23:59:59.999Z'
     AND coalesce(l.end_time, l.start_time) >= '2026-01-01T00:00:00Z'`;

/**
 * `session_tree(id, session_id)`: the tree under root session `$1` (`sessions.session_id`),
 * root not deleted, with no date range — what `sessionId` narrows the summary and calls to.
 */
const SESSION_TREE = `
  WITH RECURSIVE session_tree AS (
    SELECT s.id, s.session_id FROM sessions s WHERE s.session_id = $1 AND NOT s.deleted
    UNION ALL
    SELECT c.id, c.session_id
      FROM sessions c JOIN session_tree t ON c.parent_session_id = t.session_id
  )`;

/** The session tree's tools, like {@link SUMMARY_TOOLS_SQL} without a range. */
const SESSION_SUMMARY_TOOLS_SQL = `${SESSION_TREE}
  SELECT u.channel, u.tool,
         sum((op.value->>'calls')::int) AS calls,
         sum((op.value->>'errors')::int) AS errors,
         sum((op.value->>'empty')::int) AS empty,
         sum((op.value->>'retried')::int) AS retried,
         sum((op.value->>'outBytesSum')::int) AS out_bytes
    FROM session_tool_usage u
    JOIN session_tree t ON t.id = u.session_id,
         jsonb_each(u.aggregates->'operations') op
   GROUP BY u.channel, u.tool
   ORDER BY calls DESC, u.channel || ':' || u.tool`;

/** The session tree's calls, newest first, like {@link CALLS_SQL} without a range. */
const SESSION_CALLS_SQL = `${SESSION_TREE}
  SELECT u.id AS usage_id, t.session_id AS session_id,
         e->>'callId' AS call_id, e->>'tool' AS tool, e->>'operation' AS operation,
         e->>'status' AS status, e->>'ts' AS ts
    FROM session_tool_usage u
    JOIN session_tree t ON t.id = u.session_id,
         jsonb_array_elements(u.calls) e
   ORDER BY e->>'ts' DESC`;

/** One call of usage row `$1` with id `$2`, its node and its tree root. */
const DETAIL_SQL = `
  WITH RECURSIVE up AS (
    SELECT s.id, s.session_id, s.parent_session_id FROM sessions s
     WHERE s.id = (SELECT session_id FROM session_tool_usage WHERE id = $1)
    UNION ALL
    SELECT p.id, p.session_id, p.parent_session_id
      FROM sessions p JOIN up ON p.session_id = up.parent_session_id
  )
  SELECT u.id AS usage_id, e->>'callId' AS call_id, e->>'tool' AS tool,
         e->>'status' AS status, e->'args' AS args, e->>'cwd' AS cwd,
         (SELECT session_id FROM sessions WHERE id = u.session_id) AS session_id,
         (SELECT session_id FROM up WHERE parent_session_id IS NULL) AS root_session_id
    FROM session_tool_usage u, jsonb_array_elements(u.calls) e
   WHERE u.id = $1 AND e->>'callId' = $2`;
const DETAIL_FIELDS = {
  usageId: { col: 'usage_id', as: 'number' },
  callId: 'call_id',
  tool: 'tool',
  status: 'status',
  args: { col: 'args', as: 'json' },
  cwd: 'cwd',
  sessionId: 'session_id',
  rootSessionId: 'root_session_id',
} as const;

/** `{ repoIds, userIds }` as the two `int[]` args of the scoped oracles. */
function scopeArgs(repoIds: string, userIds: string): SqlArg[] {
  return [repoIds, userIds];
}
/** The owner's personal view of R1. */
const OWNER_R1 = scopeArgs('{1}', '{2}');
/** T1 (transparent): the owner's R1 row and the member's own row for the URL, both uploaders. */
const T1_R1 = scopeArgs('{1,5}', '{2,3}');

const CONFIG_ROUTE = 'GET /api/v1/repositories/:repoId/tool-monitoring/config';
const PUT_ROUTE = 'PUT /api/v1/repositories/:repoId/tool-monitoring/config';
const SUMMARY_ROUTE =
  'GET /api/v1/repositories/:repoId/tool-monitoring/summary';
const CALLS_ROUTE = 'GET /api/v1/repositories/:repoId/tool-monitoring/calls';
const DETAIL_ROUTE =
  'GET /api/v1/repositories/:repoId/tool-monitoring/calls/:usageId/:callId';
const HOOK_ROUTE = 'GET /api/v2/tool-monitoring/config';

/** The owner's personal list as the PUT rows send it. */
const OWNER_TOOLS = [
  { name: 'ce', enabled: true, capture: 'full' },
  { name: 'kubectl', enabled: true, capture: 'meta' },
  { name: 'old', enabled: false, capture: 'full' },
];

const hookRows: ContractCase[] = [
  {
    // DD-2 / DD-3: the owner's personal `ce` + `kubectl` (the disabled `old` is dropped) and
    // T1's `find` (the owner owns T1); T2 links the URL but has no list.
    id: 'F24-hook-config',
    route: HOOK_ROUTE,
    actor: 'ownerKey',
    query: { repoUrl: R1_URL },
    expect: {
      status: 200,
      minRows: 3,
      bodyMatches: {
        schemaVersion: 1,
        paused: false,
        tools: [
          { name: 'ce', capture: 'full' },
          { name: 'kubectl', capture: 'meta' },
          { name: 'find', capture: 'full' },
        ],
      },
    },
    read: {
      sql: HOOK_TOOLS_SQL,
      args: ['@owner.id', R1_URL],
      shape: 'array',
      path: 'tools',
      fields: { name: 'name', capture: 'capture' },
      strict: true,
    },
  },
  {
    // The member has no personal list for the URL; T1 (member) gives `find`, T2 (member, no
    // list) nothing. The URL is normalized first (`.git` suffix, trailing slash).
    id: 'F24-hook-config-member',
    route: HOOK_ROUTE,
    actor: 'memberKey',
    query: { repoUrl: `${R1_URL}.git` },
    expect: {
      status: 200,
      minRows: 1,
      bodyMatches: {
        schemaVersion: 1,
        paused: false,
        tools: [{ name: 'find', capture: 'full' }],
      },
    },
    read: {
      sql: HOOK_TOOLS_SQL,
      args: ['@member.id', R1_URL],
      shape: 'array',
      path: 'tools',
      fields: { name: 'name', capture: 'capture' },
      strict: true,
    },
  },
  {
    // An unknown repository answers with an empty list, never 404 (the hook wraps nothing).
    id: 'F24-hook-config-unknown-repo',
    route: HOOK_ROUTE,
    actor: 'ownerKey',
    query: { repoUrl: 'https://github.com/arrakis/no-such-repo' },
    expect: {
      status: 200,
      bodyMatches: { schemaVersion: 1, paused: false, tools: [] },
    },
    noDb: true,
  },
  {
    id: 'F24-hook-config-no-repo-url',
    route: HOOK_ROUTE,
    actor: 'ownerKey',
    expect: { status: 400 },
  },
  {
    id: 'F24-hook-config-no-key',
    route: HOOK_ROUTE,
    actor: 'anon',
    query: { repoUrl: R1_URL },
    expect: { status: 401 },
  },
];

const configRows: ContractCase[] = [
  {
    // Personal level (DD-20 hints): `ce` has wrapper data (no hint), `kubectl` is configured
    // but never seen by the wrapper (`no_data_yet`), the disabled `old` has no hint and no level.
    id: 'F24-config-personal',
    route: CONFIG_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    expect: {
      status: 200,
      minRows: 3,
      bodyMatches: {
        level: 'personal',
        canEdit: true,
        paused: false,
        tools: [
          {
            name: 'ce',
            enabled: true,
            capture: 'full',
            levels: ['personal'],
            lastWrapperAt: '2026-01-10T10:03:00.000Z',
            hint: null,
          },
          {
            name: 'kubectl',
            enabled: true,
            capture: 'meta',
            levels: ['personal'],
            lastWrapperAt: null,
            hint: 'no_data_yet',
          },
          {
            name: 'old',
            enabled: false,
            capture: 'full',
            levels: [],
            lastWrapperAt: null,
            hint: null,
          },
        ],
        wrapStatus: R1_WRAP_STATUS,
      },
    },
    read: {
      sql: PERSONAL_TOOLS_SQL,
      args: ['@R1.id'],
      shape: 'array',
      path: 'tools',
      fields: LEVEL_TOOLS_FIELDS,
    },
  },
  {
    // Team level, T1's owner: editable. `find` has no wrapper record among the visible rows.
    id: 'F24-config-team',
    route: CONFIG_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T1.id' },
    expect: {
      status: 200,
      minRows: 1,
      bodyMatches: {
        level: 'team',
        canEdit: true,
        paused: false,
        tools: [
          {
            name: 'find',
            enabled: true,
            capture: 'full',
            levels: ['team'],
            lastWrapperAt: null,
            hint: 'no_data_yet',
          },
        ],
        wrapStatus: R1_WRAP_STATUS,
      },
    },
    read: {
      sql: TEAM_TOOLS_SQL,
      args: ['@T1.id', R1_URL],
      shape: 'array',
      path: 'tools',
      fields: LEVEL_TOOLS_FIELDS,
    },
  },
  {
    // A plain T1 member sees the team level read-only.
    id: 'F24-config-team-member',
    route: CONFIG_ROUTE,
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T1.id' },
    expect: {
      status: 200,
      minRows: 1,
      bodyMatches: { level: 'team', canEdit: false, paused: false },
    },
    read: {
      sql: TEAM_TOOLS_SQL,
      args: ['@T1.id', R1_URL],
      shape: 'array',
      path: 'tools',
      fields: LEVEL_TOOLS_FIELDS,
    },
  },
  {
    id: 'F24-config-outsider',
    route: CONFIG_ROUTE,
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    expect: { status: 403 },
  },
  {
    id: 'F24-config-bad-team-id',
    route: CONFIG_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { teamId: 0 },
    expect: { status: 400 },
  },
];

const putRows: ContractCase[] = [
  {
    // Adding `zz` to the personal list: the row is replaced; the newly enabled tool marks the
    // owner's R1 sessions stale (DD-7), which they already are in the world, so `sessions`
    // stays as it is.
    id: 'F24-put-personal',
    route: PUT_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: {
      paused: false,
      tools: [...OWNER_TOOLS, { name: 'zz', enabled: true, capture: 'meta' }],
    },
    expect: {
      status: 200,
      bodyMatches: { level: 'personal', canEdit: true, paused: false },
    },
    write: {
      watch: ['repo_tool_monitor_config'],
      delta: {
        updated: [
          {
            table: 'repo_tool_monitor_config',
            where: 'repo_id = @R1.id',
            changed: {
              config: {
                paused: false,
                tools: [
                  ...OWNER_TOOLS,
                  { name: 'zz', enabled: true, capture: 'meta' },
                ],
              },
            },
            anyChange: ['updated_at'],
          },
        ],
      },
    },
  },
  {
    // T1's owner pauses the team level; no tool is newly enabled, so nothing is marked stale.
    id: 'F24-put-team',
    route: PUT_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T1.id' },
    body: {
      paused: true,
      tools: [{ name: 'find', enabled: true, capture: 'meta' }],
    },
    expect: {
      status: 200,
      bodyMatches: { level: 'team', canEdit: true, paused: true },
    },
    write: {
      watch: ['team_repo_tool_monitor_config'],
      delta: {
        updated: [
          {
            table: 'team_repo_tool_monitor_config',
            where: 'team_repository_id = 1',
            changed: {
              config: {
                paused: true,
                tools: [{ name: 'find', enabled: true, capture: 'meta' }],
              },
            },
            anyChange: ['updated_at'],
          },
        ],
      },
    },
  },
  {
    // FR-8.1 / DD-4: the agent's shell can never be monitored; the 400 names the field.
    id: 'F24-put-denylisted',
    route: PUT_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: {
      paused: false,
      tools: [{ name: 'powershell.exe', enabled: true, capture: 'full' }],
    },
    expect: {
      status: 400,
      bodyMatches: { field: 'tools[0].name', code: 'denylisted' },
    },
  },
  {
    id: 'F24-put-duplicate',
    route: PUT_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: {
      paused: false,
      tools: [
        { name: 'ce', enabled: true, capture: 'full' },
        { name: 'CE.exe', enabled: true, capture: 'full' },
      ],
    },
    expect: {
      status: 400,
      bodyMatches: { field: 'tools[1].name', code: 'duplicate' },
    },
  },
  {
    // Only the team owner edits the team level.
    id: 'F24-put-team-member',
    route: PUT_ROUTE,
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T1.id' },
    body: { paused: false, tools: [] },
    expect: { status: 403 },
  },
  {
    id: 'F24-put-outsider',
    route: PUT_ROUTE,
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    body: { paused: false, tools: [] },
    expect: { status: 403 },
  },
  {
    id: 'F24-put-bad-team-id',
    route: PUT_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { teamId: -1 },
    body: { paused: false, tools: [] },
    expect: { status: 400 },
  },
];

const summaryRows: ContractCase[] = [
  {
    // Personal view of R1: s01's two rows and s03's (reached through its root s02). `ce` is
    // called; `kubectl` (personal) and `find` (T1) are monitored for the owner but never called.
    id: 'F24-summary',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: RANGE,
    expect: {
      status: 200,
      minRows: 2,
      bodyMatches: {
        range: RANGE_ECHO,
        neverCalled: ['kubectl', 'find'],
        totals: {
          calls: 4,
          errors: 1,
          killed: 0,
          noResult: 0,
          empty: 1,
          retried: 1,
          fellBack: 0,
          openedFile: 0,
          // (100 + 200 + 50 + 1500) / 4 = 462.5, rounded.
          avgDurationMs: 463,
          inBytes: 100,
          outBytes: 2908,
        },
      },
    },
    read: {
      sql: SUMMARY_TOOLS_SQL,
      args: OWNER_R1,
      shape: 'array',
      path: 'tools',
      fields: SUMMARY_TOOLS_FIELDS,
    },
  },
  {
    // `pendingSessions`: s01, s02 and s04 are R1's roots, none rebuilt yet.
    id: 'F24-summary-pending',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: RANGE,
    expect: { status: 200 },
    read: {
      sql: PENDING_SQL,
      args: OWNER_R1,
      shape: 'object',
      fields: { pendingSessions: { col: 'pending', as: 'number' } },
    },
  },
  {
    // T1 is transparent: the member's s06 `ce` call joins the owner's; `neverCalled` is the
    // team level's own list.
    id: 'F24-summary-team',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...RANGE, teamId: '@T1.id' },
    expect: {
      status: 200,
      minRows: 2,
      bodyMatches: { neverCalled: ['find'] },
    },
    read: {
      sql: SUMMARY_TOOLS_SQL,
      args: T1_R1,
      shape: 'array',
      path: 'tools',
      fields: SUMMARY_TOOLS_FIELDS,
    },
  },
  {
    id: 'F24-summary-outsider',
    route: SUMMARY_ROUTE,
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    query: RANGE,
    expect: { status: 403 },
  },
  {
    id: 'F24-summary-bad-range',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { from: '2026-02-01', to: '2026-01-01' },
    expect: { status: 400 },
  },
  {
    id: 'F24-summary-bad-team-id',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...RANGE, teamId: 0 },
    expect: { status: 400 },
  },
  {
    // The session detail tab: `sessionId` narrows to one tree and, with no range given, covers
    // the whole session. s02's tree holds only its sub-agent s03's `postgres` `schema` call.
    id: 'F24-summary-session',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { sessionId: '@s02.sessionId' },
    expect: {
      status: 200,
      minRows: 1,
      bodyMatches: {
        totals: {
          calls: 1,
          errors: 0,
          killed: 0,
          noResult: 0,
          empty: 1,
          retried: 0,
          fellBack: 0,
          openedFile: 0,
          avgDurationMs: 50,
          inBytes: 20,
          outBytes: 300,
        },
      },
    },
    read: {
      sql: SESSION_SUMMARY_TOOLS_SQL,
      args: ['@s02.sessionId'],
      shape: 'array',
      path: 'tools',
      fields: SUMMARY_TOOLS_FIELDS,
    },
  },
  {
    // The outsider's s08 is not in the owner's R1 scope: narrowing to it yields nothing, although
    // s08 holds a `session_tool_usage` row — the scope, not the DB, is what this row pins.
    id: 'F24-summary-session-foreign',
    route: SUMMARY_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { sessionId: '@s08.sessionId' },
    expect: {
      status: 200,
      bodyMatches: {
        totals: {
          calls: 0,
          errors: 0,
          killed: 0,
          noResult: 0,
          empty: 0,
          retried: 0,
          fellBack: 0,
          openedFile: 0,
          avgDurationMs: null,
          inBytes: 0,
          outBytes: 0,
        },
        tools: [],
      },
    },
    noDb: true,
  },
];

const callsRows: ContractCase[] = [
  {
    // Every call of the personal view, newest first; list items never carry `args` / `cwd`.
    id: 'F24-calls',
    route: CALLS_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: RANGE,
    expect: {
      status: 200,
      minRows: 4,
      bodyMatches: { total: 4, page: 1, pageSize: 50 },
    },
    read: {
      sql: CALLS_SQL,
      args: [...OWNER_R1, null],
      shape: 'array',
      path: 'items',
      fields: CALLS_FIELDS,
      strict: true,
      ignore: CALLS_IGNORE,
    },
  },
  {
    // The status filter narrows the table only (DD-18).
    id: 'F24-calls-errors',
    route: CALLS_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...RANGE, status: 'error' },
    expect: { status: 200, minRows: 1, bodyMatches: { total: 1 } },
    read: {
      sql: CALLS_SQL,
      args: [...OWNER_R1, 'error'],
      shape: 'array',
      path: 'items',
      fields: CALLS_FIELDS,
    },
  },
  {
    // A T1 member sees the owner's calls next to their own (transparent team).
    id: 'F24-calls-team-member',
    route: CALLS_ROUTE,
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { ...RANGE, teamId: '@T1.id' },
    expect: { status: 200, minRows: 5, bodyMatches: { total: 5 } },
    read: {
      sql: CALLS_SQL,
      args: [...T1_R1, null],
      shape: 'array',
      path: 'items',
      fields: CALLS_FIELDS,
    },
  },
  {
    id: 'F24-calls-outsider',
    route: CALLS_ROUTE,
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    query: RANGE,
    expect: { status: 403 },
  },
  {
    id: 'F24-calls-bad-status',
    route: CALLS_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...RANGE, status: 'exploded' },
    expect: { status: 400 },
  },
  {
    id: 'F24-calls-bad-team-id',
    route: CALLS_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...RANGE, teamId: 0 },
    expect: { status: 400 },
  },
  {
    // `sessionId` narrows the table to s01's tree, whole session (no range given).
    id: 'F24-calls-session',
    route: CALLS_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { sessionId: '@s01.sessionId' },
    expect: { status: 200, minRows: 3, bodyMatches: { total: 3 } },
    read: {
      sql: SESSION_CALLS_SQL,
      args: ['@s01.sessionId'],
      shape: 'array',
      path: 'items',
      fields: CALLS_FIELDS,
      strict: true,
      ignore: CALLS_IGNORE,
    },
  },
  {
    id: 'F24-calls-session-too-long',
    route: CALLS_ROUTE,
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { sessionId: 'x'.repeat(257) },
    expect: { status: 400 },
  },
];

const detailRows: ContractCase[] = [
  {
    // A wrapped CLI call: full captured output vs what the agent saw, and the deep link (DD-19).
    id: 'F24-call-detail',
    route: DETAIL_ROUTE,
    actor: 'owner',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS01Cli.id',
      callId: '@tuS01Cli.callA',
    },
    expect: {
      status: 200,
      bodyMatches: {
        output: {
          input: 'ce build --all | head -20',
          stdout: 'built 12 targets',
          stderr: '',
          agentSaw: 'built 12',
          encoding: 'utf8',
        },
        link: { sessionId: '@s01.sessionId', toolUseId: 'toolu_w1_c1' },
      },
    },
    read: {
      sql: DETAIL_SQL,
      args: ['@tuS01Cli.id', '@tuS01Cli.callA'],
      shape: 'object',
      path: 'call',
      fields: DETAIL_FIELDS,
    },
  },
  {
    // A sub-agent's call links to the tree root's session (s02), not the node (s03).
    id: 'F24-call-detail-subagent',
    route: DETAIL_ROUTE,
    actor: 'owner',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS03Mcp.id',
      callId: '@tuS03Mcp.callA',
    },
    expect: {
      status: 200,
      bodyMatches: {
        link: { sessionId: '@s02.sessionId', toolUseId: 'toolu_w1_q3' },
      },
    },
    read: {
      sql: DETAIL_SQL,
      args: ['@tuS03Mcp.id', '@tuS03Mcp.callA'],
      shape: 'object',
      path: 'call',
      fields: DETAIL_FIELDS,
    },
  },
  {
    id: 'F24-call-detail-unknown-call',
    route: DETAIL_ROUTE,
    actor: 'owner',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS01Cli.id',
      callId: 'w1-no-such-call',
    },
    expect: { status: 404 },
  },
  {
    // The outsider's row is not in R1's scope: the same 404 as a missing call.
    id: 'F24-call-detail-foreign-row',
    route: DETAIL_ROUTE,
    actor: 'owner',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS08Mcp.id',
      callId: '@tuS08Mcp.callA',
    },
    expect: { status: 404 },
  },
  {
    // The member's own call is outside the owner's personal view of R1.
    id: 'F24-call-detail-member-row-personal',
    route: DETAIL_ROUTE,
    actor: 'owner',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS06Cli.id',
      callId: '@tuS06Cli.callA',
    },
    expect: { status: 404 },
  },
  {
    id: 'F24-call-detail-outsider',
    route: DETAIL_ROUTE,
    actor: 'outsider',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS01Cli.id',
      callId: '@tuS01Cli.callA',
    },
    expect: { status: 403 },
  },
  {
    id: 'F24-call-detail-bad-team-id',
    route: DETAIL_ROUTE,
    actor: 'owner',
    params: {
      repoId: '@R1.id',
      usageId: '@tuS01Cli.id',
      callId: '@tuS01Cli.callA',
    },
    query: { teamId: 0 },
    expect: { status: 400 },
  },
];

export const f24ToolMonitoring: ContractFamily = {
  id: 'F24',
  name: 'tool-monitoring',
  cases: [
    ...hookRows,
    ...configRows,
    ...putRows,
    ...summaryRows,
    ...callsRows,
    ...detailRows,
  ],
};
