/**
 * Row/KPI builders shared by the on-page "Attribution Breakdown" report document and its PDF
 * export — same arrangement as `cache-read-ratio-rows.ts`, so the two
 * renderings can never drift apart.
 */
import { formatCost } from '@/lib/format';
import type {
  AttributionBreakdownReportData,
  AttributionBreakdownRow,
} from '../../../../models/repositories';
import type { ReportKpiRow } from './ReportKpiTable';

export const ATTRIBUTION_BREAKDOWN_SECTION_COLUMNS = [
  'Value',
  'Sessions',
  'Share',
  'Cost',
];

/** The 3 fixed residual labels every section layout may carry — never
 * ranked, always muted in the table so the "real" values stand out. */
const MUTED_ROW_VALUES = new Set(['Other', 'Not determined', 'Unattributed']);

export function isMutedBreakdownRow(row: AttributionBreakdownRow): boolean {
  return MUTED_ROW_VALUES.has(row.value);
}

export function formatBreakdownShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function buildAttributionBreakdownSectionRow(
  row: AttributionBreakdownRow,
): string[] {
  return [
    row.value,
    row.sessionCount.toLocaleString(),
    formatBreakdownShare(row.share),
    formatCost(row.costUsd),
  ];
}

export function buildAttributionBreakdownKpiRows(
  data: AttributionBreakdownReportData,
): ReportKpiRow[] {
  return [
    {
      label: 'Sessions in scope',
      value: data.totalSessionCount.toLocaleString(),
    },
    {
      label: 'Total cost',
      value: formatCost(data.totalCostUsd),
      emphasize: true,
    },
    {
      label: 'Sessions with an orphaned attribute value',
      value: data.orphanedSessionCount.toLocaleString(),
    },
  ];
}
