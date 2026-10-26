/**
 * Response DTOs for the four usage-analytics endpoints.
 *
 * Mirrored verbatim in `client/src/models/repositories.ts`. The four `analytics/*` routes and
 * the four `reports/*` routes return these same shapes from these same services, so a report
 * and its analytics view can never disagree.
 *
 * Every figure here is aggregated from pre-computed columns (`session_stats`,
 * `session_tool_stats`) — no endpoint in this module parses `logs.body`.
 */

/** Which source produced a tool call's duration. Displayed, never inferred. */
export type DurationSource = 'toolUseResult' | 'taskTotal' | 'timestampDelta';

export interface ToolAnalyticsRow {
  /** `'Bash'`, `'mcp__postgres__query'`, … — the full tool name. */
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
  /** Numerator of "over N of M calls"; `M` is `calls`. */
  durationCoveredCalls: number;
  durationP50Ms: number | null;
  durationMaxMs: number | null;
  durationMeanMs: number | null;
  /** `true` at repository scope (interpolated from the histogram), `false` at session scope. */
  durationApproximate: boolean;
  durationBySource: Record<DurationSource, number>;
  /**
   * Calls that ran in a wall-clock-overlapping batch, so the row can be badged. There is
   * deliberately no summed "total tool time" field anywhere in this DTO.
   */
  parallelBatchCalls: number;
}

export interface McpServerRow {
  server: string;
  calls: number;
  failures: number;
  unresolved: number;
}

export interface ToolAnalyticsResponse {
  /** All scopes combined — the main ranking. */
  tools: ToolAnalyticsRow[];
  /** Descendant depth 0: the root session's own calls. */
  mainAgent: ToolAnalyticsRow[];
  /** Descendant depth > 0: sub-agent calls. */
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
  /** Per UTC day, keyed on the root session's start time. */
  buckets: ({ bucket: string } & TokenTotals)[];
}

export interface ProductivityTotals {
  /** Diff-based — NOT `session_stats.lines_changed`, which counts lines written. */
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
  /** ISO 8601. */
  lastActivity: string;
  workTimeMs: number;
  turns: number;
  totalTokens: number;
  /**
   * The tree's complete computed cost (root + sub-agents + utility calls, the same figure as
   * the sessions list); `null` when it cannot be computed — see `costUnavailableReason`.
   */
  totalCost: number | null;
  /** Model ids of the tree with no price in Log Hub (root, sub-agents, utility calls), sorted. */
  unpricedModels: string[];
  /** `'unknown-model'` when `totalCost` is null because a model has no price; else null. */
  costUnavailableReason: 'unknown-model' | null;
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

export const ACTIVE_SESSIONS_DEFAULT_LIMIT = 100;
export const ACTIVE_SESSIONS_MAX_LIMIT = 500;

/** One user's row in the Claude Code version usage report. */
export interface ClaudeVersionUsageRow {
  userId: number;
  userEmail: string;
  /** Root sessions in range with a known version and known reference release versions. */
  sessionsChecked: number;
  /** Checked sessions whose version was below the stable release current at session start. */
  outdatedSessions: number;
}

export interface ClaudeVersionUsageResponse {
  /** Users with `outdatedSessions > 0` first, then by `userEmail` ascending. */
  rows: ClaudeVersionUsageRow[];
}
