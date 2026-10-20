/**
 * Row builders shared by the on-page "Cache Read Ratio" report document and its
 * PDF export. `ReportKpiRow` and `PdfKpiRow` are structurally identical
 * for the fields used here, so one builder feeds both shells and the two
 * renderings can never drift apart.
 */
import { formatCacheReadRatio, formatCost } from '@/lib/format';
import type {
  CacheRatioCauses,
  CacheRatioGroup,
  CacheRatioScopeTotals,
  CacheReadRatioReportData,
} from '../../../../models/repositories';
import type { ReportKpiRow } from './ReportKpiTable';

export const CACHE_RATIO_VALUE_HEADERS: [string, string] = [
  'Root only',
  'Root + descendants',
];

function tokens(n: number): string {
  return n.toLocaleString();
}

function pair(
  label: string,
  pick: (t: CacheRatioScopeTotals) => string,
  data: CacheReadRatioReportData,
  extra?: Partial<ReportKpiRow>,
): ReportKpiRow {
  return {
    label,
    value: pick(data.root),
    secondValue: pick(data.withDescendants),
    ...extra,
  };
}

// KPI rows in the order fixed by the plan's Visual/UX notes.
export function buildCacheRatioKpiRows(
  data: CacheReadRatioReportData,
): ReportKpiRow[] {
  return [
    pair('Sessions in scope', (t) => tokens(t.sessionCount), data),
    pair('Cache read tokens', (t) => tokens(t.cacheReadTokens), data),
    pair('Cache write tokens (total)', (t) => tokens(t.cacheWriteTokens), data),
    pair('5m TTL', (t) => tokens(t.cacheWrite5mTokens), data, { indent: true }),
    pair('1h TTL', (t) => tokens(t.cacheWrite1hTokens), data, { indent: true }),
    pair('Cache read ratio', (t) => formatCacheReadRatio(t.ratio), data, {
      emphasize: true,
    }),
    pair('Cache read cost', (t) => formatCost(t.cacheReadCost), data),
    pair('Cache write cost', (t) => formatCost(t.cacheWriteCost), data),
    pair(
      'Sessions with undefined ratio (excluded)',
      (t) => tokens(t.undefinedRatioSessionCount),
      data,
    ),
  ];
}

export interface CauseTableRow {
  cause: string;
  turns: string;
  creationTokens: string;
  share: string;
  /** Muted rendering — the "Unattributed" bucket is a residual, not a finding. */
  muted?: boolean;
  /** The bold roll-up row. */
  total?: boolean;
}

export function buildCacheRatioCauseRows(
  causes: CacheRatioCauses,
): CauseTableRow[] {
  const share = (v: number) => `${(v * 100).toFixed(1)}%`;
  const totalTurns =
    causes.compaction.turns +
    causes.fileReread.turns +
    causes.unattributed.turns;
  return [
    {
      cause: 'Compaction',
      turns: causes.compaction.turns.toLocaleString(),
      creationTokens: tokens(causes.compaction.creationTokens),
      share: share(causes.compaction.share),
    },
    {
      cause: 'File re-reads',
      turns: causes.fileReread.turns.toLocaleString(),
      creationTokens: tokens(causes.fileReread.creationTokens),
      share: share(causes.fileReread.share),
    },
    {
      cause: 'Unattributed',
      turns: causes.unattributed.turns.toLocaleString(),
      creationTokens: tokens(causes.unattributed.creationTokens),
      share: share(causes.unattributed.share),
      muted: true,
    },
    {
      cause: 'Total',
      turns: totalTurns.toLocaleString(),
      creationTokens: tokens(causes.totalCreationTokens),
      share: causes.totalCreationTokens > 0 ? '100.0%' : '0.0%',
      total: true,
    },
  ];
}

const THRESHOLD_SOURCE_LABEL: Record<
  CacheRatioCauses['thresholdSource'],
  string
> = {
  user: 'your personal override',
  team: 'the team configuration',
  default: 'the built-in default',
};

// Footnote under the cause table: the roll-up scope (root-only),
// the threshold in force and where it came from, plus the
// stale/missing session counts when either is non-zero.
export function buildCacheRatioCauseFootnote(causes: CacheRatioCauses): string {
  const parts = [
    'Root sessions only — sub-agent sessions are not decomposed.',
    `Turns creating at least ${causes.thresholdTokens.toLocaleString()} cache tokens are attributed to a cause; threshold from ${THRESHOLD_SOURCE_LABEL[causes.thresholdSource]}.`,
  ];
  if (causes.staleSessionCount > 0) {
    parts.push(
      `${causes.staleSessionCount.toLocaleString()} session(s) were last computed with a different threshold and may be stale.`,
    );
  }
  if (causes.sessionsWithoutCauseData > 0) {
    parts.push(
      `${causes.sessionsWithoutCauseData.toLocaleString()} session(s) have no cause data for this scope.`,
    );
  }
  return parts.join(' ');
}

export const CACHE_RATIO_GROUP_COLUMNS = [
  'Group',
  'Sessions',
  'Root ratio',
  'Root + desc. ratio',
  'Cache read (root)',
  'Cache write (root)',
];

export function buildCacheRatioGroupRow(g: CacheRatioGroup): string[] {
  return [
    g.group,
    tokens(g.root.sessionCount),
    formatCacheReadRatio(g.root.ratio),
    formatCacheReadRatio(g.withDescendants.ratio),
    tokens(g.root.cacheReadTokens),
    tokens(g.root.cacheWriteTokens),
  ];
}
