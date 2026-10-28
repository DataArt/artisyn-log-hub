export interface RepositoryContext {
  key: string;
  value: string;
}

export interface FileCategory {
  name: string;
  patterns: string[];
}

export interface RepoConfig {
  fileCategories: FileCategory[];
  /**
   * Per-turn cache-creation token count at or above which a turn is attributed
   * to a cause (compaction / file re-read). Optional: absent means
   * `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD` (`viewer/lib/cache-ratio-ui.ts`). Team- and
   * user-scoped configs may each carry their own value; resolution is
   * user row -> team row -> default, mirrored in `effectiveConfig`.
   */
  highCacheCreationThreshold?: number;
  /**
   * Turn-End Cost Advisor: an LLM-based per-turn nudge that fires once a
   * session's cumulative cost (root + descendants) crosses `minSessionCostUsd`. Absent
   * `minSessionCostUsd` (while `enabled: true`) means "use the server's built-in default"
   * (`0.1`, mirrored in `turn-end-cost-advisor.service.ts`) — the same dual-scope
   * (user -> team -> default) resolution as `highCacheCreationThreshold` above.
   */
  turnEndCostAdvisor?: { enabled: boolean; minSessionCostUsd?: number };
  /**
   * AI Session Attribution: team-only, never present on a
   * user-scoped `RepoConfig`. `attributes` uses the same `SessionAttributionAttributeDef` shape
   * declared below (identical to the API's `AttributeDef`). Absent means "no team override
   * saved yet" — the settings tab and the resolved gate both fall back to
   * `DEFAULT_ATTRIBUTES`/`DEFAULT_SESSION_ATTRIBUTION_ATTRIBUTES` with `enabled: true` in that
   * case (never persisted until the team explicitly saves).
   */
  sessionAttribution?: {
    enabled: boolean;
    attributes: SessionAttributionAttributeDef[];
  };
}

export interface RepositoryDetail {
  id: number;
  repoUrl: string;
  repoConfig: RepoConfig;
}

/**
 * One AI Session Attribution attribute definition, as resolved server-side
 * (team-only) and returned by both the combined `post-turn-analysis`
 * config GET (hook-facing) and the browser-facing endpoints below. `prompt` is carried
 * through even though the client never displays it directly — it is the one field the
 * settings-tab editor round-trips back on save.
 */
export interface SessionAttributionAttributeDef {
  key: string;
  label: string;
  type: 'string' | 'string[]' | 'boolean' | 'number';
  prompt: string;
}

/** Keyed by attribute `key`; `null` means "not determined" for that attribute. */
export type SessionAttributionValues = Record<
  string,
  string | string[] | boolean | number | null
>;

/** The outcome of one evaluation attempt — mirrors `session_attribution_runs.outcome`. */
export type SessionAttributionRunOutcome =
  | 'applied'
  | 'ignored_stale'
  | 'failed';

export interface SessionAttributionLastRun {
  outcome: SessionAttributionRunOutcome;
  finishedAt: string;
  failureReason: string | null;
}

/**
 * One concrete value bucket for an attribute, as returned by
 * `GET :repoId/session-attribution/values` (keyed by attribute `key` in the response record).
 * Feeds `AttributeFilterPopover.tsx`'s clickable value list; `null` ("not determined") is never
 * a bucket here — the popover offers it as its own `isnull` toggle instead.
 */
export interface SessionAttributionValueBucket {
  value: string | boolean | number;
  sessionCount: number;
}

/**
 * Per-session cost parts, mirroring the server's `CostBreakdown`
 * (`server/src/logs/otel-cost.sql.ts`). All amounts are USD.
 * - `mainCost` is the root session's own token×price cost; `null` when its main model is unpriced.
 * - `subagentCost` is the summed cost of every descendant sub-agent session (0 when none).
 * - `utilityCost` is the cost of telemetry API calls absent from every transcript in the tree
 *   (prompt suggestions, titles, …); 0 without telemetry.
 * - `calculatedCost` = main + sub-agents + utility; `null` as soon as the main thread, a
 *   sub-agent or a utility call is unpriced (it is the session's shown cost, `totalCost`).
 * - `telemetryCost` is the OTEL-reported cost; `null` without telemetry. A cross-check only.
 * - `mismatch` is true when both totals are present and differ by at least $0.05 and 1%.
 * - `utilityPricingMissing` / `subagentPricingMissing` are true when some utility call's /
 *   sub-agent's model has no price row.
 * - `unpricedModels` lists the model ids with no price in Log Hub (sorted). The last two
 *   fields are absent from older servers.
 */
export interface CostBreakdown {
  mainCost: number | null;
  subagentCost: number;
  utilityCost: number;
  calculatedCost: number | null;
  telemetryCost: number | null;
  mismatch: boolean;
  utilityPricingMissing: boolean;
  subagentPricingMissing?: boolean;
  unpricedModels?: string[];
}

export interface RepositorySession {
  sessionId: string;
  /**
   * `null` only ever means "masked": in a restricted team a `manager` sees
   * every member's sessions but never their prompt text.
   * Every listed session passed the server's `first_prompt IS NOT NULL`
   * root-session discriminator, so in a personal view this is never null.
   */
  firstPrompt: string | null;
  startTime: string;
  endTime: string;
  gitBranch?: string;
  userEmail?: string;
  totalCost?: number | null;
  /** Token×price cost of the whole tree (main thread + sub-agents + utility calls), or null
   * when any part is unpriced. Equals `costBreakdown.calculatedCost` and `totalCost`. */
  computedCost?: number | null;
  /**
   * The parts of this session's calculated cost, next to its telemetry cost (D2.2). Always
   * sent by the server for a listed session — see {@link CostBreakdown}.
   */
  costBreakdown: CostBreakdown;
  /** True when this session has both an OTEL cost and a computed cost and they differ
   * by 33%+ relative — see `otelComputedDiscrepancy` (server/src/logs/otel-cost.sql.ts). */
  hasCostDiscrepancy?: boolean;
  /**
   * `'unknown-model'` when some model of the session tree (main thread, sub-agent or
   * utility call) has no `model_pricing` row — which is *why* `totalCost` is null — and
   * `null` whenever the cost is trustworthy, including a session with no stats extracted
   * yet. Drives the `$???` marker, so a missing rate is never rendered as `$0.00` or a dash.
   */
  costUnavailableReason?: 'unknown-model' | null;
  isFavorite?: boolean;
  userId?: number;
  isHookService?: boolean;
  hasWorkflow?: boolean;
  /** True when this session's latest submitted Turn-End Cost Advisor run
   * has a non-empty `harnessAdvice` array. Drives the session-list "advice available" bulb. */
  hasAdvisorAdvice?: boolean;
  /**
   * `null` when the session has no attribution row at all; the server has
   * already stripped any orphaned entry before this ever reaches the
   * client, so every key present here is safe to render against the repo's current
   * definitions. A session with no attribution row renders no chips at all (Visual/UX
   * notes) — never an empty-chip placeholder.
   */
  attribution?: {
    values: SessionAttributionValues;
    promptWatermark: number;
    updatedAt: string;
  } | null;
  /**
   * The most recent evaluation attempt's outcome for this session,
   * independent of whether it actually changed `attribution` (a `failed` or `ignored_stale`
   * run leaves `attribution` exactly as it was).
   */
  lastRun?: SessionAttributionLastRun | null;
  /**
   * Highest Claude Code version recorded for the session — the transcript value, falling
   * back to the OTEL `service.version`. `null` when unknown. Optional so object literals
   * built client-side (exports, test fixtures) need not set it.
   */
  claudeVersion?: string | null;
}

export interface RepositorySummary {
  sessionCount: number;
  userCount: number;
}

export interface TimelineSession {
  sessionId: string;
  startTime: string;
  endTime: string;
  firstPrompt: string | null;
  gitBranch: string | null;
  userEmail: string | null;
  group: string | null;
  workTimeMs: number;
  totalCost: number | null;
  fileStatsByCategory: Record<string, { files: number; bytes: number }>;
  /**
   * **Tree-scoped**: `Edit`/`Write`/`MultiEdit` calls of this session **and every
   * recursive descendant sub-agent session**. This is a count of calls, not of distinct files.
   */
  filesEditedWritten: number;
  /**
   * **Tree-scoped**: lines written by `Edit`/`Write`/`MultiEdit` in this session **and
   * every recursive descendant sub-agent session**.
   */
  linesChanged: number;
  /**
   * Root-only counterpart of {@link TimelineSession.filesEditedWritten} — the root
   * transcript's own `Edit`/`Write`/`MultiEdit` calls, excluding every descendant sub-agent.
   * Optional so a client build served against an older server degrades to "unknown"
   * rather than to a wrong `0`.
   */
  filesEditedWrittenOwn?: number;
  /**
   * Root-only counterpart of {@link TimelineSession.linesChanged} — lines written by the root
   * transcript itself, excluding every descendant sub-agent. `0` for a purely
   * delegating session. Optional for the same forward-compatibility reason as
   * {@link TimelineSession.filesEditedWrittenOwn}.
   */
  linesChangedOwn?: number;
  imageCount: number;
  imageTotalBytes: number;
  mcpCallsTotal: number;
  mcpCallsByServer: Record<string, number>;
  logLineCount: number;
  /** Cache-read tokens of the root session only. Always present, `0` when unknown. */
  cacheReadTokens: number;
  /** Cache-creation tokens of the root session only. Always present, `0` when unknown. */
  cacheWriteTokens: number;
  /** Cache-read tokens summed over all recursive descendant sessions (depth > 0). */
  descendantCacheReadTokens: number;
  /** Cache-creation tokens summed over all recursive descendant sessions (depth > 0). */
  descendantCacheWriteTokens: number;
  /**
   * Billed web-search requests of the root session. Priced **per request**, so it
   * is never divided by a million and never summed into a token total.
   */
  webSearchRequests: number;
  /** Fast-mode **subset** of the root session's input tokens, not extra tokens. */
  inputTokensFast: number;
  /** Fast-mode **subset** of the root session's output tokens, not extra tokens. */
  outputTokensFast: number;
  /**
   * `'unknown-model'` when some model of the session tree has no `model_pricing` row,
   * explaining a null `totalCost`; `null` when the cost is trustworthy.
   */
  costUnavailableReason?: 'unknown-model' | null;
  /** The model ids with no price in Log Hub (sorted); absent from older servers. */
  unpricedModels?: string[];
  isFavorite?: boolean;
}

export interface WorkTimeBucket {
  day: string;
  group: string | null;
  workTimeMinutes: number;
}

export interface BranchSummary {
  branch: string | null;
  sessionCount: number;
  latestEndTime: string;
  /**
   * Wall-clock work time of the branch's root sessions. Already the correct tree value and
   * deliberately left root-only: sub-agents run inside their
   * root's span, so summing descendants here would double-count time.
   */
  totalWorkTimeMs: number;
  /**
   * **Tree-scoped**: lines written by `Edit`/`Write`/`MultiEdit` across the branch's
   * sessions **and every recursive descendant sub-agent session** of each.
   */
  totalLinesChanged: number;
  /**
   * Root-only counterpart of {@link BranchSummary.totalLinesChanged} — the branch's root
   * transcripts only, excluding every descendant sub-agent. Optional so a client build
   * served against an older server degrades to "unknown" rather than to a wrong `0`.
   */
  totalLinesChangedOwn?: number;
  totalCost: number | null;
}

export interface ExecutiveSummaryWeekBucket {
  weekStart: string;
  sessionCount: number;
  totalCost: number;
}

export interface ExecutiveSummaryModelMixEntry {
  model: string;
  sessionCount: number;
  share: number;
  cost: number;
  costShare: number;
}

export interface ExecutiveSummaryTopSession {
  startTime: string;
  userEmail: string;
  branch: string | null;
  workTimeMs: number;
  cost: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * `'unknown-model'` when this row's model has no `model_pricing` row, so the
   * report and its PDF can badge the row instead of showing a `cost` that silently omits
   * this session's spend; `null` when the figure is trustworthy.
   *
   * Independent of the report-level `excludedSessionCount` / `excludedModels`, which stay
   * the aggregate disclosure over the same signal.
   */
  costUnavailableReason?: 'unknown-model' | null;
  /** The model ids of this session's tree with no price in Log Hub; absent from older servers. */
  unpricedModels?: string[];
}

export interface ExecutiveSummaryEngineerEntry {
  userEmail: string;
  sessionCount: number;
  share: number;
  totalCost: number;
  avgCostPerSession: number;
  avgSessionLengthMs: number;
  costPerLine: number;
  linesPerHour: number;
  subAgentsPerSession: number;
}

// Previous-period window is [startDate - windowLengthMs,
// startDate - 1ms], i.e. the immediately preceding window of equal length.
// `null` on the report exactly when that window has 0 sessions (suppresses
// every KPI tile delta pill at once).
export interface ExecutiveSummaryPreviousPeriod {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  avgCostPerSession: number;
}

// Sits alongside (not inside) totalCost — its own KPI
// tile, scoped by joining `turn_end_advisor_runs.session_id` directly to sessions/logs for
// the same branch/user/date filters the rest of the report uses, no marker scan.
export interface ExecutiveSummaryAdvisorSpend {
  evaluationCount: number;
  distinctInvokingSessions: number;
  costUsd: number;
}

// Sibling KPI tile to `advisorSpend`, never merged
// into one figure — scoped via the `hook_service` marker's `invoking_session_id`.
export interface ExecutiveSummaryAttributionSpend {
  evaluationCount: number;
  distinctInvokingSessions: number;
  costUsd: number;
}

export interface ExecutiveSummaryReportData {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  teamSize: number | null;
  avgCostPerSession: number;
  totalLinesChanged: number;
  avgCostPerLine: number;
  avgLinesPerHour: number;
  avgSessionLengthMs: number;
  excludedSessionCount: number;
  excludedModels: string[];
  previousPeriod: ExecutiveSummaryPreviousPeriod | null;
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
  modelMix: ExecutiveSummaryModelMixEntry[];
  topSessions: ExecutiveSummaryTopSession[];
  engineerBreakdown: ExecutiveSummaryEngineerEntry[];
  advisorSpend: ExecutiveSummaryAdvisorSpend;
  attributionSpend: ExecutiveSummaryAttributionSpend;
}

// ---------------------------------------------------------------------------
// Cache Read Ratio report — GET :repoId/reports/cache-read-ratio.
// Mirrors `server/src/logs/reports/cache-read-ratio.service.ts`; every
// aggregate is reported for both scopes (root only / root + all recursive
// descendants).
// ---------------------------------------------------------------------------

export interface CacheRatioTokens {
  sessionCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Ratio-of-sums; `null` when read + write === 0. */
  ratio: number | null;
}

export interface CacheRatioScopeTotals extends CacheRatioTokens {
  /** `null` when no session in scope had a `model_pricing` match. */
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  undefinedRatioSessionCount: number;
}

export interface CacheRatioCauseEntry {
  turns: number;
  creationTokens: number;
  share: number;
}

export interface CacheRatioBucket {
  /** UTC `YYYY-MM-DD` day key. */
  bucket: string;
  root: CacheRatioTokens;
  withDescendants: CacheRatioTokens;
}

export interface CacheRatioGroup {
  group: string;
  root: CacheRatioScopeTotals;
  withDescendants: CacheRatioScopeTotals;
}

/** Where the effective per-turn threshold came from. */
export type CacheThresholdSource = 'user' | 'team' | 'default';

export interface CacheRatioCauses {
  /** Always root-only — deliberately unlike the dual-scope ratio above. */
  scope: 'root';
  thresholdTokens: number;
  thresholdSource: CacheThresholdSource;
  /** Sessions whose stored cause row was computed with a different threshold. */
  staleSessionCount: number;
  /** Sessions with no `session_cause_stats` row for the resolved config scope. */
  sessionsWithoutCauseData: number;
  totalCreationTokens: number;
  compaction: CacheRatioCauseEntry;
  fileReread: CacheRatioCauseEntry;
  unattributed: CacheRatioCauseEntry;
}

export interface CacheReadRatioReportData {
  root: CacheRatioScopeTotals;
  withDescendants: CacheRatioScopeTotals;
  buckets: CacheRatioBucket[];
  /** Present only when `groupBy !== 'none'`. */
  groups?: CacheRatioGroup[];
  causes: CacheRatioCauses;
}

// ---------------------------------------------------------------------------
// Attribution Breakdown report —
// GET :repoId/reports/attribution-breakdown. Mirrors
// `server/src/logs/reports/attribution-breakdown.service.ts`.
// ---------------------------------------------------------------------------

export interface AttributionBreakdownRow {
  /** The stringified attribute value, or one of the fixed labels `'Other'` /
   * `'Not determined'` / `'Unattributed'`. */
  value: string;
  sessionCount: number;
  /** Against the report's total in-scope session count, never this attribute's own total —
   * a `string[]` section's rows can legitimately sum above 1 when `fanOut` is `true`. */
  share: number;
  costUsd: number;
}

export interface AttributionBreakdownSection {
  key: string;
  label: string;
  type: SessionAttributionAttributeDef['type'];
  /** `true` only for `string[]` — one session can land in several rows. */
  fanOut: boolean;
  rows: AttributionBreakdownRow[];
}

export interface AttributionBreakdownReportData {
  totalSessionCount: number;
  totalCostUsd: number;
  /** Sessions in scope carrying at least one orphaned attribute value —
   * a report-level disclosure count, independent of the per-section "Not determined" rows. */
  orphanedSessionCount: number;
  sections: AttributionBreakdownSection[];
}

// ---------------------------------------------------------------------------
// Attribution Usage report —
// GET :repoId/reports/attribution-usage. Mirrors
// `server/src/logs/reports/attribution-usage.service.ts`. `supportsAttributeFilter: false`
// — population is evaluation runs, not sessions.
// ---------------------------------------------------------------------------

export interface AttributionUsageOutcomeRow {
  outcome: SessionAttributionRunOutcome;
  count: number;
  costUsd: number;
}

export interface AttributionUsageDayPoint {
  /** UTC `YYYY-MM-DD`. */
  date: string;
  count: number;
}

export interface AttributionUsageTopSession {
  /** `sessions.session_id` — the invoking session's own transcript id. */
  sessionId: string;
  evaluationCount: number;
  costUsd: number;
}

export interface AttributionUsageReportData {
  /** Every run row in scope, i.e. every evaluation ATTEMPT — including `failed` ones.
   * `evaluationCount >= distinctSessionCount` is expected and normal: a session is
   * re-evaluated at each new prompt watermark. */
  evaluationCount: number;
  /** Distinct invoking sessions among those runs — always `<= evaluationCount`. */
  distinctSessionCount: number;
  totalCostUsd: number;
  /** `totalCostUsd / evaluationCount`, `0` when there are no runs in scope. */
  avgCostUsd: number;
  /** Always all 3 fixed outcomes, `count: 0` for one with no runs in scope. */
  outcomeBreakdown: AttributionUsageOutcomeRow[];
  /** Ascending by date; only days with at least one run appear (no gap-filling). */
  byDay: AttributionUsageDayPoint[];
  /** Top 10 sessions by evaluation count, ties broken by cost desc. */
  topReevaluatedSessions: AttributionUsageTopSession[];
}

// --- Usage analytics ----------------------------------------------------------------
//
// Mirrors `server/src/logs/analytics/usage-analytics.types.ts`. The four `analytics/*` routes
// and the four `reports/*` routes return these same shapes from the same services, so a
// report and its analytics view can never disagree.

/** Which source produced a tool call's duration. Displayed, never inferred. */
export type DurationSource = 'toolUseResult' | 'taskTotal' | 'timestampDelta';

export interface ToolAnalyticsRow {
  tool: string;
  /** `'postgres'` for an `mcp__` tool, else `null`. */
  mcpServer: string | null;
  calls: number;
  successes: number;
  failures: number;
  /** No `tool_result`, or rejected / permission-denied / interrupted. */
  unresolved: number;
  /** `failures / (successes + failures)`; `null` when nothing resolved. */
  failureRate: number | null;
  durationCoveredCalls: number;
  durationP50Ms: number | null;
  durationMaxMs: number | null;
  durationMeanMs: number | null;
  /** `true` at repository scope (histogram-interpolated), `false` at session scope. */
  durationApproximate: boolean;
  durationBySource: Record<DurationSource, number>;
  /** Calls that ran in a wall-clock-overlapping batch. No summed tool time exists. */
  parallelBatchCalls: number;
}

export interface McpServerRow {
  server: string;
  calls: number;
  failures: number;
  unresolved: number;
}

export interface ToolAnalyticsResponse {
  tools: ToolAnalyticsRow[];
  /** Descendant depth 0 — the root session's own calls. */
  mainAgent: ToolAnalyticsRow[];
  /** Descendant depth > 0 — sub-agent calls. */
  subAgent: ToolAnalyticsRow[];
  mcpServers: McpServerRow[];
  totalCalls: number;
  parallelBatchCalls: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Reported separately from `cacheWrite1h` and never summed with it. */
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface TokenAnalyticsResponse {
  totals: TokenTotals;
  /** Includes the `'unknown'` bucket for messages with no `service_tier`. */
  byServiceTier: ({ tier: string } & TokenTotals)[];
  buckets: ({ bucket: string } & TokenTotals)[];
}

export interface ProductivityTotals {
  /** Diff-based — NOT `lines_changed`, which counts lines written. */
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pullRequests: number;
  /** "over N of M Edit/Write calls" for the two line figures above. */
  diffCoveredCalls: number;
  diffTotalCalls: number;
}

export interface ProductivityBucket {
  bucket: string;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pullRequests: number;
}

export interface ProductivityAnalyticsResponse {
  totals: ProductivityTotals;
  buckets: ProductivityBucket[];
}

export interface ActiveSessionRow {
  sessionId: string;
  firstPrompt: string | null;
  userEmail: string;
  gitBranch: string | null;
  lastActivity: string;
  workTimeMs: number;
  turns: number;
  totalTokens: number;
  /**
   * The tree's complete computed cost (root + sub-agents + utility calls), the sessions list's
   * figure; `null` when it cannot be computed — see `costUnavailableReason`.
   */
  totalCost: number | null;
  /** Model ids of the tree with no price in Log Hub. Absent from older servers. */
  unpricedModels?: string[];
  /** `'unknown-model'` when `totalCost` is null because a model has no price. */
  costUnavailableReason?: 'unknown-model' | null;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  topTool: string | null;
}

export interface ActiveSessionsResponse {
  /** Last activity descending. */
  sessions: ActiveSessionRow[];
  limit: number;
  truncated: boolean;
}

// --- Change surface ------------------------------------------------------------------
//
// Mirrors `server/src/logs/change-surface/change-surface.types.ts` exactly — the four routes
// return these shapes verbatim. `computed: false` is the "never recomputed / repo root
// unknown" state and every surface must render it as *no data*, never as `0`;
// likewise a `null` metric is `n/a`, never a `0` bar.

/**
 * Fixed, cross-repository file taxonomy — deliberately not the per-repo
 * `RepoConfig.fileCategories`, so this axis is comparable between repositories.
 */
export type FileKind = 'source' | 'test' | 'config' | 'docs' | 'other';

/** Concentration bands: `focused >= 60`, `mixed 40-59`, `scattered < 40`. */
export type ChangeBand = 'focused' | 'mixed' | 'scattered';

/** How a path came to be touched; `deleted` is not emitted yet (forward compatibility). */
export type ChangeKind = 'added' | 'modified' | 'deleted';

/** The granularities `analytics/change-surface` may be bucketed at. */
export type ChangeSurfaceTimelineBucket = 'hour' | 'day' | 'week';

/** One row of the display-only raw-extension axis. */
export interface ChangeSurfaceExtensionRow {
  /** Lowercased, no dot; `''` for a file with no extension. */
  extension: string;
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

/** One row of the fixed file-kind axis. */
export interface ChangeSurfaceFileKindRow {
  kind: FileKind;
  files: number;
  /** `files / changedFiles`, in `[0, 1]`. */
  share: number;
  linesAdded: number;
  linesRemoved: number;
}

/** One row of the touched-folder distribution. */
export interface ChangeSurfaceFolderRow {
  /** Display folder path; `'.'` for the repo root. */
  folder: string;
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Everything one scope's change surface renders from — a session tree, a report period, a
 * chart bucket or a group inside one. Never a sum across scopes: the server recomputes the
 * union for every level, because two sessions that touched the same file hold one file
 * between them, not two.
 */
export interface ChangeSurfaceAggregate {
  /** `false` -> render "no data" everywhere; never substitute `0`. */
  computed: boolean;
  /** `false` when no repo root was ever learned, so nothing could be normalised. */
  repoRootKnown: boolean;
  /** Distinct in-repo changed paths. */
  changedFiles: number;
  foldersTouched: number;
  /** Display names of the distinct top-level modules, sorted. */
  topLevelModules: string[];
  /** 0-100; `null` when `changedFiles === 0`. */
  concentration: number | null;
  band: ChangeBand | null;
  filesPerFolder: number | null;
  /** `max(n_i) / F`, in `[0, 1]`. */
  largestFolderShare: number | null;
  /** Raw normalised entropy `H / ln(K)`, in `[0, 1]`; `0` when one folder was touched. */
  folderEntropyNorm: number | null;
  /** Mean *raw* hop distance between touched folders. */
  meanPathDistanceHops: number | null;
  singleFileFolders: number;
  commonAncestorDepth: number | null;
  /** In-repo only; the out-of-repo rows are reported separately below. */
  linesAdded: number;
  linesRemoved: number;
  /** In-repo files with at least one diff-covered edit call. */
  diffCoveredFiles: number;
  outsideRepoFiles: number;
  outsideRepoLinesAdded: number;
  outsideRepoLinesRemoved: number;
  byExtension: ChangeSurfaceExtensionRow[];
  byFileKind: ChangeSurfaceFileKindRow[];
  byChangeKind: { added: number; modified: number; deleted: number };
  folderDistribution: ChangeSurfaceFolderRow[];
}

/**
 * One path in the tab's file listing. `relPath === null` means the row could not be
 * normalised (outside the repo, or recorded before any repo root was known) — the tree groups
 * those under an explicit "Outside repo / unnormalised" node rather than dropping them.
 */
export interface ChangeSurfaceFileRow {
  rawPath: string;
  relPath: string | null;
  /** `'.'` for a file sitting directly at the repo root. */
  folder: string | null;
  fileKind: FileKind | null;
  extension: string | null;
  changeKind: ChangeKind;
  editCalls: number;
  diffCoveredCalls: number;
  linesAdded: number;
  linesRemoved: number;
  outsideRepo: boolean;
}

/**
 * `GET :repoId/sessions/:sessionId/change-surface/files`. `truncated` means the tree is
 * showing the first `files.length` of `total` paths and must say so.
 */
export interface ChangeSurfaceFilesResponse {
  files: ChangeSurfaceFileRow[];
  total: number;
  truncated: boolean;
}

/** One point of the analytics timeline / the report's weekly series. */
export interface ChangeSurfaceBucket {
  /** ISO timestamp of the bucket's boundary. */
  bucketStart: string;
  sessions: number;
  /** Drives the bar -> `SessionModal` click-through. */
  sessionIds: string[];
  concentration: number | null;
  changedFiles: number;
  foldersTouched: number;
  topLevelModules: number;
  linesAdded: number;
  linesRemoved: number;
}

/** `GET :repoId/analytics/change-surface`. */
export interface ChangeSurfaceTimeline {
  bucket: ChangeSurfaceTimelineBucket;
  buckets: ChangeSurfaceBucket[];
  groups:
    | { key: string; label: string; buckets: ChangeSurfaceBucket[] }[]
    | null;
}

/** Exact (lower) medians over the sessions that actually changed something. */
export interface ChangeSurfaceMedians {
  changedFiles: number;
  foldersTouched: number;
  concentration: number | null;
  filesPerFolder: number;
  topLevelModules: number;
  folderEntropyNorm: number;
  singleFileFolderShare: number;
}

/** The `repo_code_inventory` snapshot the report's `%` indicators divide by. */
export interface ChangeSurfaceInventory {
  capturedAt: string;
  branch: string | null;
  trackedFiles: number;
  trackedLines: number;
  trackedBinaryFiles: number;
}

/** `GET :repoId/reports/change-surface`. */
export interface ChangeSurfaceReportData {
  repo: ChangeSurfaceAggregate;
  sessionsWithChanges: number;
  noChangeSessions: number;
  perSessionMedian: ChangeSurfaceMedians | null;
  inventory: ChangeSurfaceInventory | null;
  /** `null` -> render "n/a - denominator unavailable", never `0%`. */
  shareOfTrackedFiles: number | null;
  shareOfTrackedLines: number | null;
  groups:
    | {
        key: string;
        label: string;
        sessions: number;
        aggregate: ChangeSurfaceAggregate;
        shareOfTrackedFiles: number | null;
      }[]
    | null;
  buckets: {
    bucketStart: string;
    sessions: number;
    concentration: number | null;
  }[];
  /** `true` -> the period hit the row cap; say "narrow the date range", never present a
   * partial union as a whole one. */
  truncated: boolean;
}

// --- OKF usage -----------------------------------------------------------------------
//
// Mirrors `server/src/logs/okf/okf-usage.types.ts` (the session and repo OKF tab routes). The
// API-key facts route (`/api/v2/okf-usage/facts`) is not called by the client, so its shape is
// not mirrored here. Units: shares are fractions 0-1, bytes are UTF-8 bytes, `agents[].id` is
// the `sessions.session_id` string.

/** Kind of access stored per path: read / grep / list / write. */
export type OkfOp = 'read' | 'grep' | 'list' | 'write';

export type OkfVerdictLevel =
  | 'ok'
  | 'fix'
  | 'mess'
  | 'kb_not_used'
  | 'not_enough_data';

/** Known rule ids; the client renders an unknown id as id + raw params (forward compat). */
export type OkfFindingRule =
  | 'session_share'
  | 'always_read'
  | 'kb_flood'
  | 'coarse_article';

export type OkfFindingSeverity = 'fix' | 'mess';

export interface OkfFinding {
  rule: OkfFindingRule;
  severity: OkfFindingSeverity;
  /** Rule parameters; the client renders the text from rule id + params. */
  params: Record<string, string | number>;
  /** `bundle: null` = the "No longer in KB" group. */
  node: { bundle: string | null; path?: string };
}

export type OkfQualifier = 'partial_data';

export interface OkfVerdict {
  level: OkfVerdictLevel;
  qualifiers: OkfQualifier[];
  /** Repo route only: how many KB sessions had no snapshot. */
  partialData?: { withoutSnapshot: number; total: number };
  /** Worst first. */
  findings: OkfFinding[];
}

export interface OkfBundleSummary {
  root: string;
  index: string;
  ignored: boolean;
  /** Null without a snapshot. */
  files: number | null;
  filesRead: number;
  /** Fraction 0-1; null when `files` is null. */
  share: number | null;
  /** KB read bytes (read + grep, own-edit included). */
  readBytes: number;
  /** Session route: started from the bundle's index.md; repo route: null. */
  startedFromIndex: boolean | null;
  /** Repo route: KB sessions whose first access to this bundle was its index.md; session route: null. */
  sessionsStartedFromIndex: number | null;
}

export type OkfTreeMarker =
  | 'folder_scan'
  | 'entry_point'
  | 'own_edit'
  | 'coarse'
  | 'hot';

export interface OkfTreeNode {
  /** Null = "no longer in KB" / unknown bundle (no snapshot). */
  bundle: string | null;
  /** File path, or folder path ending in `/`. */
  path: string;
  kind: 'bundle' | 'folder' | 'file';
  /** False = "not in the KB at session start" / gone. */
  inSnapshot: boolean;
  size: number | null;
  readBytes: number;
  readCalls: number;
  ownEditReadBytes: number;
  grepCalls: number;
  listCalls: number;
  writeCalls: number;
  /** Distinct agents (session route) / distinct sessions (repo route). */
  agents: number;
  markers: OkfTreeMarker[];
  /** Repo route: rank in `hotFiles` (1-based) when the `hot` marker is set. */
  hotRank?: number;
  children?: OkfTreeNode[];
}

export type OkfAgentEntry = 'index' | 'search' | 'given';

/** One element of the session route's `agents[]`. */
export interface OkfAgent {
  /** `sessions.session_id` string. */
  id: string;
  taskHead: string;
  entry: OkfAgentEntry | null;
  /** This agent's `read` + `grep` calls on bundle files. */
  kbReads: number;
  /** Their bytes. */
  kbReadBytes: number;
  /** Those bundle file paths, sorted by read bytes desc, then path. */
  files: string[];
}

export interface OkfReadTopItem {
  bundle: string | null;
  path: string;
  readBytes: number;
  ownEdit: boolean;
}

/** `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`. */
export interface SessionOkfUsageResponse {
  /** Null = no bundle and no KB access in this session. */
  verdict: OkfVerdict | null;
  hasSnapshot: boolean;
  readTop: OkfReadTopItem[];
  bundles: OkfBundleSummary[];
  tree: OkfTreeNode[];
  agents: OkfAgent[];
}

export type OkfShareBin = '0-10' | '10-25' | '25-50' | '50+';

/** `GET /api/v1/repositories/:repoId/reports/okf-usage`. */
export interface RepoOkfUsageResponse {
  verdict: OkfVerdict;
  snapshot: {
    okfSnapshotId: string;
    /** ISO timestamp of the snapshot. */
    takenAt: string;
    branch: string | null;
  } | null;
  tiles: {
    kbFiles: number;
    notRead: number;
    kbSessions: number;
    totalSessions: number;
    /** Count of KB sessions. */
    startedFromIndex: number;
    /** Fractions 0-1; null when no snapshot-bound KB session. */
    medianShare: number | null;
    maxShare: number | null;
  };
  shareBins: { bin: OkfShareBin; sessions: number }[];
  hotFiles: {
    bundle: string | null;
    path: string;
    readBytes: number;
    sessions: number;
  }[];
  notRead: { bundle: string; path: string; size: number }[];
  bundles: OkfBundleSummary[];
  tree: OkfTreeNode[];
}
