/**
 * Labels of a tool call's status, hints and signals, shared by the Tools/MCP calls table and
 * the call details.
 */
import type {
  ToolCallAgentKind,
  ToolCallHint,
  ToolCallSignal,
  ToolCallStatus,
} from '../../../../models/tool-monitoring';

export const STATUS_BADGE_BASE =
  'rounded px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap';

export const STATUS_BADGE: Record<
  ToolCallStatus,
  { label: string; cls: string }
> = {
  ok: { label: '✓ ok', cls: 'bg-green-500/20 text-green-700' },
  error: { label: '✗ error', cls: 'bg-red-500/20 text-red-700' },
  killed: { label: '⊘ killed', cls: 'bg-amber-500/20 text-amber-700' },
  no_result: { label: 'no result', cls: 'bg-muted text-muted-foreground' },
};

export const HINT_LABELS: Record<ToolCallHint, string> = {
  cut: 'cut',
  empty: 'empty',
  truncated: 'truncated',
  no_wrapper: 'no wrapper',
  indirect: 'indirect',
  persisted: 'persisted',
};

export const HINT_TITLES: Record<ToolCallHint, string> = {
  cut: 'The agent received less output than the tool wrote',
  empty: 'The output was empty',
  truncated:
    'The stored text was cut at the capture limit, or the tool was stopped early',
  no_wrapper: 'Recognised from the transcript only; no wrapper record',
  indirect: 'Run by another command, not named by the agent',
  persisted:
    'Claude Code saved the large output to a file instead of the transcript',
};

export const SIGNAL_LABELS: Record<ToolCallSignal, string> = {
  empty: 'Empty result',
  retried: 'Retried',
  opened_file: 'Opened a file from the output',
};

/** Tooltip text of each signal; every one says it is a heuristic (FR-5). */
export const SIGNAL_TITLES: Record<ToolCallSignal, string> = {
  empty:
    'Heuristic: the output was empty or read like "no results" / "not found".',
  retried:
    'Heuristic: the same agent called the same tool and operation again within its next 3 tool calls.',
  opened_file:
    'Heuristic: within its next 3 tool calls the agent read or edited a file named in this output.',
};

export const AGENT_KIND_LABELS: Record<ToolCallAgentKind, string> = {
  root: 'main agent',
  subagent: 'sub-agent',
  workflow: 'workflow agent',
};
