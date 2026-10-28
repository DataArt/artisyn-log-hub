/**
 * Response DTOs of the Tools/MCP monitoring routes (impl-plan "API changes").
 *
 * The client mirrors these in `client/src/models/tool-monitoring.ts`; keep both in step. The
 * stored jsonb shapes they build on (DD-9 to DD-11, DD-20) live in the schema file.
 */
import type {
  ToolCallOutput,
  ToolCallRecord,
  ToolMonitorCapture,
  ToolUsageChannel,
} from '../../database/schema/index';

/** Which configuration level a monitored tool comes from (DD-2). */
export type ToolMonitorLevel = 'personal' | 'team';

/** Panel hint of a configured tool (DD-20), in precedence order. */
export type ToolMonitorHint =
  | 'preflight_failed'
  | 'breaker'
  | 'hook_too_old'
  | 'no_data_yet';

// ── Hook route: GET /api/v2/tool-monitoring/config ───────────────────────────────────────────

/**
 * The hook-facing config (DD-3). The hook acts only on `schemaVersion === 1` fields; later
 * servers may add fields without bumping the version.
 */
export interface HookToolMonitorConfigResponse {
  schemaVersion: 1;
  paused: boolean;
  tools: { name: string; capture: ToolMonitorCapture }[];
}

/** The merged personal ∪ team monitored set of one owner and repository URL (DD-2). */
export interface ResolvedMonitoredTools {
  paused: boolean;
  tools: {
    name: string;
    capture: ToolMonitorCapture;
    levels: ToolMonitorLevel[];
  }[];
}

// ── UI route: GET / PUT …/tool-monitoring/config ─────────────────────────────────────────────

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

/** The last wrapper status reported by the hook, as shown on the panel (DD-20). */
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

// ── UI route: GET …/tool-monitoring/summary ──────────────────────────────────────────────────

/** Summed figures of a set of calls (DD-11 aggregates folded for the response). */
export interface ToolUsageAgg {
  calls: number;
  errors: number;
  killed: number;
  noResult: number;
  empty: number;
  retried: number;
  fellBack: number;
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

// ── UI route: GET …/tool-monitoring/calls ────────────────────────────────────────────────────

/** The owner of a call's session; `email` is masked per scope. */
export interface ToolCallSessionOwner {
  id: number;
  email: string | null;
}

/** One calls-table row: the DD-10 record without `args` / `cwd`. */
export type ToolCallListItem = Omit<ToolCallRecord, 'args' | 'cwd'> & {
  usageId: number;
  /** `sessions.session_id` of the node that holds the call. */
  sessionId: string;
  sessionOwner: ToolCallSessionOwner;
};

export interface ToolCallsPageResponse {
  total: number;
  page: number;
  pageSize: number;
  items: ToolCallListItem[];
}

// ── UI route: GET …/tool-monitoring/calls/:usageId/:callId ───────────────────────────────────

export interface ToolCallDetailResponse {
  call: ToolCallRecord & {
    usageId: number;
    sessionId: string;
    rootSessionId: string;
    /** The tree root's uploader, e-mail masked per scope (DD-25 details meta line). */
    sessionOwner: ToolCallSessionOwner;
  };
  output: ToolCallOutput;
  link: { sessionId: string; toolUseId: string | null };
}
