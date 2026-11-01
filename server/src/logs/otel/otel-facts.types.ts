// Request and response types of the OTEL facts feature (2026-10-30 otel-tabs-traces):
// the hook route `POST /api/v2/otel-realtime` and the UI routes
// `GET /api/v1/repositories/:repoId/otel/facts`,
// `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel` and
// `GET /api/v1/teams/:teamId/otel/facts`.
//
// Micro-USD amounts travel as decimal strings: JSON has no BigInt and a large micro total
// would lose precision as a float.

import type {
  OTEL_NO_STATUS_REASON,
  OTEL_REASON_KEYS,
  OTEL_STATES,
} from './otel-facts.constants';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a root has no (or only partial) OTEL data (2026-10-30 otel-shared-receiver, DD-15, DD-31):
 * a reason the hook reported in its `otel-status` event, or `no-status` for a root whose hook
 * never sent one (an older hook).
 */
export type OtelReasonKey =
  | (typeof OTEL_REASON_KEYS)[number]
  | typeof OTEL_NO_STATUS_REASON;

/** `session_stats.otel_state` (DD-28): an unknown hook value is stored as `unknown`. */
export type OtelStateKey = (typeof OTEL_STATES)[number];

/**
 * OTEL coverage of a repository / team scope (DD-29): roots with OTEL data (the `hasOtel`
 * predicate, or `otel_state` `ok` / `partial`) out of every root in scope, the distinct users of
 * the covered roots, and the other roots grouped by reason, most frequent first.
 */
export interface OtelCoverage {
  otelSessions: number;
  totalSessions: number;
  otelUsers: number;
  reasons: { reason: OtelReasonKey; count: number }[];
}

/** The latest `otel-status` event of a root (DD-16, DD-28), as the session route returns it. */
export interface OtelStatusDto {
  state: OtelStateKey;
  reason: Exclude<OtelReasonKey, 'no-status'> | null;
  detail: string | null;
  received: {
    logs: number;
    metrics: number;
    spans: number;
    firstAt: string | null;
  };
  claudeVersion: string | null;
  hookVersion: string | null;
  receiverVersion: string | null;
  forward: 'ok' | 'degraded' | 'off' | null;
}

/**
 * Why a span, call or bucket row last changed (DD-3):
 * - `new` — first insert by realtime, or by a chunk while the session has no realtime data;
 * - `update` — a value changed (cost, end time, rollup);
 * - `confirm` — a chunk confirmed a realtime row (only `source_mask` changed);
 * - `fill` — first insert by a chunk while the session already has realtime data;
 * - `reclass` — changed only by reclassification.
 */
export type OtelChangeKind = 'new' | 'update' | 'confirm' | 'fill' | 'reclass';

/** Call structure (DD-4): main thread, sub-agent thread, or a hidden (utility) call. */
export type OtelStructure = 'main' | 'subagent' | 'hidden';

/** A resolved chart interval (DD-18). */
export type OtelInterval = '5m' | '1h' | '1d';

/** Which scope `pickOtelInterval` resolves `auto` for (DD-18); the team tab uses `repository`. */
export type OtelIntervalScope = 'repository' | 'session';

/** `calls=` filter: `transcript` = structure main/subagent, `hidden` = structure hidden. */
export type OtelCallsFilter = 'all' | 'hidden' | 'transcript';

export type RepoOtelStackBy =
  | 'structure'
  | 'querySource'
  | 'model'
  | 'ccVersion';
export type SessionOtelStackBy = 'structure' | 'querySource' | 'model';
export type TeamOtelStackBy =
  | 'person'
  | 'repository'
  | 'structure'
  | 'model'
  | 'querySource';

/** Why a session's OTEL data updates slowly (DD-15). */
export type OtelSlowReason = 'old-hook' | 'realtime-off';

// ---------------------------------------------------------------------------
// Hook route: POST /api/v2/otel-realtime
// ---------------------------------------------------------------------------

/**
 * One realtime batch. `lines` are the exact chunk-line objects the receiver writes to its chunk
 * files: `{ signal, receivedAt, resource, scope, record, hookVersion }` (DD-13).
 */
export interface OtelRealtimeRequest {
  sessionId: string;
  hookVersion: string;
  /** Random id the receiver makes at start; a restart starts a new one. */
  receiverId: string;
  /** Increases per session and receiver; a repeated value is a replay (DD-14). */
  batchSeq: number;
  /** Lines the receiver dropped (queue overflow, oversize line); > 0 marks a gap. */
  droppedLines: number;
  lines: Record<string, unknown>[];
}

export interface OtelRealtimeResponse {
  accepted: { calls: number; spans: number };
  cursor: string;
  /** The hook never sends more often than this (env `OTEL_REALTIME_MIN_INTERVAL_MS`). */
  minIntervalMs: number;
  /** Set when the session is soft-deleted: nothing was written. */
  ignored?: 'deleted';
}

// ---------------------------------------------------------------------------
// UI routes: query parameters (already validated / parsed)
// ---------------------------------------------------------------------------

/** `GET /api/v1/repositories/:repoId/otel/facts`. */
export interface RepoOtelFactsQuery {
  from: Date;
  to: Date;
  models: string[];
  ccVersions: string[];
  calls: OtelCallsFilter;
  interval: 'auto' | OtelInterval;
  stackBy: RepoOtelStackBy;
  /** IANA name, default `UTC`. */
  tz: string;
  /** Present in a team context (DD-6). */
  teamId: number | null;
}

/** `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel`. */
export interface SessionOtelQuery {
  interval: 'auto' | '5m' | '1h';
  stackBy: SessionOtelStackBy;
  tz: string;
  /** The previous response's `cursor` (`v1.<seq>`), or null for a snapshot. */
  since: string | null;
  teamId: number | null;
}

/** `GET /api/v1/teams/:teamId/otel/facts` (DD-29). */
export interface TeamOtelFactsQuery extends Omit<
  RepoOtelFactsQuery,
  'stackBy' | 'teamId'
> {
  repoIds: number[];
  userIds: number[];
  stackBy: TeamOtelStackBy;
}

// ---------------------------------------------------------------------------
// UI routes: response rows
// ---------------------------------------------------------------------------

/** One rolled chart bucket of one stack key. */
export interface OtelBucket {
  /** ISO start of the rolled bucket. */
  start: string;
  /** The stack-by value (`''` for a NULL dimension; user / repository id for person / repository). */
  key: string;
  calls: number;
  costUsdMicros: string;
  /** input + output + cache read + cache write. */
  tokens: string;
  /** Kind of the newest (max-`seq`) underlying row (DD-20). */
  changeKind: OtelChangeKind;
}

export interface OtelRepoKpis {
  totalCostUsdMicros: string;
  activeDays: number;
  perDayCostUsdMicros: string | null;
  perSessionCostUsdMicros: string | null;
  medianSessionCostUsdMicros: string | null;
  apiCalls: number;
  modelCount: number;
  hiddenCostUsdMicros: string;
  hiddenCalls: number;
  /** Hidden cost / total cost, 0..1; 0 when the total is 0. */
  hiddenShare: number;
  sessions: number;
  users: number;
  /** Total / users; null when `users` = 0 (DD-28). */
  perUserCostUsdMicros: string | null;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
}

/** One cost-flow row (DD-28; `repository` is filled by the team route only, DD-29). */
export interface OtelFlowRow {
  model: string | null;
  userEmail: string | null;
  branch: string | null;
  repository: string | null;
  /** The folded remainder beyond `OTEL_FLOWS_LIMIT`; its model / user / branch are null. */
  other: boolean;
  costUsdMicros: string;
  calls: number;
  sessions: number;
}

export interface OtelQuerySourceRow {
  querySource: string;
  description: string | null;
  /** False for a name the dictionary does not know — the UI shows a "new" chip (DD-21). */
  known: boolean;
  hidden: boolean;
  calls: number;
  sessions: number;
  costUsdMicros: string;
  share: number;
  hiddenShare: number;
  contextToOutput: number | null;
  models: string[];
}

export interface OtelSessionRow {
  sessionId: string;
  startedAt: string;
  /** Masked for a `team-no-prompts` caller viewing another member (DD-22). */
  firstPrompt: string | null;
  userEmail: string | null;
  ccVersion: string | null;
  calls: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  hasTraces: boolean;
  live: boolean;
  unconfirmedCalls: number;
}

/** Realtime status counts of the scoped roots (DD-14). */
export interface OtelRealtimeCounts {
  unconfirmedCalls: number;
  realtimeSessions: number;
  chunkDelayedSessions: number;
  gapSessions: number;
}

export interface RepoOtelFactsResponse {
  interval: OtelInterval;
  tz: string;
  generatedAt: string;
  /** false → empty state A; true with `hasOtelInPeriod` false → empty state C. */
  hasOtel: boolean;
  hasOtelInPeriod: boolean;
  slowUpdates: boolean;
  hookVersion: string | null;
  realtime: OtelRealtimeCounts;
  buckets: OtelBucket[];
  kpis: OtelRepoKpis;
  /** The same KPIs over `[from − (to − from), from)`; null when that window has no buckets. */
  kpisPrev: OtelRepoKpis | null;
  flows: OtelFlowRow[];
  querySources: OtelQuerySourceRow[];
  filterOptions: { models: string[]; ccVersions: string[] };
  /** ≤ `OTEL_SESSIONS_LIMIT`, newest first. */
  sessions: OtelSessionRow[];
  /** OTEL coverage of the roots active in the period (DD-29). */
  coverage: OtelCoverage;
}

/** One `otel_calls` row as the session route returns it. */
export interface OtelCallRow {
  callKey: string;
  requestId: string | null;
  querySource: string | null;
  model: string | null;
  eventTime: string;
  structure: OtelStructure;
  provisional: boolean;
  /** `source_mask` has the chunk bit (a row without it is "unconfirmed"). */
  confirmed: boolean;
  costUsdMicros: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  agentId: string | null;
  promptId: string | null;
  changeKind: OtelChangeKind;
}

/** One `otel_spans` row as the session route returns it. */
export interface OtelSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: string;
  endTime: string | null;
  requestId: string | null;
  agentId: string | null;
  querySource: string | null;
  context: string | null;
  costUsdMicros: string | null;
  rollupCostUsdMicros: string | null;
  /** The matching call's structure is `hidden`; null when the span has no call. */
  hidden: boolean | null;
  confirmed: boolean;
  /** Null when masked for the caller (`status.attributesMasked`, DD-22). */
  attributes: Record<string, unknown> | null;
  changeKind: OtelChangeKind;
}

export interface OtelSessionRealtimeStatus {
  active: boolean;
  unconfirmedCalls: number;
  unconfirmedSpans: number;
  lastRealtimeAt: string | null;
  lastChunkAt: string | null;
  chunkDelayed: boolean;
  gap: boolean;
}

export interface OtelSessionStatus {
  hasOtel: boolean;
  hasSpans: boolean;
  live: boolean;
  slowUpdates: boolean;
  slowReason: OtelSlowReason | null;
  otelHookVersion: string | null;
  attributesMasked: boolean;
  realtime: OtelSessionRealtimeStatus;
  /** The root's latest `otel-status` event (DD-28); null when no hook ever reported one. */
  otelStatus: OtelStatusDto | null;
  /** The root has no OTEL API-call rows and its state is not `ok` (DD-30). */
  costExcludesUtilityCalls: boolean;
}

export interface OtelSessionKpis {
  totalCostUsdMicros: string;
  hiddenCostUsdMicros: string;
  hiddenCalls: number;
  apiCalls: number;
  subagentCostUsdMicros: string;
  /** Sub-agent cost / total cost, 0..1; 0 when the total is 0. */
  subagentShare: number;
}

export interface SessionOtelResponse {
  /** `v1.<seq>` — pass back as `since=` for a delta (DD-2). */
  cursor: string;
  /** True for a snapshot; false for a `since=` delta. */
  full: boolean;
  interval: '5m' | '1h';
  status: OtelSessionStatus;
  buckets: OtelBucket[];
  calls: OtelCallRow[];
  spans: OtelSpanRow[];
  /** Null in an empty delta. */
  kpis: OtelSessionKpis | null;
  querySources: OtelQuerySourceRow[] | null;
}

// ---------------------------------------------------------------------------
// Team route (DD-29)
// ---------------------------------------------------------------------------

export interface OtelTeamKpis extends OtelRepoKpis {
  perActivePersonCostUsdMicros: string | null;
  repositories: number;
  repositoriesLive: number;
}

export interface OtelTeamPersonRow {
  userId: number;
  email: string;
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  inputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  models: string[];
  /** How many of the team's repositories the person has sessions in. */
  repositories: number;
  live: boolean;
  /** Cost per bucket start, in the response's interval, as USD. */
  trend: number[];
}

export interface OtelTeamRepositoryRow {
  repoId: number;
  repoUrl: string;
  people: number;
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  liveSessions: number;
}

export interface TeamOtelFactsResponse extends Omit<
  RepoOtelFactsResponse,
  'sessions' | 'filterOptions' | 'kpis' | 'kpisPrev'
> {
  kpis: OtelTeamKpis;
  kpisPrev: OtelTeamKpis | null;
  /** Built from the caller's visible scope without the person / repository filters. */
  filterOptions: {
    models: string[];
    ccVersions: string[];
    people: { userId: number; email: string }[];
    repositories: { repoId: number; repoUrl: string }[];
  };
  people: OtelTeamPersonRow[];
  repositories: OtelTeamRepositoryRow[];
}
