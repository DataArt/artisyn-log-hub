/**
 * Pure helpers of the Tools/MCP tree (DD-25): rates, colours, the "last used" roll-up and the
 * descending sort shared by every tree level (group, tool, operation).
 */
import type {
  ToolUsageAgg,
  ToolUsageChannel,
  ToolUsageToolSummary,
} from '../../../../models/tool-monitoring';
import { ERROR_PCT_AMBER, ERROR_PCT_RED } from './tools-constants';

/** Sort keys of the tree, all descending. */
export type ToolsTreeSortKey = 'calls' | 'error' | 'retried' | 'last';

export const TOOLS_TREE_SORT_LABELS: Record<ToolsTreeSortKey, string> = {
  calls: 'Calls',
  error: 'Error %',
  retried: 'Retried %',
  last: 'Last used',
};

/** The sort keys in control order. */
export const TOOLS_TREE_SORT_KEYS: readonly ToolsTreeSortKey[] = [
  'calls',
  'error',
  'retried',
  'last',
];

/** `error %` = (errors + killed) / calls (DD-11), 0 for no calls. */
export function errorPct(agg: ToolUsageAgg): number {
  return agg.calls > 0 ? ((agg.errors + agg.killed) / agg.calls) * 100 : 0;
}

/** `retried %` = retried / calls (DD-11), 0 for no calls. */
export function retriedPct(agg: ToolUsageAgg): number {
  return agg.calls > 0 ? (agg.retried / agg.calls) * 100 : 0;
}

/** Text colour of an error % chip: grey below amber, amber below red, red at and above red. */
export function errorPctClass(pct: number): string {
  if (pct >= ERROR_PCT_RED) return 'bg-red-500/15 text-red-700';
  if (pct >= ERROR_PCT_AMBER) return 'bg-amber-500/15 text-amber-700';
  return 'bg-muted text-muted-foreground';
}

/** `12 %`, `3.4 %`, `0 %`. */
export function formatPct(pct: number): string {
  if (pct === 0) return '0 %';
  return pct < 10 ? `${pct.toFixed(1)} %` : `${Math.round(pct)} %`;
}

function maxIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v && (best === null || v > best)) best = v;
  }
  return best;
}

/** Last used of a tool = max `lastUsedAt` of its operations, falling back to the tool's own. */
export function toolLastUsed(tool: ToolUsageToolSummary): string | null {
  return maxIso([tool.lastUsedAt, ...tool.operations.map((o) => o.lastUsedAt)]);
}

/** Last used of a group of tools. */
export function groupLastUsed(
  tools: readonly ToolUsageToolSummary[],
): string | null {
  return maxIso(tools.map(toolLastUsed));
}

function sortValue(
  agg: ToolUsageAgg,
  last: string | null,
  key: ToolsTreeSortKey,
): number {
  switch (key) {
    case 'error':
      return errorPct(agg);
    case 'retried':
      return retriedPct(agg);
    case 'last':
      return last ? Date.parse(last) || 0 : 0;
    default:
      return agg.calls;
  }
}

/**
 * A copy of `items` sorted descending by `key`; ties fall back to calls, then to the label
 * ascending, so the order is stable between refetches.
 */
export function sortTreeItems<T>(
  items: readonly T[],
  key: ToolsTreeSortKey,
  agg: (item: T) => ToolUsageAgg,
  last: (item: T) => string | null,
  label: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const diff =
      sortValue(agg(b), last(b), key) - sortValue(agg(a), last(a), key);
    if (diff !== 0) return diff;
    const calls = agg(b).calls - agg(a).calls;
    if (calls !== 0) return calls;
    return label(a).localeCompare(label(b));
  });
}

export const CHANNEL_LABELS: Record<ToolUsageChannel, string> = {
  mcp: 'MCP',
  cli: 'CLI',
};

/** Channel badge colours: MCP violet (as the session log's MCP tool chips), CLI slate. */
export const CHANNEL_BADGE_CLASS: Record<ToolUsageChannel, string> = {
  mcp: 'bg-violet-500/20 text-violet-700',
  cli: 'bg-slate-500/15 text-slate-700',
};

/** An empty aggregate, used for `never called` rows. */
export const EMPTY_AGG: ToolUsageAgg = {
  calls: 0,
  errors: 0,
  killed: 0,
  noResult: 0,
  empty: 0,
  retried: 0,
  openedFile: 0,
  avgDurationMs: null,
  inBytes: 0,
  outBytes: 0,
};
