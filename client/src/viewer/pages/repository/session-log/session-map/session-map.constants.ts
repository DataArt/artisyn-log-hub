/**
 * Client constants of the Session Map tab (session-map impl-plan Design Decisions 13, 17, 18, 22).
 * `DELTA_CURSOR_MAX_CHARS` is server-only (`server/src/logs/session-logs-delta.ts`).
 */

/** Delta poll interval while the session is live. Client-only; no server value has to match. */
export const SESSION_MAP_POLL_MS = 10_000;
/** How often "following now" advances the time position. */
export const FOLLOW_TICK_MS = 1_000;

/** Equal-width timeline bins between session start and end. */
export const TIMELINE_BINS = 120;
/** Candidate tick steps in minutes; the first that gives at most {@link MAX_TICKS} wins. */
export const TICK_STEPS_MIN: readonly number[] = [5, 10, 30, 60];
export const MAX_TICKS = 8;

/** Replay speed multipliers. */
export const PLAYBACK_SPEEDS: readonly number[] = [1, 10, 60, 300];
export const DEFAULT_SPEED = 60;

/** "Top N by cost" highlight size. */
export const TOP_N_HIGHLIGHT = 5;
/** Agent card label length before truncation with `…`. */
export const AGENT_LABEL_MAX = 60;
/** NFR: model + render of a time-position change, in ms (visual check only). */
export const RENDER_BUDGET_MS = 100;

export type ToolFamilyId =
  | 'explore'
  | 'edit'
  | 'shell'
  | 'mcp'
  | 'orch'
  | 'other';

export interface ToolFamily {
  id: ToolFamilyId;
  label: string;
  /** Exact tool names of this family; empty for `mcp` (prefix) and `other` (fallback). */
  tools: readonly string[];
  /** Tool-name prefix matched instead of `tools` (only `mcp`). */
  prefix?: string;
  color: string;
}

/** Tool families, matched by tool name in table order (Design Decision 13). */
export const FAMILIES: readonly ToolFamily[] = [
  {
    id: 'explore',
    label: 'Read · Grep · Glob',
    tools: ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'],
    color: '#0ea5e9',
  },
  {
    id: 'edit',
    label: 'Edit · Write',
    tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    color: '#10b981',
  },
  {
    id: 'shell',
    label: 'Bash · PowerShell',
    tools: ['Bash', 'PowerShell', 'Monitor', 'BashOutput', 'KillShell'],
    color: '#f59e0b',
  },
  { id: 'mcp', label: 'MCP', tools: [], prefix: 'mcp__', color: '#8b5cf6' },
  {
    id: 'orch',
    label: 'Skill · Agent · Workflow',
    tools: [
      'Skill',
      'Agent',
      'Task',
      'Workflow',
      'ToolSearch',
      'TaskStop',
      'CronCreate',
      'CronDelete',
    ],
    color: '#ec4899',
  },
  { id: 'other', label: 'other', tools: [], color: '#94a3b8' },
];

/** Failed calls (status `error` / `rejected`). */
export const FAILED_COLOR = '#ef4444';
/** Cumulative cost line on the timeline. */
export const COST_LINE_COLOR = '#2563eb';
/** Context bar on a card. */
export const CONTEXT_BAR_COLOR = '#64748b';

/** Layout, in px unless noted. */
export const MAIN_CARD_MAX_W = 720;
export const COLUMN_W = 260;
export const COLUMN_GAP = 16;
/** A column scrolls vertically once it holds more than this many cards. */
export const COLUMN_SCROLL_AFTER = 16;
export const PANEL_W = 360;
export const TIMELINE_H = 140;
export const NEST_INDENT = 16;
