/**
 * Types of the repository Tools/MCP tab (task 2026-06-19-mcp-invocation-log-tab).
 *
 * Mirrors the server DTOs in `server/src/logs/tool-monitoring/tool-monitoring.types.ts` and the
 * stored call record (DD-10) / output (DD-9) of `server/src/database/schema/index.ts`; keep them
 * in step.
 */

/** How much a monitored CLI tool's wrapper captures: text + records, or records only. */
export type ToolMonitorCapture = 'full' | 'meta';

/** Which configuration level a monitored tool comes from (DD-2). */
export type ToolMonitorLevel = 'personal' | 'team';

/** Panel hint of a configured tool (DD-20). Precedence: preflight_failed > breaker > hook_too_old > no_data_yet. */
export type ToolMonitorHint =
  | 'preflight_failed'
  | 'breaker'
  | 'hook_too_old'
  | 'no_data_yet';

export type ToolUsageChannel = 'mcp' | 'cli';

export type ToolCallStatus = 'ok' | 'error' | 'killed' | 'no_result';
export type ToolCallHint =
  | 'cut'
  | 'empty'
  | 'truncated'
  | 'no_wrapper'
  | 'indirect'
  | 'persisted';
export type ToolCallSource = 'transcript' | 'wrapper' | 'both';
export type ToolCallAgentKind = 'root' | 'subagent' | 'workflow';
/** Usefulness heuristics (FR-5); the UI labels them as heuristics. */
export type ToolCallSignal = 'empty' | 'retried' | 'opened_file';
export type ToolCallShell = 'bash' | 'powershell';

/**
 * One call's metadata (DD-10): no output text, at most a 300-char `inputPreview`. `toolUseId` is
 * null only for an `indirect` CLI call.
 */
export interface ToolCallRecord {
  callId: string;
  channel: ToolUsageChannel;
  tool: string;
  operation: string;
  /** ISO timestamp of the call start. */
  ts: string;
  durationMs: number | null;
  status: ToolCallStatus;
  hints: ToolCallHint[];
  source: ToolCallSource;
  shell: ToolCallShell | null;
  exitCode: number | null;
  inBytes: number;
  outBytes: number;
  agentSawBytes: number | null;
  toolUseId: string | null;
  agentId: string | null;
  agentKind: ToolCallAgentKind;
  inputPreview: string;
  real: string | null;
  cwd: string | null;
  args: string[] | null;
  signals: ToolCallSignal[];
}

/** One call's captured text (DD-9). `encoding: 'base64'` means stdout/stderr/stdin are base64. */
export interface ToolCallOutput {
  input?: string;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  agentSaw?: string;
  encoding: 'utf8' | 'base64';
}

// ── GET / PUT …/tool-monitoring/config ───────────────────────────────────────────────────────

/** Request body of `PUT …/tool-monitoring/config` (one level's whole list). */
export interface ToolMonitorConfigBody {
  paused: boolean;
  tools: { name: string; enabled: boolean; capture: ToolMonitorCapture }[];
}

/** One row of the config view. */
export interface ToolMonitorConfigToolView {
  name: string;
  enabled: boolean;
  capture: ToolMonitorCapture;
  /** Levels where this name is configured and enabled for the caller. */
  levels: ToolMonitorLevel[];
  /** Latest wrapper record time for the tool across the visible owners, ISO or null. */
  lastWrapperAt: string | null;
  hint: ToolMonitorHint | null;
}

/** The last wrapper status reported by the hook (DD-20). */
export interface ToolWrapStatusView {
  hookVersion: string | null;
  os: string | null;
  preflight: { ok: boolean; reason: string | null };
  breaker: { global: boolean; tools: string[] };
  reportedAt: string;
}

/** Response of `GET` / `PUT …/tool-monitoring/config`. */
export interface ToolMonitorConfigView {
  level: ToolMonitorLevel;
  canEdit: boolean;
  paused: boolean;
  tools: ToolMonitorConfigToolView[];
  /** Most recent report among the visible owners' repository rows; null when none. */
  wrapStatus: ToolWrapStatusView | null;
  /** Names that can never be monitored (FR-8.1). */
  denylist: string[];
}

/** Body of a 400 from the config PUT. */
export interface ToolMonitorConfigError {
  message: string;
  /** `paused`, `tools`, `tools[i]`, `tools[i].name`, `tools[i].enabled` or `tools[i].capture`. */
  field: string;
  /** A `validateToolName` code, or `invalid` / `too_many` / `duplicate`. */
  code: string;
}

// ── GET …/tool-monitoring/summary ────────────────────────────────────────────────────────────

/** Summed figures of a set of calls (DD-11 aggregates folded for the response). */
export interface ToolUsageAgg {
  calls: number;
  errors: number;
  killed: number;
  noResult: number;
  empty: number;
  retried: number;
  openedFile: number;
  avgDurationMs: number | null;
  inBytes: number;
  outBytes: number;
}

export type ToolUsageOperationSummary = ToolUsageAgg & {
  operation: string;
  lastUsedAt: string | null;
};

export type ToolUsageToolSummary = ToolUsageAgg & {
  channel: ToolUsageChannel;
  tool: string;
  lastUsedAt: string | null;
  operations: ToolUsageOperationSummary[];
};

export interface ToolUsageSummaryResponse {
  range: { from: string; to: string };
  /** In-scope, non-deleted sessions in range whose rows are still pending a rebuild. */
  pendingSessions: number;
  totals: ToolUsageAgg;
  groups: {
    mcp: { tools: number } & ToolUsageAgg;
    cli: { tools: number } & ToolUsageAgg;
  };
  tools: ToolUsageToolSummary[];
  /** Monitored CLI tools with no call in range and scope. */
  neverCalled: string[];
}

// ── GET …/tool-monitoring/calls ──────────────────────────────────────────────────────────────

/** The owner of a call's session; `email` is masked per scope. */
export interface ToolCallSessionOwner {
  id: number;
  email: string | null;
}

/** One calls-table row: the DD-10 record without `args` / `cwd`. */
export type ToolCallListItem = Omit<ToolCallRecord, 'args' | 'cwd'> & {
  usageId: number;
  /** External session id of the node that holds the call. */
  sessionId: string;
  sessionOwner: ToolCallSessionOwner;
};

export interface ToolCallsPageResponse {
  total: number;
  page: number;
  pageSize: number;
  items: ToolCallListItem[];
}

// ── GET …/tool-monitoring/calls/:usageId/:callId ─────────────────────────────────────────────

export interface ToolCallDetailResponse {
  call: ToolCallRecord & {
    usageId: number;
    sessionId: string;
    rootSessionId: string;
    /** The tree root's uploader, e-mail masked per scope. */
    sessionOwner: ToolCallSessionOwner;
  };
  output: ToolCallOutput;
  link: { sessionId: string; toolUseId: string | null };
}
