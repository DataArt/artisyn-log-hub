/**
 * Row builders shared by the on-page "Change Surface" report document and its PDF export.
 *
 * Pure and framework-free, exactly like `cache-read-ratio-rows.ts` / `harness-usage-rows.ts`:
 * `ReportKpiRow` and `PdfKpiRow` are structurally identical for the fields used here, so one
 * builder feeds both shells and the screen and the print layout can never drift apart.
 *
 * Two invariants this module exists to enforce:
 *
 * - An absent value is never rendered as `0`. `concentration`, `filesPerFolder` and friends
 *   come back `null` from the server when the scope changed nothing, and both `%` indicators
 *   come back `null` when no `repo_code_inventory` snapshot covers the period — those render
 *   `n/a` and `n/a · denominator unavailable` respectively, never `0` / `0%`.
 * - No band is re-derived here. `band` arrives alongside `concentration` from the server
 *   (`lib/change-surface-ui.ts` documents that rule); this module only formats.
 */
import {
  CHANGE_SURFACE_NA,
  formatConcentration,
  formatSurfaceCount,
  formatSurfaceDecimal,
  formatSurfaceShare,
} from '@/lib/change-surface-ui';
import type {
  ChangeSurfaceAggregate,
  ChangeSurfaceInventory,
  ChangeSurfaceMedians,
  ChangeSurfaceReportData,
} from '../../../../models/repositories';
import type { ReportKpiRow } from './ReportKpiTable';
import type { ReportParamsState } from './report-url';

/**
 * The KPI table's two value columns. The second is the exact per-session **lower** median
 * over the sessions that actually changed something — no `≈` prefix,
 * unlike the bucket-interpolated repository medians elsewhere in the app.
 */
export const CHANGE_SURFACE_VALUE_HEADERS: [string, string] = [
  'Value',
  'Per session (median)',
];

/** `'1,284 / 8,912'`-style numerator/denominator caption for a `%` indicator. */
function ratioText(numerator: number, denominator: number): string {
  return `${numerator.toLocaleString()} / ${denominator.toLocaleString()}`;
}

/**
 * The repo-level single-file-folder share. The server sends the count, not the share, for a
 * scope aggregate (only the medians carry a ready-made share), so it is derived here —
 * `null`, never `0`, when no folder was touched at all.
 */
export function singleFileFolderShare(
  aggregate: ChangeSurfaceAggregate,
): number | null {
  if (aggregate.foldersTouched === 0) return null;
  return aggregate.singleFileFolders / aggregate.foldersTouched;
}

function medianCell(
  medians: ChangeSurfaceMedians | null,
  pick: (m: ChangeSurfaceMedians) => string,
): string {
  return medians === null ? CHANGE_SURFACE_NA : pick(medians);
}

/**
 * The seven metric rows, in the order fixed by `report-change-surface.svg`. `repo` is the
 * union over the whole period (never a sum of sessions); the second column is the typical
 * single session.
 */
export function buildChangeSurfaceKpiRows(
  data: ChangeSurfaceReportData,
): ReportKpiRow[] {
  const { repo, perSessionMedian: medians } = data;
  return [
    {
      label: 'Changed files (distinct paths in period)',
      value: formatSurfaceCount(repo.changedFiles),
      secondValue: medianCell(medians, (m) =>
        formatSurfaceCount(m.changedFiles),
      ),
    },
    {
      label: 'Folders touched (distinct)',
      value: formatSurfaceCount(repo.foldersTouched),
      secondValue: medianCell(medians, (m) =>
        formatSurfaceCount(m.foldersTouched),
      ),
    },
    {
      label: 'Concentration (headline spread measure)',
      value: formatConcentration(repo.concentration),
      secondValue: medianCell(medians, (m) =>
        formatConcentration(m.concentration),
      ),
      emphasize: true,
    },
    {
      label: 'Files per folder',
      value: formatSurfaceDecimal(repo.filesPerFolder),
      secondValue: medianCell(medians, (m) =>
        formatSurfaceDecimal(m.filesPerFolder),
      ),
    },
    {
      label: 'Top-level modules touched',
      value: formatSurfaceCount(repo.topLevelModules.length),
      secondValue: medianCell(medians, (m) =>
        formatSurfaceCount(m.topLevelModules),
      ),
    },
    {
      label: 'Folder-distribution entropy (normalised)',
      value: formatSurfaceDecimal(repo.folderEntropyNorm, 2),
      secondValue: medianCell(medians, (m) =>
        formatSurfaceDecimal(m.folderEntropyNorm, 2),
      ),
    },
    {
      label: 'Single-file folders (share of folders)',
      value: formatSurfaceShare(singleFileFolderShare(repo)),
      secondValue: medianCell(medians, (m) =>
        formatSurfaceShare(m.singleFileFolderShare),
      ),
    },
  ];
}

/** What an unavailable denominator reads as — never `0%`. */
export const DENOMINATOR_UNAVAILABLE = `${CHANGE_SURFACE_NA} · denominator unavailable`;

/** `14.4%` at one decimal; `null` → the explicit unavailable text. */
export function formatTrackedShare(share: number | null): string {
  return share === null
    ? DENOMINATOR_UNAVAILABLE
    : `${(share * 100).toFixed(1)}%`;
}

/**
 * One of the two `%`-of-codebase indicators. They are deliberately separate rows rather than
 * one blended "impact" number: files and lines are different denominators answering different
 * questions, and the report names both.
 */
export interface ChangeSurfaceShareRow {
  label: string;
  /** `'1,284 / 8,912'`, or `null` when there is no snapshot to divide by. */
  ratio: string | null;
  /** `'14.4%'`, or `DENOMINATOR_UNAVAILABLE`. */
  value: string;
  /** `false` → the row is muted and carries no percentage at all. */
  available: boolean;
}

export function buildChangeSurfaceShareRows(
  data: ChangeSurfaceReportData,
): [ChangeSurfaceShareRow, ChangeSurfaceShareRow] {
  const { inventory, repo } = data;
  return [
    {
      label: 'Change surface as % of tracked files',
      ratio:
        inventory === null || data.shareOfTrackedFiles === null
          ? null
          : ratioText(repo.changedFiles, inventory.trackedFiles),
      value: formatTrackedShare(data.shareOfTrackedFiles),
      available: data.shareOfTrackedFiles !== null,
    },
    {
      label: 'Lines changed as % of tracked lines',
      ratio:
        inventory === null || data.shareOfTrackedLines === null
          ? null
          : ratioText(repo.linesAdded, inventory.trackedLines),
      value: formatTrackedShare(data.shareOfTrackedLines),
      available: data.shareOfTrackedLines !== null,
    },
  ];
}

function formatInventoryTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(parsed);
}

/**
 * The sentence printed under the two indicators: which snapshot supplied the denominator,
 * from which branch, and when it was captured — so a `%` can always be traced to a concrete
 * inventory rather than read as a timeless property of the repo.
 */
export function buildInventoryCaption(
  inventory: ChangeSurfaceInventory | null,
): string {
  if (inventory === null) {
    return (
      'This repository has never reported a tracked-file inventory, so neither indicator ' +
      `has a denominator — both read "${DENOMINATOR_UNAVAILABLE}" rather than 0%.`
    );
  }
  const branch = inventory.branch ?? 'an unnamed branch';
  return (
    `Denominator: tracked-file / tracked-line inventory reported by the hook for ${branch} ` +
    `at ${formatInventoryTimestamp(inventory.capturedAt)} UTC — ` +
    `${inventory.trackedFiles.toLocaleString()} files · ` +
    `${inventory.trackedLines.toLocaleString()} lines · ` +
    `${inventory.trackedBinaryFiles.toLocaleString()} binary (git-tracked only).`
  );
}

/**
 * The group-overlap caveat, printed inline under the grouped table. Group rows are each recomputed from the
 * union of that group's own changed paths, so they overlap and cannot add up — the report
 * says so rather than letting a reader infer additivity from a column of numbers.
 */
export const CHANGE_SURFACE_GROUP_CAVEAT =
  'Group rows do not sum to the repo-level row: file and folder sets overlap between ' +
  "groups, so each row is recomputed from the union of that group's changed paths.";

/** First column header follows the active grouping; the rest are fixed. */
export function changeSurfaceGroupColumns(
  groupBy: ReportParamsState['groupBy'],
): string[] {
  const first =
    groupBy === 'user'
      ? 'User'
      : groupBy.startsWith('attr:')
        ? groupBy.slice('attr:'.length)
        : 'Branch';
  return [
    first,
    'Sessions',
    'Files',
    'Folders',
    'Concentration',
    '% tracked files',
  ];
}

export type ChangeSurfaceReportGroup = NonNullable<
  ChangeSurfaceReportData['groups']
>[number];

export function buildChangeSurfaceGroupRow(
  group: ChangeSurfaceReportGroup,
): string[] {
  return [
    group.label,
    group.sessions.toLocaleString(),
    formatSurfaceCount(group.aggregate.changedFiles),
    formatSurfaceCount(group.aggregate.foldersTouched),
    formatConcentration(group.aggregate.concentration),
    formatTrackedShare(group.shareOfTrackedFiles),
  ];
}

/** One point of the "Concentration per week" series. */
export interface ConcentrationWeekPoint {
  /** `'Aug 18'` — the week's UTC start day. */
  label: string;
  sessions: number;
  /** `null` → no bar at all (Recharts skips it); never a misleading `0`. */
  concentration: number | null;
}

function formatWeekLabel(bucketStart: string): string {
  const parsed = new Date(bucketStart);
  if (isNaN(parsed.getTime())) return bucketStart;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export function buildConcentrationWeeks(
  buckets: ChangeSurfaceReportData['buckets'],
): ConcentrationWeekPoint[] {
  return buckets.map((bucket) => ({
    label: formatWeekLabel(bucket.bucketStart),
    sessions: bucket.sessions,
    concentration: bucket.concentration,
  }));
}

export const CHANGE_SURFACE_WEEK_COLUMNS = [
  'Week of',
  'Sessions',
  'Concentration',
];

/** The print-layout counterpart of the on-page weekly chart. */
export function buildConcentrationWeekRows(
  buckets: ChangeSurfaceReportData['buckets'],
): string[][] {
  return buildConcentrationWeeks(buckets).map((week) => [
    week.label,
    week.sessions.toLocaleString(),
    formatConcentration(week.concentration),
  ]);
}
