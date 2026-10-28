/**
 * Server constants of the Tools/MCP monitoring feature (impl-plan DD-22).
 *
 * The capture limits and the tool-name rules live in `@loghub/tool-monitor` (DD-4); the hook's
 * own constants live in `hook/.claude/telemetry_tool/tool-wrap-names.js`.
 */

/**
 * Version of the tool-usage extractor that built a node's `session_tool_usage` rows, stored in
 * `sessions.tool_usage_version` (DD-7). Bump it when the extraction changes: on the next start
 * `initializeDatabase()` sets every older version back to NULL, so the drain rebuilds them.
 */
export const TOOL_USAGE_EXTRACTOR_VERSION = 1;

/** Drain period when `TOOL_USAGE_REBUILD_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_TOOL_USAGE_REBUILD_INTERVAL_MS = 15_000;

/** Sessions claimed per drain pass when `TOOL_USAGE_REBUILD_BATCH` is unset or invalid. */
export const DEFAULT_TOOL_USAGE_REBUILD_BATCH = 20;

/** Reads `name` as a positive integer, else returns `fallback`. */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/** `TOOL_USAGE_REBUILD_INTERVAL_MS` when it is a positive integer, else the default. */
export function resolveToolUsageRebuildIntervalMs(): number {
  return readPositiveIntEnv(
    'TOOL_USAGE_REBUILD_INTERVAL_MS',
    DEFAULT_TOOL_USAGE_REBUILD_INTERVAL_MS,
  );
}

/** `TOOL_USAGE_REBUILD_BATCH` when it is a positive integer, else the default. */
export function resolveToolUsageRebuildBatch(): number {
  return readPositiveIntEnv(
    'TOOL_USAGE_REBUILD_BATCH',
    DEFAULT_TOOL_USAGE_REBUILD_BATCH,
  );
}

/** Max characters of a call's `inputPreview` in `session_tool_usage.calls` (DD-9, DD-10). */
export const INPUT_PREVIEW_CHARS = 300;

/** Slack added on both sides of a tool_use window when matching wrapper records (DD-12). */
export const MATCH_WINDOW_SLACK_MS = 2_000;

/** How many following tool_uses of the same agent the usefulness signals look at (DD-12). */
export const SIGNAL_LOOKAHEAD = 3;

/** Default page size of the calls route (DD-18). */
export const CALLS_PAGE_SIZE_DEFAULT = 50;

/** Max page size of the calls route (DD-18). */
export const CALLS_PAGE_SIZE_MAX = 200;

/** Max length of the calls route's `q` search parameter (API changes). */
export const SEARCH_MAX_CHARS = 200;
