/**
 * Row builders shared by the four usage report documents and their PDF exports.
 *
 * `ReportKpiRow` and `PdfKpiRow` are structurally identical for the fields used here, so one
 * builder feeds both shells and the on-page document can never drift from the printed one —
 * the same arrangement `cache-read-ratio-rows.ts` uses.
 */
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import {
  formatCoverage,
  formatDiffCoverageNote,
  formatSuccessRate,
  formatToolDuration,
  NO_VALUE,
} from '@/lib/usage-analytics-format';
import type {
  ActiveSessionsResponse,
  ProductivityAnalyticsResponse,
  TokenAnalyticsResponse,
  ToolAnalyticsResponse,
} from '../../../../models/repositories';
import type { ClaudeVersionUsageRow } from '../../../api';
import type { ReportKpiRow } from './ReportKpiTable';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

function count(n: number): string {
  return n.toLocaleString();
}

// --- Tool analytics -----------------------------------------------------------------------

export const TOOL_TABLE_COLUMNS = [
  'Tool',
  'Calls',
  'Success rate',
  'Failures',
  'Unresolved',
  'Median',
  'Max',
  'Coverage',
];

export const MCP_TABLE_COLUMNS = [
  'MCP server',
  'Calls',
  'Failures',
  'Unresolved',
];

export function buildToolKpiRows(data: ToolAnalyticsResponse): ReportKpiRow[] {
  const failures = data.tools.reduce((n, r) => n + r.failures, 0);
  const unresolved = data.tools.reduce((n, r) => n + r.unresolved, 0);
  const successes = data.tools.reduce((n, r) => n + r.successes, 0);
  const resolved = successes + failures;
  const mainCalls = data.mainAgent.reduce((n, r) => n + r.calls, 0);
  const subCalls = data.subAgent.reduce((n, r) => n + r.calls, 0);

  return [
    { label: 'Tool calls', value: count(data.totalCalls), emphasize: true },
    { label: 'Distinct tools used', value: count(data.tools.length) },
    { label: 'Main-agent calls', value: count(mainCalls), indent: true },
    { label: 'Sub-agent calls', value: count(subCalls), indent: true },
    {
      label: 'Success rate (resolved calls only)',
      value: resolved > 0 ? formatSuccessRate(failures / resolved) : NO_VALUE,
    },
    { label: 'Failures', value: count(failures) },
    {
      label: 'Unresolved (no result, rejected or interrupted)',
      value: count(unresolved),
    },
    {
      label: 'Calls in a wall-clock-overlapping batch',
      value: count(data.parallelBatchCalls),
    },
    { label: 'MCP servers used', value: count(data.mcpServers.length) },
  ];
}

/** One `TOOL_TABLE_COLUMNS` row. Medians are prefixed ≈ — repository scope interpolates them. */
export function buildToolTableRow(
  row: ToolAnalyticsResponse['tools'][number],
): string[] {
  return [
    row.tool,
    count(row.calls),
    formatSuccessRate(row.failureRate),
    count(row.failures),
    count(row.unresolved),
    formatToolDuration(row.durationP50Ms, row.durationApproximate),
    formatToolDuration(row.durationMaxMs, false),
    formatCoverage(row.durationCoveredCalls, row.calls),
  ];
}

export function buildMcpTableRow(
  row: ToolAnalyticsResponse['mcpServers'][number],
): string[] {
  return [
    row.server,
    count(row.calls),
    count(row.failures),
    count(row.unresolved),
  ];
}

export const TOOL_DURATION_FOOTNOTE =
  'Medians are marked ≈ because repository-scope values are interpolated from fixed duration buckets; a session\'s Usage tab shows its exact median. Coverage states how many of a tool\'s calls had a derivable duration. Unresolved calls are excluded from the success-rate denominator, and no summed "total tool time" is reported because parallel batches overlap in wall clock.';

// --- Token usage --------------------------------------------------------------------------

export const TOKEN_TABLE_COLUMNS = [
  '',
  'Input',
  'Output',
  'Cache read',
  'Cache creation',
  '5m TTL',
  '1h TTL',
];

export function buildTokenKpiRows(
  data: TokenAnalyticsResponse,
): ReportKpiRow[] {
  const { totals } = data;
  return [
    { label: 'Input tokens', value: formatTokens(totals.input) },
    { label: 'Output tokens', value: formatTokens(totals.output) },
    { label: 'Cache read tokens', value: formatTokens(totals.cacheRead) },
    {
      label: 'Cache creation tokens',
      value: formatTokens(totals.cacheCreation),
      emphasize: true,
    },
    {
      label: '5m TTL',
      value: formatTokens(totals.cacheWrite5m),
      indent: true,
    },
    {
      label: '1h TTL',
      value: formatTokens(totals.cacheWrite1h),
      indent: true,
    },
    {
      label: 'Service tiers observed',
      value: count(data.byServiceTier.length),
    },
  ];
}

export function buildTokenTableRow(
  label: string,
  totals: TokenAnalyticsResponse['totals'],
): string[] {
  return [
    label,
    formatTokens(totals.input),
    formatTokens(totals.output),
    formatTokens(totals.cacheRead),
    formatTokens(totals.cacheCreation),
    formatTokens(totals.cacheWrite5m),
    formatTokens(totals.cacheWrite1h),
  ];
}

export const TOKEN_FOOTNOTE =
  'The 5m and 1h cache-creation buckets are reported separately and never summed into one figure. Messages whose usage object carried no service_tier are grouped under "unknown". Totals follow each call\'s top-level message.usage; the per-iterations breakdown is shown only in a session\'s Usage tab and is never added to a total.';

// --- Productivity counters ----------------------------------------------------------------

export const PRODUCTIVITY_TABLE_COLUMNS = [
  'Day (UTC)',
  'Lines added (diff-based)',
  'Lines removed (diff-based)',
  'Commits',
  'Pull requests',
];

export function buildProductivityKpiRows(
  data: ProductivityAnalyticsResponse,
): ReportKpiRow[] {
  const { totals } = data;
  return [
    {
      label: 'Lines added (diff-based)',
      value: count(totals.linesAdded),
      emphasize: true,
    },
    {
      label: 'Lines removed (diff-based)',
      value: count(totals.linesRemoved),
      emphasize: true,
    },
    { label: 'Commits', value: count(totals.commits) },
    { label: 'Pull requests', value: count(totals.pullRequests) },
    {
      label: 'Edit/Write calls with a usable diff',
      value: `${count(totals.diffCoveredCalls)} of ${count(totals.diffTotalCalls)}`,
    },
  ];
}

export function buildProductivityTableRow(
  bucket: ProductivityAnalyticsResponse['buckets'][number],
): string[] {
  return [
    bucket.bucket,
    count(bucket.linesAdded),
    count(bucket.linesRemoved),
    count(bucket.commits),
    count(bucket.pullRequests),
  ];
}

/**
 * Coverage note plus the explicit statement that these are NOT the written-lines metric.
 * The requirement forbids showing both measures on one page, so this report names only the
 * diff-based figures and explains the distinction in prose instead.
 */
export function buildProductivityFootnote(
  data: ProductivityAnalyticsResponse,
): string {
  return `${formatDiffCoverageNote(
    data.totals.diffCoveredCalls,
    data.totals.diffTotalCalls,
  )} These are diff-based counts and are a different measure from the written-lines metric used by the Productivity and Executive Summary reports, which counts lines written by Edit/Write with no delta and no removals. Commits and pull requests are counted per invocation inside Bash commands.`;
}

// --- Active sessions ----------------------------------------------------------------------

export const ACTIVE_SESSIONS_TABLE_COLUMNS = [
  'Session',
  'User',
  'Branch',
  'Last activity',
  'Work time',
  'Turns',
  'Tokens',
  'Cost',
  'Tools',
  'Lines +',
  'Lines −',
  'Top tool',
];

export function buildActiveSessionsKpiRows(
  data: ActiveSessionsResponse,
): ReportKpiRow[] {
  const sessions = data.sessions;
  const totalCost = sessions.reduce((n, s) => n + (s.totalCost ?? 0), 0);
  const anyPriced = sessions.some((s) => s.totalCost !== null);
  return [
    {
      label: 'Sessions listed',
      value: count(sessions.length),
      emphasize: true,
    },
    {
      label: 'Total work time',
      value: formatDuration(sessions.reduce((n, s) => n + s.workTimeMs, 0)),
    },
    { label: 'Turns', value: count(sessions.reduce((n, s) => n + s.turns, 0)) },
    {
      label: 'Tokens',
      value: formatTokens(sessions.reduce((n, s) => n + s.totalTokens, 0)),
    },
    { label: 'Cost', value: anyPriced ? formatCost(totalCost) : NO_VALUE },
    {
      label: 'Tool calls',
      value: count(sessions.reduce((n, s) => n + s.toolCalls, 0)),
    },
    {
      label: 'Row limit applied',
      value: data.truncated
        ? `${count(data.limit)} (truncated)`
        : count(data.limit),
    },
  ];
}

/** `YYYY-MM-DD HH:mm` in the viewer's local zone — never a raw ISO string. */
export function formatActivityStamp(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return NO_VALUE;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Truncated so a long first prompt cannot break the PDF table layout. */
export function buildActiveSessionRow(
  row: ActiveSessionsResponse['sessions'][number],
): string[] {
  // A null prompt here can only be a `manager`'s masked row,
  // never a missing value — so it reads as hidden, not as a bare session id.
  const label = row.firstPrompt ?? PROMPT_HIDDEN_LABEL;
  return [
    label.length > 48 ? `${label.slice(0, 47)}…` : label,
    row.userEmail,
    row.gitBranch ?? NO_VALUE,
    formatActivityStamp(row.lastActivity),
    formatDuration(row.workTimeMs),
    count(row.turns),
    formatTokens(row.totalTokens),
    row.totalCost === null ? 'n/a' : formatCost(row.totalCost),
    count(row.toolCalls),
    count(row.linesAdded),
    count(row.linesRemoved),
    row.topTool ?? NO_VALUE,
  ];
}

export const ACTIVE_SESSIONS_FOOTNOTE =
  '"Active" means most recent activity inside the selected range — transcripts are uploaded after the fact, so there is no live-session concept. Every figure covers the session plus all of its descendant sub-agents, so a session whose work was done by agents does not read as empty. A cost of n/a means no model in that session tree has a pricing row; it is not $0.00.';

// --- Claude Code version usage ------------------------------------------------------------

export const CLAUDE_VERSION_USAGE_COLUMNS = [
  'User',
  'Sessions checked',
  'Outdated sessions',
];

export const CLAUDE_VERSION_USAGE_FOOTNOTE = [
  'Outdated = session version below the stable release that was current when the session started.',
  'Sessions checked = root sessions in range with a known version and known reference versions; users with none are not listed.',
  'Rows with outdated sessions > 0 are red and sort first, then by email.',
].join(' ');

export function buildClaudeVersionUsageRow(
  row: ClaudeVersionUsageRow,
): string[] {
  return [
    row.userEmail,
    count(row.sessionsChecked),
    count(row.outdatedSessions),
  ];
}
