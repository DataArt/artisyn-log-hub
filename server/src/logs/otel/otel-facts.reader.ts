/**
 * Reader of the OTEL tabs (2026-10-30 otel-tabs-traces): assembles the repository facts
 * (`GET /api/v1/repositories/:repoId/otel/facts`) and the session OTEL response
 * (`GET /api/v1/repositories/:repoId/sessions/:sessionId/otel`) from `otel-facts-read.sql.ts`.
 *
 * **Session reader rule (DD-2).** One `REPEATABLE READ READ ONLY` transaction reads the root's
 * `otel_session_state.seq` = S first, then every row with `since < seq` — writers of one root
 * are serialized and commit in seq order, so the snapshot holds exactly the rows up to S — and
 * answers `cursor = v1.S`. An unknown cursor version, or a value above S, gets a full snapshot.
 * `since = S` takes the empty-delta fast path.
 *
 * **Masking (DD-22).** A `team-no-prompts` caller (a manager in a restricted team) viewing
 * another member's session gets no span `attributes` (`attributesMasked: true`) and a masked
 * `firstPrompt` in the repository sessions table.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { compareVersions, maxVersion } from '../../common/semver';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { costExcludesUtilityCallsSql } from '../otel-cost.sql';
import { maskFirstPrompt, type TeamScope } from '../team-scope';
import { pickOtelInterval } from './otel-classify';
import {
  countUnconfirmed,
  isOtelTeamMember,
  loadFilterOptions,
  loadFlowRows,
  loadKpiSums,
  loadOtelCoverage,
  loadOtelStatusRow,
  loadOtelTeamPeople,
  loadOtelTeamPeopleOptions,
  loadOtelTeamRepoCounts,
  loadOtelTeamRepos,
  loadOtelTeamRepositories,
  loadPresence,
  loadQuerySourceRows,
  loadRealtimeCounts,
  loadRepoHookVersions,
  loadRolledBuckets,
  loadScopedRootOwner,
  loadSessionBucketSpan,
  loadSessionCalls,
  loadSessionDeltaBuckets,
  loadSessionRows,
  loadSessionSpans,
  OTEL_NO_FILTERS,
  OTEL_TEAM_BUCKET_EXTRA,
  otelScopedRootsCtes,
  otelTeamRootsCtes,
  readOtelStateRow,
  repoBucketSource,
  resolveOtelRoot,
  sessionBucketSource,
  stackKeySql,
  teamStackKeySql,
  toIso,
  type OtelBucketFilters,
  type OtelBucketSqlRow,
  type OtelCoverageSqlRow,
  type OtelKpiSums,
  type OtelQuerySourceSqlRow,
  type OtelReadScope,
  type OtelStateRow,
  type OtelStatusSqlRow,
  type OtelTeamScope,
  type OtelWindow,
} from './otel-facts-read.sql';
import {
  OTEL_CHUNK_DELAY_MS,
  OTEL_CURSOR_PREFIX,
  OTEL_FLOWS_LIMIT,
  OTEL_LIVE_HOOK_MIN_VERSION,
  OTEL_NO_STATUS_REASON,
  OTEL_REASON_KEYS,
  OTEL_SESSION_ENDED_MS,
  OTEL_SESSIONS_LIMIT,
  OTEL_STATES,
} from './otel-facts.constants';
import type {
  OtelBucket,
  OtelCallRow,
  OtelCoverage,
  OtelInterval,
  OtelQuerySourceRow,
  OtelReasonKey,
  OtelRepoKpis,
  OtelSessionKpis,
  OtelSessionStatus,
  OtelSlowReason,
  OtelSpanRow,
  OtelStatusDto,
  OtelTeamKpis,
  OtelTeamPersonRow,
  RepoOtelFactsQuery,
  RepoOtelFactsResponse,
  SessionOtelQuery,
  SessionOtelResponse,
  TeamOtelFactsQuery,
  TeamOtelFactsResponse,
} from './otel-facts.types';
import { OTEL_SOURCE_CHUNK_BIT } from './otel-facts-writer';
import { lookupQuerySource } from './otel-query-source-dictionary';

// ---------------------------------------------------------------------------
// Pure helpers (shared with the team route)
// ---------------------------------------------------------------------------

/** `v1.<seq>` (DD-2). */
export function formatOtelCursor(seq: number): string {
  return `${OTEL_CURSOR_PREFIX}${seq}`;
}

/**
 * The seq of a `since=` cursor, or null when it is absent, of an unknown version or malformed —
 * the caller then answers with a full snapshot (DD-2).
 */
export function parseOtelCursor(raw: string | null): number | null {
  if (raw === null || !raw.startsWith(OTEL_CURSOR_PREFIX)) return null;
  const digits = raw.slice(OTEL_CURSOR_PREFIX.length);
  if (!/^\d{1,18}$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** True when `version` is below the first hook with traces and realtime (DD-15). */
export function isOldOtelHook(version: string | null): boolean {
  return (
    version === null || compareVersions(version, OTEL_LIVE_HOOK_MIN_VERSION) < 0
  );
}

function bigOf(text: string): bigint {
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function divOrNull(total: bigint, by: number): string | null {
  return by > 0 ? (total / BigInt(by)).toString() : null;
}

function ratio(part: string, whole: string): number {
  const w = Number(whole);
  return w > 0 ? Number(part) / w : 0;
}

/** The repository KPIs from the window's sums (API changes, DD-28). */
export function deriveRepoKpis(s: OtelKpiSums): OtelRepoKpis {
  const total = bigOf(s.totalCostUsdMicros);
  return {
    totalCostUsdMicros: s.totalCostUsdMicros,
    activeDays: s.activeDays,
    perDayCostUsdMicros: divOrNull(total, s.activeDays),
    perSessionCostUsdMicros: divOrNull(total, s.sessions),
    medianSessionCostUsdMicros: s.medianSessionCostUsdMicros,
    apiCalls: s.apiCalls,
    modelCount: s.modelCount,
    hiddenCostUsdMicros: s.hiddenCostUsdMicros,
    hiddenCalls: s.hiddenCalls,
    hiddenShare: ratio(s.hiddenCostUsdMicros, s.totalCostUsdMicros),
    sessions: s.sessions,
    users: s.users,
    perUserCostUsdMicros: divOrNull(total, s.users),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
  };
}

/** The session KPIs from the root's sums. */
export function deriveSessionKpis(s: OtelKpiSums): OtelSessionKpis {
  return {
    totalCostUsdMicros: s.totalCostUsdMicros,
    hiddenCostUsdMicros: s.hiddenCostUsdMicros,
    hiddenCalls: s.hiddenCalls,
    apiCalls: s.apiCalls,
    subagentCostUsdMicros: s.subagentCostUsdMicros,
    subagentShare: ratio(s.subagentCostUsdMicros, s.totalCostUsdMicros),
  };
}

/** The query_source table rows with the dictionary's description / hidden / known (DD-21). */
export function toQuerySourceRows(
  rows: OtelQuerySourceSqlRow[],
): OtelQuerySourceRow[] {
  let total = 0n;
  for (const r of rows) total += bigOf(r.costUsdMicros);
  const totalText = total.toString();
  return rows.map((r) => {
    const entry = lookupQuerySource(r.querySource);
    return {
      querySource: r.querySource,
      description: entry.description,
      known: entry.known,
      hidden: entry.hidden,
      calls: r.calls,
      sessions: r.sessions,
      costUsdMicros: r.costUsdMicros,
      share: ratio(r.costUsdMicros, totalText),
      hiddenShare: ratio(r.hiddenCostUsdMicros, r.costUsdMicros),
      contextToOutput:
        r.outputTokens > 0 ? r.contextTokens / r.outputTokens : null,
      models: r.models,
    };
  });
}

export function toOtelBuckets(rows: OtelBucketSqlRow[]): OtelBucket[] {
  return rows.map((r) => ({
    start: r.start.toISOString(),
    key: r.key,
    calls: r.calls,
    costUsdMicros: r.costUsdMicros,
    tokens: r.tokens,
    changeKind: r.changeKind,
  }));
}

// ---------------------------------------------------------------------------
// OTEL coverage and status (2026-10-30 otel-shared-receiver, DD-28 – DD-30)
// ---------------------------------------------------------------------------

type OtelReportedReason = NonNullable<OtelStatusDto['reason']>;

function isReportedReason(value: unknown): value is OtelReportedReason {
  return (OTEL_REASON_KEYS as readonly unknown[]).includes(value);
}

function isOtelState(value: unknown): value is OtelStatusDto['state'] {
  return (OTEL_STATES as readonly unknown[]).includes(value);
}

/** A stored reason as a coverage key: `no-status` stays, anything unknown becomes `unknown`. */
function toCoverageReason(value: string): OtelReasonKey {
  if (value === OTEL_NO_STATUS_REASON) return OTEL_NO_STATUS_REASON;
  return isReportedReason(value) ? value : 'unknown';
}

/**
 * The coverage DTO (DD-29) from its SQL row: stored reasons are normalised (a value outside
 * today's list counts as `unknown`, merged with any `unknown` row), most frequent first, ties
 * by reason.
 */
export function toOtelCoverage(row: OtelCoverageSqlRow): OtelCoverage {
  const counts = new Map<OtelReasonKey, number>();
  for (const r of row.reasons) {
    const key = toCoverageReason(r.reason);
    counts.set(key, (counts.get(key) ?? 0) + r.count);
  }
  return {
    otelSessions: row.otelSessions,
    totalSessions: row.totalSessions,
    otelUsers: row.otelUsers,
    reasons: [...counts]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The session's `otelStatus` (DD-28) from its stored columns, or null when no hook ever reported
 * one. Values outside today's lists are shown as `unknown`; the jsonb fields are type-checked.
 */
export function toOtelStatusDto(row: OtelStatusSqlRow): OtelStatusDto | null {
  if (row.state === null && row.status === null) return null;
  const status = recordOf(row.status);
  const received = recordOf(status['received']);
  const forward = status['forward'];
  return {
    state: isOtelState(row.state) ? row.state : 'unknown',
    reason:
      row.reason === null
        ? null
        : isReportedReason(row.reason)
          ? row.reason
          : 'unknown',
    detail: textOrNull(status['detail']),
    received: {
      logs: countOf(received['logs']),
      metrics: countOf(received['metrics']),
      spans: countOf(received['spans']),
      firstAt: textOrNull(received['firstAt']),
    },
    claudeVersion: textOrNull(status['claudeVersion']),
    hookVersion: textOrNull(status['hookVersion']),
    receiverVersion: textOrNull(status['receiverVersion']),
    forward:
      forward === 'ok' || forward === 'degraded' || forward === 'off'
        ? forward
        : null,
  };
}

/** The session status's DD-28 / DD-30 fields. */
export interface OtelStatusReport {
  otelStatus: OtelStatusDto | null;
  costExcludesUtilityCalls: boolean;
}

/** No report: an unknown session, or one outside the caller's scope. */
const NO_OTEL_STATUS_REPORT: OtelStatusReport = {
  otelStatus: null,
  costExcludesUtilityCalls: false,
};

function isRecent(at: Date | null, now: Date, ms: number): boolean {
  return at !== null && now.getTime() - at.getTime() <= ms;
}

/**
 * The session status (DD-14, DD-15) from the state row; `state` null = no OTEL data. `report`
 * carries the hook's last `otel-status` and the cost marker (2026-10-30 otel-shared-receiver).
 */
export function buildOtelSessionStatus(
  state: OtelStateRow | null,
  unconfirmed: { calls: number; spans: number },
  attributesMasked: boolean,
  now: Date,
  report: OtelStatusReport = NO_OTEL_STATUS_REPORT,
): OtelSessionStatus {
  if (state === null) {
    return {
      ...report,
      hasOtel: false,
      hasSpans: false,
      live: false,
      slowUpdates: false,
      slowReason: null,
      otelHookVersion: null,
      attributesMasked,
      realtime: {
        active: false,
        unconfirmedCalls: 0,
        unconfirmedSpans: 0,
        lastRealtimeAt: null,
        lastChunkAt: null,
        chunkDelayed: false,
        gap: false,
      },
    };
  }
  const { rtLastAt, chunkLastAt } = state;
  const slowUpdates = rtLastAt === null;
  const slowReason: OtelSlowReason | null = slowUpdates
    ? isOldOtelHook(state.otelHookVersion)
      ? 'old-hook'
      : 'realtime-off'
    : null;
  const chunkDelayed =
    rtLastAt !== null &&
    (chunkLastAt !== null
      ? rtLastAt.getTime() - chunkLastAt.getTime() > OTEL_CHUNK_DELAY_MS
      : now.getTime() - rtLastAt.getTime() > OTEL_CHUNK_DELAY_MS);
  return {
    ...report,
    hasOtel: true,
    hasSpans: state.hasSpans,
    live:
      isRecent(rtLastAt, now, OTEL_SESSION_ENDED_MS) ||
      isRecent(chunkLastAt, now, OTEL_SESSION_ENDED_MS),
    slowUpdates,
    slowReason,
    otelHookVersion: state.otelHookVersion,
    attributesMasked,
    realtime: {
      active: isRecent(rtLastAt, now, OTEL_SESSION_ENDED_MS),
      unconfirmedCalls: unconfirmed.calls,
      unconfirmedSpans: unconfirmed.spans,
      lastRealtimeAt: rtLastAt === null ? null : rtLastAt.toISOString(),
      lastChunkAt: chunkLastAt === null ? null : chunkLastAt.toISOString(),
      chunkDelayed,
      gap: state.rtGapAt !== null,
    },
  };
}

/**
 * Whether span attributes are masked for the caller (DD-22) — the `maskFirstPrompt` rule: a
 * `team-no-prompts` caller viewing a session they do not own (an unknown owner is masked).
 */
export function masksOtelAttributes(
  teamScope: TeamScope,
  requesterUserId: number,
  ownerId: number | null,
): boolean {
  return (
    teamScope.visibility === 'team-no-prompts' && ownerId !== requesterUserId
  );
}

/** The team KPIs (DD-29): the repository KPIs plus per active person and repository counts. */
export function deriveTeamKpis(
  s: OtelKpiSums,
  repos: { repositories: number; repositoriesLive: number },
): OtelTeamKpis {
  const kpis = deriveRepoKpis(s);
  return {
    ...kpis,
    perActivePersonCostUsdMicros: kpis.perUserCostUsdMicros,
    repositories: repos.repositories,
    repositoriesLive: repos.repositoriesLive,
  };
}

/**
 * Each person's cost per bucket start, in USD (the People table trend, DD-29): `rows` are the
 * person-stacked rolled buckets; every trend has one value per distinct start, oldest first.
 */
export function buildOtelPersonTrends(
  rows: OtelBucketSqlRow[],
): Map<string, number[]> {
  const starts = [...new Set(rows.map((r) => r.start.getTime()))].sort(
    (a, b) => a - b,
  );
  const index = new Map(starts.map((t, i) => [t, i]));
  const trends = new Map<string, number[]>();
  for (const r of rows) {
    let trend = trends.get(r.key);
    if (trend === undefined) {
      trend = starts.map(() => 0);
      trends.set(r.key, trend);
    }
    const i = index.get(r.start.getTime());
    if (i !== undefined) trend[i] += Number(r.costUsdMicros) / 1_000_000;
  }
  return trends;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface RepoOtelFactsInput {
  scope: OtelReadScope;
  query: RepoOtelFactsQuery;
  requesterUserId: number;
  now?: Date;
}

export interface TeamOtelFactsInput {
  teamId: number;
  teamScope: TeamScope;
  query: TeamOtelFactsQuery;
  now?: Date;
}

export interface SessionOtelInput {
  scope: OtelReadScope;
  /** `sessions.session_id` of any node of the tree (DD-1 resolves the root). */
  sessionId: string;
  query: SessionOtelQuery;
  requesterUserId: number;
  now?: Date;
}

const ZERO_KPI_SUMS: OtelKpiSums = {
  rowCount: 0,
  totalCostUsdMicros: '0',
  activeDays: 0,
  apiCalls: 0,
  modelCount: 0,
  hiddenCostUsdMicros: '0',
  hiddenCalls: 0,
  subagentCostUsdMicros: '0',
  sessions: 0,
  users: 0,
  inputTokens: '0',
  outputTokens: '0',
  cacheReadTokens: '0',
  cacheWriteTokens: '0',
  medianSessionCostUsdMicros: null,
};

@Injectable()
export class OtelFactsReader {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** The repository facts (API changes, DD-14, DD-15, DD-19, DD-28). */
  async getRepoOtelFacts(
    input: RepoOtelFactsInput,
  ): Promise<RepoOtelFactsResponse> {
    const { scope, query, requesterUserId } = input;
    const now = input.now ?? new Date();
    const interval: OtelInterval =
      query.interval === 'auto'
        ? pickOtelInterval(query.from, query.to, 'repository')
        : query.interval;
    const window: OtelWindow = { from: query.from, to: query.to };
    const span = query.to.getTime() - query.from.getTime();
    const prevWindow: OtelWindow = {
      from: new Date(query.from.getTime() - span),
      to: query.from,
    };
    const filters: OtelBucketFilters = {
      calls: query.calls,
      models: query.models,
      ccVersions: query.ccVersions,
    };
    const roots = otelScopedRootsCtes(scope, query.to);

    const [presence, hookVersions, coverage] = await Promise.all([
      loadPresence(this.db, roots, window),
      loadRepoHookVersions(this.db, scope.repoIds),
      loadOtelCoverage(this.db, roots, window),
    ]);
    const hookVersion = maxVersion(hookVersions);
    const base: RepoOtelFactsResponse = {
      interval,
      tz: query.tz,
      generatedAt: now.toISOString(),
      hasOtel: presence.hasOtel,
      hasOtelInPeriod: presence.hasOtelInPeriod,
      slowUpdates: isOldOtelHook(hookVersion),
      hookVersion,
      realtime: {
        unconfirmedCalls: 0,
        realtimeSessions: 0,
        chunkDelayedSessions: 0,
        gapSessions: 0,
      },
      buckets: [],
      kpis: deriveRepoKpis(ZERO_KPI_SUMS),
      kpisPrev: null,
      flows: [],
      querySources: [],
      filterOptions: { models: [], ccVersions: [] },
      sessions: [],
      coverage: toOtelCoverage(coverage),
    };
    if (!presence.hasOtel) return base;

    const source = repoBucketSource(roots, window, filters);
    const prevSource = repoBucketSource(roots, prevWindow, filters);
    const [
      buckets,
      kpiSums,
      prevSums,
      flows,
      querySources,
      filterOptions,
      sessions,
      realtime,
    ] = await Promise.all([
      loadRolledBuckets(
        this.db,
        source,
        interval,
        query.tz,
        stackKeySql(query.stackBy),
      ),
      loadKpiSums(this.db, source, query.tz),
      loadKpiSums(this.db, prevSource, query.tz),
      loadFlowRows(this.db, source, OTEL_FLOWS_LIMIT),
      loadQuerySourceRows(this.db, source),
      loadFilterOptions(this.db, roots, window),
      loadSessionRows(this.db, source, OTEL_SESSIONS_LIMIT),
      loadRealtimeCounts(this.db, roots, query.from, now),
    ]);

    return {
      ...base,
      realtime,
      buckets: toOtelBuckets(buckets),
      kpis: deriveRepoKpis(kpiSums),
      kpisPrev: prevSums.rowCount > 0 ? deriveRepoKpis(prevSums) : null,
      flows,
      querySources: toQuerySourceRows(querySources),
      filterOptions: {
        models: filterOptions.models,
        ccVersions: [...filterOptions.ccVersions].sort((a, b) =>
          compareVersions(b, a),
        ),
      },
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        startedAt: toIso(s.startedAt) ?? '',
        firstPrompt: maskFirstPrompt(
          scope.teamScope,
          requesterUserId,
          s.ownerId,
          s.firstPrompt,
        ),
        userEmail: s.userEmail,
        ccVersion: maxVersion(s.ccVersions),
        calls: s.calls,
        costUsdMicros: s.costUsdMicros,
        hiddenCostUsdMicros: s.hiddenCostUsdMicros,
        hasTraces: s.hasTraces,
        live: isRecent(s.lastAt, now, OTEL_SESSION_ENDED_MS),
        unconfirmedCalls: s.unconfirmedCalls,
      })),
    };
  }

  /** Is the caller a member of the team? (the team route answers 403 otherwise, DD-29). */
  isTeamMember(teamId: number, userId: number): Promise<boolean> {
    return isOtelTeamMember(this.db, teamId, userId);
  }

  /**
   * The team facts (DD-29): the repository facts' buckets, KPIs, `kpisPrev`, realtime counts and
   * `flows` over the DISTINCT scoped roots of every team repository, plus the People and
   * Repositories tables. The access gate is the controller's.
   */
  async getTeamOtelFacts(
    input: TeamOtelFactsInput,
  ): Promise<TeamOtelFactsResponse> {
    const { query, teamScope, teamId } = input;
    const now = input.now ?? new Date();
    const interval: OtelInterval =
      query.interval === 'auto'
        ? pickOtelInterval(query.from, query.to, 'repository')
        : query.interval;
    const window: OtelWindow = { from: query.from, to: query.to };
    const span = query.to.getTime() - query.from.getTime();
    const prevWindow: OtelWindow = {
      from: new Date(query.from.getTime() - span),
      to: query.from,
    };
    const filters: OtelBucketFilters = {
      calls: query.calls,
      models: query.models,
      ccVersions: query.ccVersions,
    };
    const scope: OtelTeamScope = {
      teamId,
      teamScope,
      repoIds: query.repoIds,
      userIds: query.userIds,
    };
    const roots = otelTeamRootsCtes(scope, query.to);
    const allRoots = otelTeamRootsCtes(scope, query.to, false);

    const [presence, teamRepos, coverage] = await Promise.all([
      loadPresence(this.db, allRoots, window),
      loadOtelTeamRepos(this.db, teamId),
      loadOtelCoverage(this.db, roots, window),
    ]);
    const hookVersion = maxVersion(
      await loadRepoHookVersions(this.db, teamRepos.memberRepoIds),
    );
    const noRepos = { repositories: 0, repositoriesLive: 0 };
    const base: TeamOtelFactsResponse = {
      interval,
      tz: query.tz,
      generatedAt: now.toISOString(),
      hasOtel: presence.hasOtel,
      hasOtelInPeriod: presence.hasOtelInPeriod,
      slowUpdates: isOldOtelHook(hookVersion),
      hookVersion,
      realtime: {
        unconfirmedCalls: 0,
        realtimeSessions: 0,
        chunkDelayedSessions: 0,
        gapSessions: 0,
      },
      buckets: [],
      kpis: deriveTeamKpis(ZERO_KPI_SUMS, noRepos),
      kpisPrev: null,
      flows: [],
      querySources: [],
      filterOptions: {
        models: [],
        ccVersions: [],
        people: [],
        repositories: teamRepos.repositories,
      },
      people: [],
      repositories: [],
      coverage: toOtelCoverage(coverage),
    };
    if (!presence.hasOtel) return base;

    const source = repoBucketSource(
      roots,
      window,
      filters,
      OTEL_TEAM_BUCKET_EXTRA,
    );
    const prevSource = repoBucketSource(
      roots,
      prevWindow,
      filters,
      OTEL_TEAM_BUCKET_EXTRA,
    );
    const optionsSource = repoBucketSource(allRoots, window, OTEL_NO_FILTERS);
    const personKey = teamStackKeySql('person');
    const [
      buckets,
      personBuckets,
      kpiSums,
      prevSums,
      repoCounts,
      prevRepoCounts,
      flows,
      querySources,
      filterOptions,
      peopleOptions,
      people,
      repositories,
      realtime,
    ] = await Promise.all([
      loadRolledBuckets(
        this.db,
        source,
        interval,
        query.tz,
        teamStackKeySql(query.stackBy),
      ),
      query.stackBy === 'person'
        ? null
        : loadRolledBuckets(this.db, source, interval, query.tz, personKey),
      loadKpiSums(this.db, source, query.tz),
      loadKpiSums(this.db, prevSource, query.tz),
      loadOtelTeamRepoCounts(this.db, source, now),
      loadOtelTeamRepoCounts(this.db, prevSource, now),
      loadFlowRows(this.db, source, OTEL_FLOWS_LIMIT, sql`fb.repo_url`),
      loadQuerySourceRows(this.db, source),
      loadFilterOptions(this.db, allRoots, window),
      loadOtelTeamPeopleOptions(this.db, optionsSource),
      loadOtelTeamPeople(this.db, source, now),
      loadOtelTeamRepositories(this.db, source, now),
      loadRealtimeCounts(this.db, roots, query.from, now),
    ]);
    const trends = buildOtelPersonTrends(personBuckets ?? buckets);

    return {
      ...base,
      realtime,
      buckets: toOtelBuckets(buckets),
      kpis: deriveTeamKpis(kpiSums, repoCounts),
      kpisPrev:
        prevSums.rowCount > 0 ? deriveTeamKpis(prevSums, prevRepoCounts) : null,
      flows,
      querySources: toQuerySourceRows(querySources),
      filterOptions: {
        models: filterOptions.models,
        ccVersions: [...filterOptions.ccVersions].sort((a, b) =>
          compareVersions(b, a),
        ),
        people: peopleOptions,
        repositories: teamRepos.repositories,
      },
      people: people.map(
        (p): OtelTeamPersonRow => ({
          ...p,
          trend: trends.get(String(p.userId)) ?? [],
        }),
      ),
      repositories,
    };
  }

  /**
   * The session OTEL response (DD-2 reader rule, DD-14, DD-15, DD-19, DD-22). A session that is
   * unknown or outside the caller's scope answers with an empty response (`hasOtel: false`),
   * never 404.
   */
  async getSessionOtel(input: SessionOtelInput): Promise<SessionOtelResponse> {
    const { scope, query, requesterUserId } = input;
    const now = input.now ?? new Date();

    const root = await resolveOtelRoot(this.db, input.sessionId);
    if (root === null) return this.emptySession(query, false);
    const owner = await loadScopedRootOwner(this.db, scope, root.rootSessionId);
    if (!owner.inScope) return this.emptySession(query, false);
    const attributesMasked = masksOtelAttributes(
      scope.teamScope,
      requesterUserId,
      owner.ownerId,
    );

    return this.db.transaction(
      async (tx) => {
        const state = await readOtelStateRow(tx, root.rootId);
        const statusRow = await loadOtelStatusRow(
          tx,
          root.rootId,
          costExcludesUtilityCallsSql(sql`root.id`),
        );
        const report: OtelStatusReport = {
          otelStatus: toOtelStatusDto(statusRow),
          costExcludesUtilityCalls: statusRow.costExcludesUtilityCalls,
        };
        if (state === null) {
          return this.emptySession(query, attributesMasked, report);
        }

        const parsed = parseOtelCursor(query.since);
        const since = parsed !== null && parsed <= state.seq ? parsed : null;
        const unconfirmed =
          state.rtLastAt === null
            ? { calls: 0, spans: 0 }
            : await countUnconfirmed(tx, root.rootId);
        const status = buildOtelSessionStatus(
          state,
          unconfirmed,
          attributesMasked,
          now,
          report,
        );
        const interval = await this.sessionInterval(tx, root.rootId, query);
        const cursor = formatOtelCursor(state.seq);

        // Empty-delta fast path: nothing changed since the client's cursor.
        if (since !== null && since === state.seq) {
          return {
            cursor,
            full: false,
            interval,
            status,
            buckets: [],
            calls: [],
            spans: [],
            kpis: null,
            querySources: null,
          };
        }

        const keySql = stackKeySql(query.stackBy);
        const source = sessionBucketSource(root.rootId);
        const [buckets, calls, spans, kpiSums, querySources] =
          await Promise.all([
            since === null
              ? loadRolledBuckets(tx, source, interval, query.tz, keySql)
              : loadSessionDeltaBuckets(
                  tx,
                  root.rootId,
                  since,
                  interval,
                  query.tz,
                  keySql,
                ),
            loadSessionCalls(tx, root.rootId, since),
            loadSessionSpans(tx, root.rootId, since, !attributesMasked),
            loadKpiSums(tx, source, query.tz),
            loadQuerySourceRows(tx, source),
          ]);

        return {
          cursor,
          full: since === null,
          interval,
          status,
          buckets: toOtelBuckets(buckets),
          calls: calls.map(
            (c): OtelCallRow => ({
              callKey: c.callKey,
              requestId: c.requestId,
              querySource: c.querySource,
              model: c.model,
              eventTime: c.eventTime.toISOString(),
              structure: c.structure,
              provisional: c.provisional,
              confirmed: (c.sourceMask & OTEL_SOURCE_CHUNK_BIT) !== 0,
              costUsdMicros: c.costUsdMicros,
              inputTokens: c.inputTokens,
              outputTokens: c.outputTokens,
              cacheReadTokens: c.cacheReadTokens,
              cacheWriteTokens: c.cacheWriteTokens,
              agentId: c.agentId,
              promptId: c.promptId,
              changeKind: c.changeKind,
            }),
          ),
          spans: spans.map(
            (s): OtelSpanRow => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              startTime: s.startTime.toISOString(),
              endTime: s.endTime === null ? null : s.endTime.toISOString(),
              requestId: s.requestId,
              agentId: s.agentId,
              querySource: s.querySource,
              context: s.context,
              costUsdMicros: s.costUsdMicros,
              rollupCostUsdMicros: s.rollupCostUsdMicros,
              hidden:
                s.callStructure === null ? null : s.callStructure === 'hidden',
              confirmed: (s.sourceMask & OTEL_SOURCE_CHUNK_BIT) !== 0,
              attributes: attributesMasked ? null : s.attributes,
              changeKind: s.changeKind,
            }),
          ),
          kpis: deriveSessionKpis(kpiSums),
          querySources: toQuerySourceRows(querySources),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /** The session chart interval: explicit, or `auto` over the session's bucket span (DD-18). */
  private async sessionInterval(
    db: DrizzleDb,
    rootId: number,
    query: SessionOtelQuery,
  ): Promise<'5m' | '1h'> {
    if (query.interval !== 'auto') return query.interval;
    const span = await loadSessionBucketSpan(db, rootId);
    if (span.first === null || span.last === null) return '5m';
    const picked = pickOtelInterval(span.first, span.last, 'session');
    return picked === '5m' ? '5m' : '1h';
  }

  /** No OTEL data, or a session outside the caller's scope. */
  private emptySession(
    query: SessionOtelQuery,
    attributesMasked: boolean,
    report: OtelStatusReport = NO_OTEL_STATUS_REPORT,
  ): SessionOtelResponse {
    return {
      cursor: formatOtelCursor(0),
      full: true,
      interval: query.interval === 'auto' ? '5m' : query.interval,
      status: buildOtelSessionStatus(
        null,
        { calls: 0, spans: 0 },
        attributesMasked,
        new Date(),
        report,
      ),
      buckets: [],
      calls: [],
      spans: [],
      kpis: null,
      querySources: null,
    };
  }
}
