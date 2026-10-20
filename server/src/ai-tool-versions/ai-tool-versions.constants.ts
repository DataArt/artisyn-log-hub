/** Tool name of Claude Code in `ai_tool_version` / `ai_tool_version_history`. */
export const CLAUDE_CODE_TOOL = 'claude-code';

/** npm registry endpoint returning Claude Code's dist-tags (`latest`, `stable`, ...). */
export const CLAUDE_CODE_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';

export interface AiToolConfig {
  distTagsUrl: string;
}

/** Known AI tools, looked up by tool name. */
export const AI_TOOLS: Readonly<Record<string, AiToolConfig>> = {
  [CLAUDE_CODE_TOOL]: { distTagsUrl: CLAUDE_CODE_DIST_TAGS_URL },
};

/** Timeout for the outbound dist-tags fetch. */
export const FETCH_TIMEOUT_MS = 5_000;

/** A successful fetch older than this is re-fetched (bound via `make_interval(hours => ...)`). */
export const STALE_AFTER_HOURS = 24;

/** Minimum gap after the last attempt before another worker may retry (bound via `make_interval(hours => ...)`). */
export const RETRY_AFTER_HOURS = 1;

const DEFAULT_CHECK_INTERVAL_MS = 3_600_000;

/**
 * Scheduler tick interval. Reads env `AI_TOOL_VERSION_CHECK_INTERVAL_MS` at call time;
 * falls back to 1 h when unset or not a positive integer.
 */
export function getCheckIntervalMs(): number {
  const raw = process.env.AI_TOOL_VERSION_CHECK_INTERVAL_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim()))
    return DEFAULT_CHECK_INTERVAL_MS;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CHECK_INTERVAL_MS;
}

/** The version check is on unless env `AI_TOOL_VERSION_CHECK_ENABLED` is exactly `'false'`. */
export function isCheckEnabled(): boolean {
  return process.env.AI_TOOL_VERSION_CHECK_ENABLED !== 'false';
}

/** Name of the interval registered in NestJS `SchedulerRegistry`. */
export const SCHEDULER_NAME = 'ai-tool-version-check';
