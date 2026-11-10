/**
 * Row builders of Reports › Budget (2026-11-05 budgets-threshold-alerts, DD-19, wireframe
 * `budget-report.svg`). The on-page tables and the PDF tables are built from the same rows, so
 * the document and its export cannot drift. A pure module: no React imports.
 */
import type {
  BudgetDto,
  BudgetReport,
  BudgetReportPeriod,
  SpendSlice,
} from '../../../../models/budgets';
import { formatUsdMicros } from '../../budgets/budget-format';
import {
  formatPercent,
  formatSpendBucketKey,
  formatSpendPeriodLabel,
  SLICE_NOT_REPORTED_KEY,
  SPEND_SLICE_LABELS,
} from '../../spend/spend-format';

export const BUDGET_PERIOD_COLUMNS = [
  'Period',
  'Spend',
  '% of budget',
  'Forecast',
  'Thresholds crossed',
  'Anomaly days',
];

export const BUDGET_SLICE_COLUMNS = ['Column', 'Sessions', 'Cost', 'Share'];

export const NO_BUDGET_COLUMNS = ['Month', 'Spend'];

/** How many top slice kinds the report prints per budget. */
const REPORT_SLICE_KINDS = ['model', 'user', 'branch', 'subagent'] as const;

export interface BudgetPeriodRow {
  cells: string[];
  isCurrent: boolean;
  overspendRisk: boolean;
}

function forecastCell(p: BudgetReportPeriod, budget: BudgetDto): string {
  if (!p.isCurrent || p.forecast === null) return '—';
  const pct =
    budget.amountMicros > 0
      ? ` (${formatPercent((p.forecast.forecastMicros / budget.amountMicros) * 100)})`
      : '';
  const risk = p.forecast.overspendRisk ? ' ⚠' : '';
  return `${formatUsdMicros(p.forecast.forecastMicros)}${pct}${risk}`;
}

export function buildBudgetPeriodRows(
  budget: BudgetDto,
  periods: readonly BudgetReportPeriod[],
): BudgetPeriodRow[] {
  return periods.map((p) => {
    const label = formatSpendPeriodLabel(
      budget.period,
      p.start,
      p.end,
      budget.timeZone,
    );
    return {
      isCurrent: p.isCurrent,
      overspendRisk: p.forecast?.overspendRisk === true,
      cells: [
        p.isCurrent ? `${label} (current)` : label,
        formatUsdMicros(p.spendMicros),
        formatPercent(p.percentUsed),
        forecastCell(p, budget),
        p.crossedThresholds.length > 0
          ? p.crossedThresholds.map((t) => `${t} %`).join(', ')
          : '—',
        p.anomalyDays.length > 0
          ? p.anomalyDays.map(formatSpendBucketKey).join(', ')
          : '—',
      ],
    };
  });
}

export interface BudgetSliceSection {
  title: string;
  rows: string[][];
}

/** The top rows of a few slice kinds, `Not reported` last (the server order). */
export function buildBudgetSliceSections(
  slices: readonly SpendSlice[],
): BudgetSliceSection[] {
  const out: BudgetSliceSection[] = [];
  for (const kind of REPORT_SLICE_KINDS) {
    const slice = slices.find((s) => s.kind === kind);
    if (!slice || slice.rows.length === 0) continue;
    out.push({
      title: `Top by ${SPEND_SLICE_LABELS[kind].toLowerCase()}`,
      rows: slice.rows.map((r) => [
        r.key === SLICE_NOT_REPORTED_KEY ? 'Not reported' : r.label,
        String(r.sessions),
        formatUsdMicros(r.micros),
        formatPercent(r.share * 100),
      ]),
    });
  }
  return out;
}

export function buildNoBudgetRows(
  periods: NonNullable<BudgetReport['noBudgetPeriods']>,
  timeZone: string,
): string[][] {
  return periods.map((p) => [
    formatSpendPeriodLabel('month', p.start, p.end, timeZone),
    formatUsdMicros(p.spendMicros),
  ]);
}
