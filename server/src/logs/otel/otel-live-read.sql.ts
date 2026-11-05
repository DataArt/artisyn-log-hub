/**
 * Read SQL of the OTEL Live view (2026-11-04 otel-live-view): candidate roots, placement under
 * the caller's teams / No team, stored lifetime totals and the selected node's window figures.
 * Every function is read-only (a GET never writes, DD-22) and returns `[]` / zero for an empty
 * root list without touching the DB.
 *
 * - **Candidates (DD-1, DD-5).** A root is live when `GREATEST(rt_last_at, chunk_last_at)` of its
 *   `otel_session_state` row is within `OTEL_SESSION_ENDED_MS` of `now` — read through the
 *   `idx_otel_session_state_last_at` expression index. `GREATEST` ignores NULLs, so it equals
 *   `computeOtelLiveness`.
 * - **Placement (DD-4).** One statement with a `scope_teams(team_id, user_ids)` VALUES CTE (the
 *   per-team row filters) and a multi-team `live_team_repo_ids` CTE, plus the No-team branch.
 * - **Totals (DD-6, DD-22).** `otel_session_totals` / `otel_agent_totals` by primary key; a root
 *   whose session row is missing or older than its newest bucket (`seq < MAX(otel_cost_buckets
 *   .seq)`, one backward step on `idx_otel_cost_buckets_session_seq`) is summed inline from
 *   `otel_calls` instead — the next OTEL write repairs the stored row.
 *
 * Ids reach SQL as `{…}::int[]` literals of validated integers (never free text), as
 * `otelIntArray` in `otel-facts-read.sql.ts`. Amounts are summed in SQL and returned as decimal
 * strings.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { OTEL_SESSION_ENDED_MS } from './otel-facts.constants';
import {
  microsText,
  microsTextOrNull,
  toIso,
  toNum,
} from './otel-facts-read.sql';
import { OTEL_MAIN_AGENT_KEY } from './otel-facts-writer';
import type { OtelStructure } from './otel-facts.types';
import {
  OTEL_LIVE_COST_RATE_MS,
  OTEL_LIVE_EVENTS_LIMIT,
  OTEL_LIVE_FLOW_ROWS,
  OTEL_LIVE_RETAIN_MAX_MS,
  OTEL_LIVE_TOP_N,
  OTEL_LIVE_TOP_TOOLS,
} from './otel-live.constants';
import type {
  OtelLiveAgentFilter,
  OtelLiveAgentRow,
  OtelLiveBucket,
  OtelLiveCallRow,
  OtelLiveCandidate,
  OtelLiveEvent,
  OtelLiveFlowRow,
  OtelLiveLatencyBucket,
  OtelLivePlacementRow,
  OtelLiveRootTotalsRow,
  OtelLiveScopeTeam,
  OtelLiveSpark,
  OtelLiveTopModel,
  OtelLiveTopTool,
  OtelLiveWindow,
} from './otel-live.types';
import { OTEL_SPAN_LLM_REQUEST, OTEL_SPAN_TOOL } from './otel-span-names';

type DbValue = string | number | null | undefined;
type DbDate = Date | string | null | undefined;

/** The 5-minute grain origin of `date_bin` (UTC-aligned, as `bucketStart5m`). */
const BIN_5M = sql`date_bin('5 minutes', `;
const BIN_ORIGIN = sql`, TIMESTAMPTZ '1970-01-01Z')`;

/** `{…}::int[]` literal of integer ids; non-integers are dropped (never free text). */
function intArray(ids: readonly number[]): SQL {
  const clean = ids.filter((id) => Number.isInteger(id));
  return sql`${`{${clean.join(',')}}`}::int[]`;
}

function bin5m(column: SQL): SQL {
  return sql`${BIN_5M}${column}${BIN_ORIGIN}`;
}

function isoOrEpoch(value: DbDate): string {
  return toIso(value) ?? new Date(0).toISOString();
}

/**
 * The agent predicate on an `otel_calls` alias (DD-3): `main` = no `agent_id` and not hidden,
 * otherwise the agent id itself; always narrowed to the agent's root.
 */
function callAgentSql(
  agent: OtelLiveAgentFilter | undefined,
  alias: string,
): SQL {
  if (agent === undefined) return sql``;
  const a = sql.raw(alias);
  return agent.agentKey === OTEL_MAIN_AGENT_KEY
    ? sql`AND ${a}.session_id = ${agent.rootId} AND ${a}.agent_id IS NULL
          AND ${a}.structure <> 'hidden'`
    : sql`AND ${a}.session_id = ${agent.rootId} AND ${a}.agent_id = ${agent.agentKey}`;
}

/**
 * The agent predicate on an `otel_spans` alias. Spans carry no structure, so `main` excludes the
 * spans whose call (by `request_id`) is hidden.
 */
function spanAgentSql(
  agent: OtelLiveAgentFilter | undefined,
  alias: string,
): SQL {
  if (agent === undefined) return sql``;
  const a = sql.raw(alias);
  return agent.agentKey === OTEL_MAIN_AGENT_KEY
    ? sql`AND ${a}.session_id = ${agent.rootId} AND ${a}.agent_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM otel_calls hc
             WHERE hc.session_id = ${a}.session_id AND hc.call_key = ${a}.request_id
               AND hc.structure = 'hidden')`
    : sql`AND ${a}.session_id = ${agent.rootId} AND ${a}.agent_id = ${agent.agentKey}`;
}

// ---------------------------------------------------------------------------
// Candidates, teams, labels (DD-1, DD-4, DD-5)
// ---------------------------------------------------------------------------

/**
 * The live roots (DD-1) plus the retained `retainedRootIds` whose last activity is within
 * `OTEL_LIVE_RETAIN_MAX_MS` (DD-5); `live` per DD-1 for both. With `recentMs`, the roots whose
 * last activity is within it come too (ended ones as `live: false`); the header status omits it.
 */
export async function loadOtelLiveCandidateRoots(
  db: DrizzleDb,
  now: Date,
  retainedRootIds: number[],
  recentMs?: number,
): Promise<OtelLiveCandidate[]> {
  const liveFrom = new Date(now.getTime() - OTEL_SESSION_ENDED_MS);
  // Same index range scan as the live filter, only a longer range.
  const listFrom =
    recentMs === undefined ? liveFrom : new Date(now.getTime() - recentMs);
  const retainFrom = new Date(now.getTime() - OTEL_LIVE_RETAIN_MAX_MS);
  const retained =
    retainedRootIds.length === 0
      ? sql``
      : sql`UNION
    SELECT s.session_id AS root_id,
           GREATEST(s.rt_last_at, s.chunk_last_at) >= ${liveFrom} AS live
      FROM otel_session_state s
     WHERE s.session_id = ANY(${intArray(retainedRootIds)})
       AND GREATEST(s.rt_last_at, s.chunk_last_at) >= ${retainFrom}`;
  const result = await db.execute(sql`
    SELECT s.session_id AS root_id,
           GREATEST(s.rt_last_at, s.chunk_last_at) >= ${liveFrom} AS live
      FROM otel_session_state s
     WHERE GREATEST(s.rt_last_at, s.chunk_last_at) >= ${listFrom}
    ${retained}
  `);
  const byRoot = new Map<number, boolean>();
  for (const r of result.rows as unknown as {
    root_id: DbValue;
    live: boolean | null;
  }[]) {
    const id = toNum(r.root_id);
    byRoot.set(id, byRoot.get(id) === true || r.live === true);
  }
  return [...byRoot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rootId, live]) => ({ rootId, live }));
}

/** The caller's teams by name (DD-4; the membership rule of `isOtelTeamMember`). */
export async function loadOtelLiveTeams(
  db: DrizzleDb,
  callerId: number,
): Promise<{ teamId: number; teamName: string }[]> {
  const result = await db.execute(sql`
    SELECT t.id, t.name
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = ${callerId}
     ORDER BY t.name, t.id
  `);
  return (result.rows as unknown as { id: DbValue; name: string }[]).map(
    (r) => ({
      teamId: toNum(r.id),
      teamName: r.name,
    }),
  );
}

/**
 * The label (`repo_url`) of a retained repo key (DD-5): a team repository id of a team the
 * caller belongs to (`teamId`), or a `repositories` row the caller owns (`teamId` null = No
 * team). Null when the caller cannot see it.
 */
export async function loadOtelLiveRepoLabel(
  db: DrizzleDb,
  callerId: number,
  teamId: number | null,
  repoId: number,
): Promise<string | null> {
  const result =
    teamId === null
      ? await db.execute(sql`
          SELECT r.repo_url
            FROM repositories r
           WHERE r.id = ${repoId} AND r.user_id = ${callerId}
        `)
      : await db.execute(sql`
          WITH tri AS (
            SELECT MIN(r.id) OVER (PARTITION BY tr.repo_url) AS team_repo_id, tr.repo_url
              FROM team_repositories tr
              JOIN team_members tm ON tm.team_id = tr.team_id
              JOIN repositories r ON r.repo_url = tr.repo_url AND r.user_id = tm.user_id
             WHERE tr.team_id = ${teamId}
          )
          SELECT tri.repo_url
            FROM tri
           WHERE tri.team_repo_id = ${repoId}
             AND EXISTS (SELECT 1 FROM team_members
                          WHERE team_id = ${teamId} AND user_id = ${callerId})
           LIMIT 1
        `);
  const row = (result.rows as unknown as { repo_url: string | null }[])[0];
  return row?.repo_url ?? null;
}

// ---------------------------------------------------------------------------
// Placement (DD-4)
// ---------------------------------------------------------------------------

/** `scope_teams(team_id, user_ids)`: one row per caller team, its effective row filter. */
function scopeTeamsCte(scopeTeams: OtelLiveScopeTeam[]): SQL {
  if (scopeTeams.length === 0) {
    return sql`scope_teams(team_id, user_ids) AS (
      SELECT NULL::int, NULL::int[] WHERE false
    )`;
  }
  const rows = scopeTeams.map((t) =>
    t.userIds === null
      ? sql`(${t.teamId}::int, NULL::int[])`
      : sql`(${t.teamId}::int, ${intArray(t.userIds)})`,
  );
  return sql`scope_teams(team_id, user_ids) AS (VALUES ${sql.join(rows, sql`, `)})`;
}

interface PlacementDbRow {
  root_id: DbValue;
  user_id: DbValue;
  user_email: string;
  team_id: DbValue;
  repo_id: DbValue;
  repo_url: string;
  first_prompt: string | null;
  session_uuid: string;
  start_time: DbDate;
}

/**
 * Where each of `rootIds` is placed (DD-4): one row per (root, team, team repository) whose URL
 * the root's `artisyn` log links to and whose uploader passes the team's row filter, plus one
 * row per (root, own repository) linked to no team of the caller (No team, `teamId` null).
 * Deleted sessions and roots with no repository link are not placed.
 */
export async function loadOtelLivePlacements(
  db: DrizzleDb,
  callerId: number,
  scopeTeams: OtelLiveScopeTeam[],
  rootIds: number[],
): Promise<OtelLivePlacementRow[]> {
  if (rootIds.length === 0) return [];
  const result = await db.execute(sql`
    WITH ${scopeTeamsCte(scopeTeams)},
    live_team_repo_ids AS (
      SELECT tr.team_id, r.id AS repo_id,
             MIN(r.id) OVER (PARTITION BY tr.team_id, tr.repo_url) AS team_repo_id,
             tr.repo_url
        FROM team_repositories tr
        JOIN team_members tm ON tm.team_id = tr.team_id
        JOIN repositories r ON r.repo_url = tr.repo_url AND r.user_id = tm.user_id
       WHERE tr.team_id IN (SELECT team_id FROM scope_teams)
    ),
    root_logs AS (
      SELECT s.id AS root_id, s.session_id AS session_uuid, l.id AS log_id, l.user_id,
             l.first_prompt, l.start_time
        FROM sessions s
        JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
       WHERE s.id = ANY(${intArray(rootIds)})
         AND s.deleted = false
    ),
    team_placed AS (
      SELECT DISTINCT rl.root_id, rl.user_id, tri.team_id, tri.team_repo_id AS repo_id,
             tri.repo_url
        FROM root_logs rl
        JOIN log_repositories lr ON lr.log_id = rl.log_id
        JOIN live_team_repo_ids tri ON tri.repo_id = lr.repo_id
        JOIN scope_teams st ON st.team_id = tri.team_id
       WHERE st.user_ids IS NULL OR rl.user_id = ANY(st.user_ids)
    ),
    noteam_placed AS (
      SELECT DISTINCT rl.root_id, rl.user_id, NULL::int AS team_id, r.id AS repo_id, r.repo_url
        FROM root_logs rl
        JOIN log_repositories lr ON lr.log_id = rl.log_id
        JOIN repositories r ON r.id = lr.repo_id
       WHERE r.user_id = ${callerId}
         AND rl.user_id = ${callerId}
         AND NOT EXISTS (
           SELECT 1
             FROM team_repositories tr2
             JOIN team_members tm2 ON tm2.team_id = tr2.team_id AND tm2.user_id = ${callerId}
            WHERE tr2.repo_url = r.repo_url)
    ),
    placed AS (
      SELECT * FROM team_placed
      UNION ALL
      SELECT * FROM noteam_placed
    )
    SELECT p.root_id, p.user_id, u.email AS user_email, p.team_id, p.repo_id, p.repo_url,
           rl.first_prompt, rl.session_uuid, rl.start_time
      FROM placed p
      JOIN root_logs rl ON rl.root_id = p.root_id
      JOIN users u ON u.id = p.user_id
     ORDER BY p.root_id, p.team_id NULLS LAST, p.repo_id
  `);
  return (result.rows as unknown as PlacementDbRow[]).map((r) => ({
    rootId: toNum(r.root_id),
    userId: toNum(r.user_id),
    userEmail: r.user_email,
    teamId:
      r.team_id === null || r.team_id === undefined ? null : toNum(r.team_id),
    repoId: toNum(r.repo_id),
    repoLabel: r.repo_url,
    firstPrompt: r.first_prompt,
    sessionUuid: r.session_uuid,
    startedAt: toIso(r.start_time),
  }));
}

// ---------------------------------------------------------------------------
// Stored totals (DD-6, DD-22)
// ---------------------------------------------------------------------------

/**
 * `ids(id)` and `fresh(id, stale)`: each root and whether its stored session totals row is
 * missing or older than its newest bucket (the DD-22 read-path check).
 */
function freshnessCtes(rootIds: number[]): SQL {
  return sql`ids AS (
      SELECT unnest(${intArray(rootIds)}) AS id
    ),
    fresh AS (
      SELECT ids.id,
             (t.session_id IS NULL OR t.seq < COALESCE((
               SELECT b.seq FROM otel_cost_buckets b
                WHERE b.session_id = ids.id
                ORDER BY b.seq DESC
                LIMIT 1), 0)) AS stale
        FROM ids
        LEFT JOIN otel_session_totals t ON t.session_id = ids.id
    )`;
}

interface TotalsDbRow {
  root_id: DbValue;
  calls: DbValue;
  cost: DbValue;
  input_tokens: DbValue;
  output_tokens: DbValue;
  cache_read_tokens: DbValue;
  cache_write_tokens: DbValue;
  first_at: DbDate;
  last_at: DbDate;
}

/**
 * Lifetime totals of each root ("since start", DD-6): the stored `otel_session_totals` row, or —
 * for a missing / stale row — the inline read-only `GROUP BY` over `otel_calls` (DD-22).
 */
export async function loadOtelLiveRootTotals(
  db: DrizzleDb,
  rootIds: number[],
): Promise<OtelLiveRootTotalsRow[]> {
  if (rootIds.length === 0) return [];
  const result = await db.execute(sql`
    WITH ${freshnessCtes(rootIds)}
    SELECT t.session_id AS root_id, t.calls, t.cost_usd_micros AS cost, t.input_tokens,
           t.output_tokens, t.cache_read_tokens, t.cache_write_tokens,
           t.first_call_at AS first_at, t.last_call_at AS last_at
      FROM fresh f
      JOIN otel_session_totals t ON t.session_id = f.id
     WHERE NOT f.stale
    UNION ALL
    SELECT f.id AS root_id,
           COUNT(c.session_id) AS calls,
           COALESCE(SUM(c.cost_usd_micros), 0) AS cost,
           COALESCE(SUM(c.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(c.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(c.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(c.cache_write_tokens), 0) AS cache_write_tokens,
           MIN(c.event_time) AS first_at, MAX(c.event_time) AS last_at
      FROM fresh f
      LEFT JOIN otel_calls c ON c.session_id = f.id
     WHERE f.stale
     GROUP BY f.id
     ORDER BY 1
  `);
  return (result.rows as unknown as TotalsDbRow[]).map((r) => ({
    rootId: toNum(r.root_id),
    costUsdMicros: microsText(r.cost),
    inputTokens: microsText(r.input_tokens),
    outputTokens: microsText(r.output_tokens),
    cacheReadTokens: microsText(r.cache_read_tokens),
    cacheWriteTokens: microsText(r.cache_write_tokens),
    calls: toNum(r.calls),
    firstEventAt: toIso(r.first_at),
    lastActivityAt: toIso(r.last_at),
  }));
}

interface AgentDbRow extends TotalsDbRow {
  agent_key: string;
  agent_name: string | null;
}

/**
 * Agents with calls of each root (DD-3, DD-6): stored `otel_agent_totals` rows, or — for a root
 * whose session totals are missing / stale — grouped inline by the `otelAgentKeyOf` rule
 * (`agent_id`, else `main`; hidden calls have no agent). `agentLabel` = `agent_name`, else the key.
 */
export async function loadOtelLiveAgents(
  db: DrizzleDb,
  rootIds: number[],
): Promise<OtelLiveAgentRow[]> {
  if (rootIds.length === 0) return [];
  const result = await db.execute(sql`
    WITH ${freshnessCtes(rootIds)}
    SELECT a.session_id AS root_id, a.agent_key, a.agent_name, a.calls,
           a.cost_usd_micros AS cost, a.input_tokens, a.output_tokens, a.cache_read_tokens,
           a.cache_write_tokens, a.first_call_at AS first_at, a.last_call_at AS last_at
      FROM fresh f
      JOIN otel_agent_totals a ON a.session_id = f.id
     WHERE NOT f.stale AND a.calls > 0
    UNION ALL
    SELECT c.session_id AS root_id,
           COALESCE(c.agent_id, ${OTEL_MAIN_AGENT_KEY}) AS agent_key,
           (array_agg(c.agent_name ORDER BY c.event_time DESC)
              FILTER (WHERE c.agent_name IS NOT NULL))[1] AS agent_name,
           COUNT(*) AS calls,
           COALESCE(SUM(c.cost_usd_micros), 0) AS cost,
           COALESCE(SUM(c.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(c.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(c.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(c.cache_write_tokens), 0) AS cache_write_tokens,
           MIN(c.event_time) AS first_at, MAX(c.event_time) AS last_at
      FROM fresh f
      JOIN otel_calls c ON c.session_id = f.id
     WHERE f.stale AND c.structure <> 'hidden'
     -- By position: a repeated bound parameter is a new $n, so the expression would not match.
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  return (result.rows as unknown as AgentDbRow[]).map((r) => ({
    rootId: toNum(r.root_id),
    agentKey: r.agent_key,
    agentLabel: r.agent_name ?? r.agent_key,
    costUsdMicros: microsText(r.cost),
    inputTokens: microsText(r.input_tokens),
    outputTokens: microsText(r.output_tokens),
    cacheReadTokens: microsText(r.cache_read_tokens),
    cacheWriteTokens: microsText(r.cache_write_tokens),
    calls: toNum(r.calls),
    firstEventAt: isoOrEpoch(r.first_at),
    lastEventAt: isoOrEpoch(r.last_at),
  }));
}

// ---------------------------------------------------------------------------
// Charts (DD-7)
// ---------------------------------------------------------------------------

interface BucketDbRow {
  start: DbDate;
  structure: string;
  model: string | null;
  skill: string | null;
  mcp_server: string | null;
  calls: DbValue;
  cost: DbValue;
  input_tokens: DbValue;
  output_tokens: DbValue;
  cache_read_tokens: DbValue;
  cache_write_tokens: DbValue;
}

/**
 * One row per `(bucket_start, structure, model, skill, mcp_server)` in `window` over the DISTINCT
 * `rootIds` (DD-7): from `otel_cost_buckets`, or — for an agent, which buckets do not carry —
 * from that agent's `otel_calls` binned by `date_bin('5 minutes', …)`.
 */
export async function loadOtelLiveBuckets(
  db: DrizzleDb,
  rootIds: number[],
  window: OtelLiveWindow,
  agent?: OtelLiveAgentFilter,
): Promise<OtelLiveBucket[]> {
  if (rootIds.length === 0) return [];
  const query =
    agent === undefined
      ? sql`
    SELECT b.bucket_start AS start, b.structure, b.model, b.skill, b.mcp_server,
           SUM(b.calls) AS calls, SUM(b.cost_usd_micros) AS cost,
           SUM(b.input_tokens) AS input_tokens, SUM(b.output_tokens) AS output_tokens,
           SUM(b.cache_read_tokens) AS cache_read_tokens,
           SUM(b.cache_write_tokens) AS cache_write_tokens
      FROM otel_cost_buckets b
     WHERE b.session_id = ANY(${intArray(rootIds)})
       AND b.bucket_start >= ${window.from}
       AND b.bucket_start < ${window.to}
       AND b.calls <> 0
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1, 2, 3, 4, 5`
      : sql`
    SELECT ${bin5m(sql`c.event_time`)} AS start, c.structure,
           COALESCE(c.model, '') AS model, COALESCE(c.skill_name, '') AS skill,
           COALESCE(c.mcp_server_name, '') AS mcp_server,
           COUNT(*) AS calls, COALESCE(SUM(c.cost_usd_micros), 0) AS cost,
           SUM(c.input_tokens) AS input_tokens, SUM(c.output_tokens) AS output_tokens,
           SUM(c.cache_read_tokens) AS cache_read_tokens,
           SUM(c.cache_write_tokens) AS cache_write_tokens
      FROM otel_calls c
     WHERE c.session_id = ANY(${intArray(rootIds)})
       AND c.event_time >= ${window.from}
       AND c.event_time < ${window.to}
       ${callAgentSql(agent, 'c')}
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1, 2, 3, 4, 5`;
  const result = await db.execute(query);
  return (result.rows as unknown as BucketDbRow[]).map((r) => ({
    start: isoOrEpoch(r.start),
    structure: r.structure as OtelStructure,
    model: r.model ?? '',
    skill: r.skill ?? '',
    mcpServer: r.mcp_server ?? '',
    calls: toNum(r.calls),
    costUsdMicros: microsText(r.cost),
    inputTokens: microsText(r.input_tokens),
    outputTokens: microsText(r.output_tokens),
    cacheReadTokens: microsText(r.cache_read_tokens),
    cacheWriteTokens: microsText(r.cache_write_tokens),
  }));
}

/**
 * Span latency per `(5-minute bucket, kind)` in `window` (DD-7): `llm` = LLM-request spans,
 * `tool` = tool spans; finished spans only. `failed` = spans with `attributes.success = 'false'`.
 */
export async function loadOtelLiveLatency(
  db: DrizzleDb,
  rootIds: number[],
  window: OtelLiveWindow,
  agent?: OtelLiveAgentFilter,
): Promise<OtelLiveLatencyBucket[]> {
  if (rootIds.length === 0) return [];
  const result = await db.execute(sql`
    WITH d AS (
      SELECT ${bin5m(sql`s.start_time`)} AS start,
             CASE WHEN s.name = ${OTEL_SPAN_LLM_REQUEST} THEN 'llm' ELSE 'tool' END AS kind,
             EXTRACT(EPOCH FROM (s.end_time - s.start_time)) * 1000 AS ms,
             (s.attributes->>'success') = 'false' AS failed
        FROM otel_spans s
       WHERE s.session_id = ANY(${intArray(rootIds)})
         AND s.name IN (${OTEL_SPAN_LLM_REQUEST}, ${OTEL_SPAN_TOOL})
         AND s.end_time IS NOT NULL
         AND s.start_time >= ${window.from}
         AND s.start_time < ${window.to}
         ${spanAgentSql(agent, 's')}
    )
    SELECT start, kind, COUNT(*) AS count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
           COUNT(*) FILTER (WHERE failed) AS failed
      FROM d
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  return (
    result.rows as unknown as {
      start: DbDate;
      kind: string;
      count: DbValue;
      p50: DbValue;
      p95: DbValue;
      failed: DbValue;
    }[]
  ).map((r) => ({
    start: isoOrEpoch(r.start),
    kind: r.kind === 'llm' ? 'llm' : 'tool',
    count: toNum(r.count),
    p50Ms: Math.round(toNum(r.p50)),
    p95Ms: Math.round(toNum(r.p95)),
    failed: toNum(r.failed),
  }));
}

// ---------------------------------------------------------------------------
// Cost rate and agent calls (DD-8, DD-9)
// ---------------------------------------------------------------------------

/**
 * The header sparkline: `otel_calls` tokens and cost of the last `minutes` minutes over
 * `rootIds`, one point per minute counted back from `now` (see `OtelLiveSpark`).
 */
export async function loadOtelLiveSpark(
  db: DrizzleDb,
  rootIds: number[],
  now: Date,
  minutes: number,
): Promise<OtelLiveSpark> {
  const spark: OtelLiveSpark = {
    minutes,
    tokens: new Array<number>(minutes).fill(0),
    costUsdMicros: new Array<string>(minutes).fill('0'),
  };
  if (rootIds.length === 0 || minutes <= 0) return spark;
  const from = new Date(now.getTime() - minutes * 60_000);
  const result = await db.execute(sql`
    SELECT floor(EXTRACT(EPOCH FROM (${now}::timestamptz - c.event_time)) / 60)::int AS age,
           SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_tokens)
             AS tokens,
           COALESCE(SUM(c.cost_usd_micros), 0) AS cost
      FROM otel_calls c
     WHERE c.session_id = ANY(${intArray(rootIds)})
       AND c.event_time > ${from}
       AND c.event_time <= ${now}
     GROUP BY 1
  `);
  for (const r of result.rows as unknown as {
    age: DbValue;
    tokens: DbValue;
    cost: DbValue;
  }[]) {
    const i = minutes - 1 - toNum(r.age);
    if (i < 0 || i >= minutes) continue;
    spark.tokens[i] = toNum(r.tokens);
    spark.costUsdMicros[i] = microsText(r.cost);
  }
  return spark;
}

/**
 * Cost per minute (DD-8): the `otel_calls` cost of the last `OTEL_LIVE_COST_RATE_MS` over
 * `rootIds` (and the agent), floor-divided by its length in minutes; a decimal string.
 */
export async function loadOtelLiveCostRate(
  db: DrizzleDb,
  rootIds: number[],
  now: Date,
  agent?: OtelLiveAgentFilter,
): Promise<string> {
  if (rootIds.length === 0) return '0';
  const from = new Date(now.getTime() - OTEL_LIVE_COST_RATE_MS);
  const minutes = Math.max(1, Math.floor(OTEL_LIVE_COST_RATE_MS / 60_000));
  const result = await db.execute(sql`
    SELECT div(COALESCE(SUM(c.cost_usd_micros), 0), ${minutes}) AS rate
      FROM otel_calls c
     WHERE c.session_id = ANY(${intArray(rootIds)})
       AND c.event_time > ${from}
       ${callAgentSql(agent, 'c')}
  `);
  const row = (result.rows as unknown as { rate: DbValue }[])[0];
  return microsText(row?.rate);
}

interface CallDbRow {
  call_key: string;
  event_time: DbDate;
  model: string | null;
  agent_key: string;
  agent_name: string | null;
  structure: string;
  cost_usd_micros: DbValue;
  input_tokens: DbValue;
  output_tokens: DbValue;
  cache_read_tokens: DbValue;
  cache_write_tokens: DbValue;
  duration_ms: DbValue;
}

/**
 * The agent's latest `limit` calls, newest first (DD-9). `durationMs` comes from the LLM-request
 * span with the call's `request_id`, else null.
 */
export async function loadOtelLiveCalls(
  db: DrizzleDb,
  agent: OtelLiveAgentFilter,
  limit: number,
): Promise<OtelLiveCallRow[]> {
  const result = await db.execute(sql`
    SELECT c.call_key, c.event_time, c.model,
           COALESCE(c.agent_id, ${OTEL_MAIN_AGENT_KEY}) AS agent_key, c.agent_name,
           c.structure, c.cost_usd_micros, c.input_tokens, c.output_tokens,
           c.cache_read_tokens, c.cache_write_tokens, sp.duration_ms
      FROM otel_calls c
      LEFT JOIN LATERAL (
        SELECT EXTRACT(EPOCH FROM (s.end_time - s.start_time)) * 1000 AS duration_ms
          FROM otel_spans s
         WHERE s.session_id = c.session_id
           AND s.request_id = c.request_id
           AND s.name = ${OTEL_SPAN_LLM_REQUEST}
           AND s.end_time IS NOT NULL
         ORDER BY s.start_time DESC
         LIMIT 1
      ) sp ON true
     WHERE c.session_id = ${agent.rootId}
       ${callAgentSql(agent, 'c')}
     ORDER BY c.event_time DESC, c.call_key DESC
     LIMIT ${Math.max(0, Math.floor(limit))}
  `);
  return (result.rows as unknown as CallDbRow[]).map((r) => ({
    callKey: r.call_key,
    eventTime: isoOrEpoch(r.event_time),
    model: r.model,
    agentKey: r.agent_key,
    agentLabel: r.agent_name ?? r.agent_key,
    structure: r.structure as OtelStructure,
    costUsdMicros: microsTextOrNull(r.cost_usd_micros),
    inputTokens: toNum(r.input_tokens),
    outputTokens: toNum(r.output_tokens),
    cacheReadTokens: toNum(r.cache_read_tokens),
    cacheWriteTokens: toNum(r.cache_write_tokens),
    durationMs:
      r.duration_ms === null || r.duration_ms === undefined
        ? null
        : Math.round(toNum(r.duration_ms)),
  }));
}

// ---------------------------------------------------------------------------
// Details (DD-10)
// ---------------------------------------------------------------------------

/**
 * Top `OTEL_LIVE_TOP_N` models by cost in `window` ("last 2 h") over `rootIds`: from the cost
 * buckets, or the agent's calls. `model` '' = not reported.
 */
export async function loadOtelLiveTopModels(
  db: DrizzleDb,
  rootIds: number[],
  window: OtelLiveWindow,
  agent?: OtelLiveAgentFilter,
): Promise<OtelLiveTopModel[]> {
  if (rootIds.length === 0) return [];
  const query =
    agent === undefined
      ? sql`
    SELECT b.model, SUM(b.calls) AS calls, SUM(b.cost_usd_micros) AS cost
      FROM otel_cost_buckets b
     WHERE b.session_id = ANY(${intArray(rootIds)})
       AND b.bucket_start >= ${window.from}
       AND b.bucket_start < ${window.to}
       AND b.calls <> 0
     GROUP BY b.model`
      : sql`
    SELECT COALESCE(c.model, '') AS model, COUNT(*) AS calls,
           COALESCE(SUM(c.cost_usd_micros), 0) AS cost
      FROM otel_calls c
     WHERE c.session_id = ANY(${intArray(rootIds)})
       AND c.event_time >= ${window.from}
       AND c.event_time < ${window.to}
       ${callAgentSql(agent, 'c')}
     GROUP BY 1`;
  const result = await db.execute(sql`
    SELECT model, calls, cost FROM (${query}) m
     ORDER BY cost DESC, calls DESC, model
     LIMIT ${OTEL_LIVE_TOP_N}
  `);
  return (
    result.rows as unknown as {
      model: string | null;
      calls: DbValue;
      cost: DbValue;
    }[]
  ).map((r) => ({
    model: r.model ?? '',
    calls: toNum(r.calls),
    costUsdMicros: microsText(r.cost),
  }));
}

/**
 * Sankey rows of the Live view over `window` (2026-11-05 follow-up), from `otel_calls` through
 * the `(session_id, event_time)` index: per `(root, model)`, or with `byAgent` per
 * `(root, model, agent)` where hidden calls get a null agent. At most `OTEL_LIVE_FLOW_ROWS`,
 * largest cost first.
 */
export async function loadOtelLiveFlows(
  db: DrizzleDb,
  rootIds: number[],
  window: OtelLiveWindow,
  byAgent: boolean,
): Promise<OtelLiveFlowRow[]> {
  if (rootIds.length === 0) return [];
  const agentKey = byAgent
    ? sql`CASE WHEN c.structure = 'hidden' THEN NULL
               ELSE COALESCE(c.agent_id, ${OTEL_MAIN_AGENT_KEY}) END`
    : sql`NULL::text`;
  const agentLabel = byAgent
    ? sql`(array_agg(c.agent_name ORDER BY c.event_time DESC)
             FILTER (WHERE c.agent_name IS NOT NULL))[1]`
    : sql`NULL::text`;
  // Grouped by position: a repeated bound expression would become a new parameter.
  const result = await db.execute(sql`
    SELECT c.session_id AS root_id, COALESCE(c.model, '') AS model, ${agentKey} AS agent_key,
           ${agentLabel} AS agent_label, COUNT(*) AS calls,
           COALESCE(SUM(c.cost_usd_micros), 0) AS cost,
           COALESCE(SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)
                      + COALESCE(c.cache_read_tokens, 0) + COALESCE(c.cache_write_tokens, 0)), 0)
             AS tokens
      FROM otel_calls c
     WHERE c.session_id = ANY(${intArray(rootIds)})
       AND c.event_time >= ${window.from}
       AND c.event_time < ${window.to}
     GROUP BY 1, 2, 3
     ORDER BY cost DESC, tokens DESC, 1, 2, 3
     LIMIT ${OTEL_LIVE_FLOW_ROWS}
  `);
  return (
    result.rows as unknown as {
      root_id: DbValue;
      model: string | null;
      agent_key: string | null;
      agent_label: string | null;
      calls: DbValue;
      cost: DbValue;
      tokens: DbValue;
    }[]
  ).map((r) => ({
    rootId: toNum(r.root_id),
    model: r.model ?? '',
    agentKey: r.agent_key,
    agentLabel: r.agent_label,
    costUsdMicros: microsText(r.cost),
    calls: toNum(r.calls),
    tokens: microsText(r.tokens),
  }));
}

/**
 * Top `OTEL_LIVE_TOP_TOOLS` tools of one root (or agent) by tool spans started in `window`
 * ("last 2 h"); `failed` = `attributes.success = 'false'`. Masking is the reader's (DD-11).
 */
export async function loadOtelLiveTopTools(
  db: DrizzleDb,
  rootId: number,
  window: OtelLiveWindow,
  agent?: OtelLiveAgentFilter,
): Promise<OtelLiveTopTool[]> {
  const result = await db.execute(sql`
    SELECT s.attributes->>'tool_name' AS name, COUNT(*) AS calls,
           COUNT(*) FILTER (WHERE (s.attributes->>'success') = 'false') AS failed
      FROM otel_spans s
     WHERE s.session_id = ${rootId}
       AND s.name = ${OTEL_SPAN_TOOL}
       AND s.start_time >= ${window.from}
       AND s.start_time < ${window.to}
       AND s.attributes->>'tool_name' IS NOT NULL
       ${spanAgentSql(agent, 's')}
     GROUP BY 1
     ORDER BY 2 DESC, 1
     LIMIT ${OTEL_LIVE_TOP_TOOLS}
  `);
  return (
    result.rows as unknown as {
      name: string;
      calls: DbValue;
      failed: DbValue;
    }[]
  ).map((r) => ({
    name: r.name,
    calls: toNum(r.calls),
    failed: toNum(r.failed),
  }));
}

/**
 * The latest `OTEL_LIVE_EVENTS_LIMIT` events of one root (or agent), newest first: calls
 * (`api_request`, label = model) merged with tool spans (`tool`, label = tool name). Tool labels
 * are masked by the reader (DD-11).
 */
export async function loadOtelLiveEvents(
  db: DrizzleDb,
  rootId: number,
  agent?: OtelLiveAgentFilter,
): Promise<OtelLiveEvent[]> {
  const result = await db.execute(sql`
    SELECT time, kind, label, cost FROM (
      (SELECT c.event_time AS time, 'api_request' AS kind, c.model AS label,
              c.cost_usd_micros AS cost
         FROM otel_calls c
        WHERE c.session_id = ${rootId}
          ${callAgentSql(agent, 'c')}
        ORDER BY c.event_time DESC
        LIMIT ${OTEL_LIVE_EVENTS_LIMIT})
      UNION ALL
      (SELECT s.start_time AS time, 'tool' AS kind, s.attributes->>'tool_name' AS label,
              s.cost_usd_micros AS cost
         FROM otel_spans s
        WHERE s.session_id = ${rootId}
          AND s.name = ${OTEL_SPAN_TOOL}
          ${spanAgentSql(agent, 's')}
        ORDER BY s.start_time DESC
        LIMIT ${OTEL_LIVE_EVENTS_LIMIT})
    ) e
     ORDER BY time DESC, kind
     LIMIT ${OTEL_LIVE_EVENTS_LIMIT}
  `);
  return (
    result.rows as unknown as {
      time: DbDate;
      kind: string;
      label: string | null;
      cost: DbValue;
    }[]
  ).map((r) => ({
    time: isoOrEpoch(r.time),
    kind: r.kind === 'tool' ? 'tool' : 'api_request',
    label: r.label,
    costUsdMicros: microsTextOrNull(r.cost),
  }));
}

/** The latest reported `claude_code_version` of one root's calls, or null. */
export async function loadOtelLiveClaudeVersion(
  db: DrizzleDb,
  rootId: number,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT c.claude_code_version
      FROM otel_calls c
     WHERE c.session_id = ${rootId} AND c.claude_code_version IS NOT NULL
     ORDER BY c.event_time DESC
     LIMIT 1
  `);
  const row = (
    result.rows as unknown as { claude_code_version: string | null }[]
  )[0];
  return row?.claude_code_version ?? null;
}
