/**
 * Row/KPI builders shared by the on-page "Attribution Usage" report document and its PDF
 * export — same arrangement as `cache-read-ratio-rows.ts` /
 * `attribution-breakdown-rows.ts`, so the two renderings can never drift apart.
 */
import { formatCost } from '@/lib/format';
import type {
  AttributionUsageOutcomeRow,
  AttributionUsageReportData,
  AttributionUsageTopSession,
  SessionAttributionRunOutcome,
} from '../../../../models/repositories';
import type { ReportKpiRow } from './ReportKpiTable';

/** Mirrors `ATTRIBUTION_USAGE_OUTCOMES` (`attribution-usage.service.ts`) — the fixed 3-outcome
 * order every outcome breakdown/filter control renders in. */
export const ATTRIBUTION_USAGE_OUTCOMES: readonly SessionAttributionRunOutcome[] =
  ['applied', 'ignored_stale', 'failed'];

export const ATTRIBUTION_USAGE_OUTCOME_LABELS: Record<
  SessionAttributionRunOutcome,
  string
> = {
  applied: 'Applied',
  ignored_stale: 'Ignored (stale)',
  failed: 'Failed',
};

export const ATTRIBUTION_USAGE_OUTCOME_COLUMNS = ['Outcome', 'Runs', 'Cost'];
export const ATTRIBUTION_USAGE_TOP_COLUMNS = ['Session', 'Evaluations', 'Cost'];

export function buildAttributionUsageKpiRows(
  data: AttributionUsageReportData,
): ReportKpiRow[] {
  return [
    {
      label: 'Evaluation attempts',
      value: data.evaluationCount.toLocaleString(),
    },
    {
      label: 'Distinct sessions evaluated',
      value: data.distinctSessionCount.toLocaleString(),
    },
    {
      label: 'Total cost',
      value: formatCost(data.totalCostUsd),
      emphasize: true,
    },
    { label: 'Avg cost per evaluation', value: formatCost(data.avgCostUsd) },
  ];
}

export function buildAttributionUsageOutcomeRow(
  row: AttributionUsageOutcomeRow,
): string[] {
  return [
    ATTRIBUTION_USAGE_OUTCOME_LABELS[row.outcome] ?? row.outcome,
    row.count.toLocaleString(),
    formatCost(row.costUsd),
  ];
}

export function buildAttributionUsageTopRow(
  row: AttributionUsageTopSession,
): string[] {
  return [
    row.sessionId,
    row.evaluationCount.toLocaleString(),
    formatCost(row.costUsd),
  ];
}
