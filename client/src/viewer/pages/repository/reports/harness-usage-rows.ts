/**
 * Pure row/format/sort/filter helpers for the "Harness Usage" report.
 * Kept side-effect free and framework-free so they're directly unit-testable
 * and reusable between the on-page table
 * and the PDF export.
 */
import type {
  HarnessElementKind,
  HarnessUsageRow,
} from '../../../../models/harness-usage';
import { formatReportDate } from './report-format';

export type HarnessKindFilter = 'all' | HarnessElementKind;

export const HARNESS_KIND_ORDER: HarnessElementKind[] = [
  'skill',
  'rule',
  'mcp',
  'tool',
];

export const HARNESS_KIND_LABELS: Record<HarnessElementKind, string> = {
  skill: 'Skill',
  rule: 'Rule',
  mcp: 'MCP',
  tool: 'Tool',
};

// Badge colour classes per kind, matching the wireframe's
// skill=violet / rule=amber / mcp=teal / tool=blue palette.
export const HARNESS_KIND_BADGE_CLASSNAMES: Record<HarnessElementKind, string> =
  {
    skill:
      'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
    rule: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    mcp: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    tool: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  };

export type HarnessSortKey =
  | 'kind'
  | 'name'
  | 'uses'
  | 'inputTokens'
  | 'outputTokens'
  | 'countPct'
  | 'tokenPct';

export interface HarnessKindChip {
  kind: HarnessKindFilter;
  label: string;
  count: number;
}

/** One row's total tokens — the sort/format helpers' shared derived value. */
export function rowTokens(row: HarnessUsageRow): number {
  return row.inputTokens + row.outputTokens;
}

// --- Formatting --------------------------------------------------------------------------
//
// Three distinct cell states the report must never conflate: a real zero ('0'), a real percentage ('N%', including '0%' for a kind with a
// zero slice total), and "not applicable/not reported" ('–', schema size only).

export function formatHarnessCount(n: number): string {
  return n.toLocaleString();
}

export function formatHarnessPercent(pct: number): string {
  return `${Math.round(pct)}%`;
}

/** '–' unless `schemaSizeReported` — never renders `0`/`null` in its place. */
export function formatSchemaSize(row: HarnessUsageRow): string {
  if (!row.schemaSizeReported || row.schemaSizeTokens === null) return '–';
  return `${row.schemaSizeTokens.toLocaleString()} tok`;
}

/**
 * An MCP server itself is never "used" — only the tools it exposes are (its row is a pure
 * grouping/"folder" for those tools, per its own KPI/percentage exclusion elsewhere in this
 * report). Its Uses/Input tokens/Output tokens/Uses %/Tokens % cells render '–' instead of
 * the rolled-up child total (the rollup is still computed — for sort order
 * and for the MCP-kind percentage denominator — this only changes what's *displayed*).
 */
export function formatHarnessMcpCell(
  row: HarnessUsageRow,
  formatted: string,
): string {
  return row.kind === 'mcp' ? '–' : formatted;
}

/** First-seen/last-seen caption — only meaningful for a removed/renamed element. */
export function formatSeenCaption(row: HarnessUsageRow): string | null {
  if (row.firstSeen === null && row.lastSeen === null) return null;
  const first = row.firstSeen ? formatReportDate(row.firstSeen) : 'unknown';
  const last = row.lastSeen ? formatReportDate(row.lastSeen) : 'unknown';
  return `First seen ${first} · Last seen ${last}`;
}

// --- Project-skills-only filter -----------------------------------------------------------

/**
 * When enabled, drops `skill`-kind rows whose `source` isn't `'project'` — hides plugin
 * skills and, deliberately, skills an older hook never tagged with a `source` at all (an
 * unconfirmed source doesn't count as "project"). Every other kind is untouched.
 */
export function filterProjectSkillsOnly(
  rows: readonly HarnessUsageRow[],
  enabled: boolean,
): HarnessUsageRow[] {
  if (!enabled) return [...rows];
  return rows.filter((r) => r.kind !== 'skill' || r.source === 'project');
}

// --- Kind filter chips ---------------------------------------------------------------------

/**
 * Chip counts over the given row set — every row counts by its own `kind`, EXCEPT a
 * `tool`-kind row sourced from an MCP server: it's only ever reachable by expanding its
 * parent MCP row now (the "Tool" section is built-in tools only), so it doesn't count
 * towards the `tool` chip either. The `all` chip still counts every row, MCP-sourced tools
 * included, matching the server's `elementCount`.
 */
export function buildHarnessKindChips(
  rows: readonly HarnessUsageRow[],
): HarnessKindChip[] {
  const counts = new Map<HarnessElementKind, number>();
  for (const row of rows) {
    if (isMcpSourcedTool(row)) continue;
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  }
  return [
    { kind: 'all', label: 'All', count: rows.length },
    ...HARNESS_KIND_ORDER.map((kind) => ({
      kind,
      label: HARNESS_KIND_LABELS[kind],
      count: counts.get(kind) ?? 0,
    })),
  ];
}

// --- Sort ------------------------------------------------------------------------------------

function sortValue(row: HarnessUsageRow, key: HarnessSortKey): string | number {
  switch (key) {
    case 'kind':
      return row.kind;
    case 'name':
      return row.name;
    case 'uses':
      return row.uses;
    case 'inputTokens':
      return row.inputTokens;
    case 'outputTokens':
      return row.outputTokens;
    case 'countPct':
      return row.countPct;
    case 'tokenPct':
      return row.tokenPct;
  }
}

export function sortHarnessRows(
  rows: readonly HarnessUsageRow[],
  key: HarnessSortKey,
  desc: boolean,
): HarnessUsageRow[] {
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av < bv) return desc ? 1 : -1;
    if (av > bv) return desc ? -1 : 1;
    // Stable tie-break so re-sorting the same data never visibly reshuffles ties.
    return a.name.localeCompare(b.name);
  });
}

// --- Tree building (MCP expandable child rows) ------------------------------------------

export interface HarnessDisplayRow {
  row: HarnessUsageRow;
  /** 0 = top-level, 1 = nested under an expanded MCP parent. */
  depth: 0 | 1;
  /** Only ever true for a `kind='mcp'` row with at least one child. */
  expandable: boolean;
  expanded: boolean;
}

function isMcpSourcedTool(row: HarnessUsageRow): boolean {
  return row.kind === 'tool' && row.mcpServer !== null;
}

/**
 * Builds the flat display list the table renders: filtered by kind, sorted, with MCP-kind
 * rows' `tool`-kind children nested underneath when expanded.
 *
 * An MCP-sourced `tool` row is ONLY ever reachable by expanding its parent MCP row — the
 * `'tool'` kind filter shows built-in tools alone (a flat list, since "browse built-in
 * tools" is the point there, not "browse MCP servers"). This is deliberate: an MCP server's
 * tool breakdown belongs under that server, never duplicated into a generic Tool section.
 */
export function buildHarnessDisplayRows(
  rows: readonly HarnessUsageRow[],
  kindFilter: HarnessKindFilter,
  sortKey: HarnessSortKey,
  sortDesc: boolean,
  expandedServers: ReadonlySet<string>,
): HarnessDisplayRow[] {
  const childrenByServer = new Map<string, HarnessUsageRow[]>();
  for (const row of rows) {
    if (!isMcpSourcedTool(row) || row.mcpServer === null) continue;
    const list = childrenByServer.get(row.mcpServer) ?? [];
    list.push(row);
    childrenByServer.set(row.mcpServer, list);
  }

  if (kindFilter !== 'all' && kindFilter !== 'mcp') {
    const flat = rows.filter(
      (r) => r.kind === kindFilter && !isMcpSourcedTool(r),
    );
    return sortHarnessRows(flat, sortKey, sortDesc).map((row) => ({
      row,
      depth: 0,
      expandable: false,
      expanded: false,
    }));
  }

  const topLevelSource =
    kindFilter === 'mcp'
      ? rows.filter((r) => r.kind === 'mcp')
      : rows.filter((r) => !isMcpSourcedTool(r));

  const display: HarnessDisplayRow[] = [];
  for (const row of sortHarnessRows(topLevelSource, sortKey, sortDesc)) {
    const children =
      row.kind === 'mcp' ? childrenByServer.get(row.name) : undefined;
    // Expandability follows real children, not the latest self-report's `mcpConnected`
    // flag: a tool call actually made through this server is a historical fact regardless
    // of whether the server happened to be reachable at the moment of the most recent
    // probe (which can itself be wrong or stale — a server the report calls
    // "disconnected" may still have genuine usage-derived child rows, e.g. from a session
    // that ran before the server went down, or before a hook-side probe bug was fixed).
    // Hiding the breakdown in that case would throw away real data for no good reason.
    const expandable = row.kind === 'mcp' && (children?.length ?? 0) > 0;
    const expanded = expandable && expandedServers.has(row.name);
    display.push({ row, depth: 0, expandable, expanded });
    if (expanded && children) {
      for (const child of sortHarnessRows(children, sortKey, sortDesc)) {
        display.push({
          row: child,
          depth: 1,
          expandable: false,
          expanded: false,
        });
      }
    }
  }
  return display;
}

// --- KPI tiles -----------------------------------------------------------------------------

export interface HarnessKpiTile {
  label: string;
  value: string;
}

export function buildHarnessKpiTiles(data: {
  elementCount: number;
  neverUsedCount: number;
  totalUses: number;
  sessionCount: number;
}): HarnessKpiTile[] {
  return [
    { label: 'Harness elements', value: formatHarnessCount(data.elementCount) },
    {
      label: 'Never used (period)',
      value: formatHarnessCount(data.neverUsedCount),
    },
    { label: 'Total uses', value: formatHarnessCount(data.totalUses) },
    {
      label: 'Sessions (period)',
      value: formatHarnessCount(data.sessionCount),
    },
  ];
}

// --- PDF export rows -------------------------------------------------------------------------

export const HARNESS_TABLE_COLUMNS = [
  'Kind',
  'Element',
  'Schema',
  'Uses',
  'Input tokens',
  'Output tokens',
  'Uses %',
  'Tokens %',
];

/** Flattened row list for the PDF table — MCP rows followed immediately by their (indented)
 * children, always expanded, since a printed document has no interactive expand affordance. */
export function buildHarnessPdfRows(
  rows: readonly HarnessUsageRow[],
): string[][] {
  const childrenByServer = new Map<string, HarnessUsageRow[]>();
  for (const row of rows) {
    if (!isMcpSourcedTool(row) || row.mcpServer === null) continue;
    const list = childrenByServer.get(row.mcpServer) ?? [];
    list.push(row);
    childrenByServer.set(row.mcpServer, list);
  }

  const topLevel = sortHarnessRows(
    rows.filter((r) => !isMcpSourcedTool(r)),
    'uses',
    true,
  );

  const toCells = (row: HarnessUsageRow, indent: boolean): string[] => [
    HARNESS_KIND_LABELS[row.kind],
    `${indent ? '↳ ' : ''}${row.name}${row.removed ? ' (removed)' : ''}`,
    formatSchemaSize(row),
    formatHarnessMcpCell(row, formatHarnessCount(row.uses)),
    formatHarnessMcpCell(row, formatHarnessCount(row.inputTokens)),
    formatHarnessMcpCell(row, formatHarnessCount(row.outputTokens)),
    formatHarnessMcpCell(row, formatHarnessPercent(row.countPct)),
    formatHarnessMcpCell(row, formatHarnessPercent(row.tokenPct)),
  ];

  const out: string[][] = [];
  for (const row of topLevel) {
    out.push(toCells(row, false));
    if (row.kind === 'mcp') {
      const children = childrenByServer.get(row.name) ?? [];
      for (const child of sortHarnessRows(children, 'uses', true)) {
        out.push(toCells(child, true));
      }
    }
  }
  return out;
}
