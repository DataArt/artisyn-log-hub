/**
 * URL state of the Tools/MCP tab (DD-21), both the repo main tab and the session detail tab.
 * Every filter and the selected call live in a `t*` search param so a view can be linked and
 * survives a reload; `setMainTab`, `setSessionTab` and a session switch drop all of them
 * (`TOOLS_PARAM_KEYS`) when the user leaves the tab. The session tab has no date range.
 *
 * | Param | Meaning | Absent means |
 * |---|---|---|
 * | `tfrom`, `tto` | date-only bounds (YYYY-MM-DD) | last 30 days |
 * | `tstatus` | `ok` / `error` / `killed` / `no_result` | every status |
 * | `tq` | search text (≤ 200 chars) | no search |
 * | `tch`, `ttool`, `toper` | tree scope: channel, tool, operation | all tools |
 * | `tcall` | selected call, `<usageId>:<callId>` | none selected |
 * | `tpage` | calls page, 1-based | 1 |
 *
 * The operation scope is `toper`, not `top` as first sketched in DD-21: the Sessions tab
 * already owns `top` (its top-N filter), and sharing it would leak one tab's value into the
 * other and drop the Sessions value on every tab switch.
 */
import type {
  ToolCallStatus,
  ToolUsageChannel,
} from '../../../../models/tool-monitoring';
import { defaultDateRange } from '../reports/report-url';

/** Most search characters the server accepts (`SEARCH_MAX_CHARS`). */
const SEARCH_MAX_CHARS = 200;

export interface ToolsScope {
  channel: ToolUsageChannel | null;
  tool: string | null;
  operation: string | null;
}

export interface ToolsCallRef {
  usageId: number;
  callId: string;
}

export interface ToolsTabUrlState {
  startDate: string;
  endDate: string;
  status: ToolCallStatus | null;
  q: string;
  scope: ToolsScope;
  call: ToolsCallRef | null;
  page: number;
}

/** Every param the tab owns; `setMainTab` deletes these when leaving the tab. */
export const TOOLS_PARAM_KEYS = [
  'tfrom',
  'tto',
  'tstatus',
  'tq',
  'tch',
  'ttool',
  'toper',
  'tcall',
  'tpage',
] as const;

const STATUSES: readonly ToolCallStatus[] = [
  'ok',
  'error',
  'killed',
  'no_result',
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseStatus(raw: string | null): ToolCallStatus | null {
  return STATUSES.find((s) => s === raw) ?? null;
}

function parseChannel(raw: string | null): ToolUsageChannel | null {
  return raw === 'mcp' || raw === 'cli' ? raw : null;
}

/** `<usageId>:<callId>`; the call id may itself contain `:`. */
export function parseCallRef(raw: string | null): ToolsCallRef | null {
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep === raw.length - 1) return null;
  const usageId = Number(raw.slice(0, sep));
  if (!Number.isInteger(usageId) || usageId <= 0) return null;
  return { usageId, callId: raw.slice(sep + 1) };
}

export function formatCallRef(ref: ToolsCallRef): string {
  return `${ref.usageId}:${ref.callId}`;
}

function parsePage(raw: string | null): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * The tab state read from the URL. Invalid values fall back to their defaults; a tool or
 * operation without the scope above it is dropped (an operation needs a tool, a tool a channel).
 */
export function toolsStateFromParams(p: URLSearchParams): ToolsTabUrlState {
  const defaults = defaultDateRange();
  const from = p.get('tfrom');
  const to = p.get('tto');
  const channel = parseChannel(p.get('tch'));
  const tool = channel ? p.get('ttool') || null : null;
  const operation = tool ? p.get('toper') || null : null;
  return {
    startDate: from && DATE_ONLY.test(from) ? from : defaults.startDate,
    endDate: to && DATE_ONLY.test(to) ? to : defaults.endDate,
    status: parseStatus(p.get('tstatus')),
    q: (p.get('tq') ?? '').slice(0, SEARCH_MAX_CHARS),
    scope: { channel, tool, operation },
    call: parseCallRef(p.get('tcall')),
    page: parsePage(p.get('tpage')),
  };
}

/**
 * A copy of `p` with every tab param rewritten from `s` (empty values and page 1 left out).
 * `withRange: false` (the session tab, which has no date range) leaves `tfrom` / `tto` out.
 */
export function writeToolsState(
  p: URLSearchParams,
  s: ToolsTabUrlState,
  { withRange = true }: { withRange?: boolean } = {},
): URLSearchParams {
  const next = new URLSearchParams(p);
  for (const key of TOOLS_PARAM_KEYS) next.delete(key);
  if (withRange) {
    next.set('tfrom', s.startDate);
    next.set('tto', s.endDate);
  }
  if (s.status) next.set('tstatus', s.status);
  const q = s.q.trim().slice(0, SEARCH_MAX_CHARS);
  if (q) next.set('tq', q);
  if (s.scope.channel) {
    next.set('tch', s.scope.channel);
    if (s.scope.tool) {
      next.set('ttool', s.scope.tool);
      if (s.scope.operation) next.set('toper', s.scope.operation);
    }
  }
  if (s.call) next.set('tcall', formatCallRef(s.call));
  if (s.page > 1) next.set('tpage', String(s.page));
  return next;
}
