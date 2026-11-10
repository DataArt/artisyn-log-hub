/**
 * Reports › Budget (2026-11-05 budgets-threshold-alerts, DD-19, wireframe `budget-report.svg`):
 * for every budget of the repository, each budget period overlapping the date range — the current
 * one with its forecast, past ones with spend and percent — plus the top slices over those
 * periods. With no budget it says so and lists the monthly spend. Fed by
 * `GET …/reports/budget`, which reads the same spend as the Spend tab.
 *
 * The on-page tables and the PDF tables come from the same `budget-report-rows.ts` builders.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Text, View } from '@react-pdf/renderer';
import { cn } from '@/lib/cn';
import type { BudgetReport as BudgetReportData } from '../../../../models/budgets';
import { fetchBudgetReport } from '../../../api';
import { browserTimeZone } from '../../budgets/budget-format';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import {
  BUDGET_PERIOD_COLUMNS,
  BUDGET_SLICE_COLUMNS,
  buildBudgetPeriodRows,
  buildBudgetSliceSections,
  buildNoBudgetRows,
  NO_BUDGET_COLUMNS,
} from './budget-report-rows';

const TITLE = 'Budget';
const NO_BUDGET_NOTE =
  'This repository has no budget. Set one in Settings › Budgets; the monthly spend is listed below.';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

function buildPdf(
  data: BudgetReportData,
  tz: string,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
) {
  return PdfDocumentShell({
    title: TITLE,
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    kpiRows: [],
    children: (
      <>
        {data.budgets.map(({ budget, periods, topSlices }) => (
          <View key={budget.id} style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>{budget.label}</Text>
            <Text style={pdfStyles.sectionSubtitle}>
              Periods in {budget.timeZone}, newest first
            </Text>
            <TablePdf
              columns={BUDGET_PERIOD_COLUMNS}
              rows={buildBudgetPeriodRows(budget, periods).map((r) => r.cells)}
            />
            {buildBudgetSliceSections(topSlices).map((s) => (
              <View key={s.title}>
                <Text style={pdfStyles.sectionSubtitle}>{s.title}</Text>
                <TablePdf columns={BUDGET_SLICE_COLUMNS} rows={s.rows} />
              </View>
            ))}
          </View>
        ))}
        {data.noBudgetPeriods !== null && (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.meta}>{NO_BUDGET_NOTE}</Text>
            <TablePdf
              columns={NO_BUDGET_COLUMNS}
              rows={buildNoBudgetRows(data.noBudgetPeriods, tz)}
            />
          </View>
        )}
      </>
    ),
  });
}

function PlainTable({
  columns,
  rows,
  testIds,
  rowClassName,
}: {
  columns: string[];
  rows: string[][];
  /** Column index → `data-testid` of that cell. */
  testIds?: Record<number, string>;
  rowClassName?: (index: number) => string | undefined;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40">
            {columns.map((c, i) => (
              <th
                key={c}
                className={cn(
                  'px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                  i === 0 ? 'text-left' : 'text-right',
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={`${row[0]}-${ri}`}
              className={cn('border-b border-border', rowClassName?.(ri))}
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  data-testid={testIds?.[ci]}
                  className={cn(
                    'px-2 py-1.5 tabular-nums',
                    ci === 0 ? 'text-left' : 'text-right',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BudgetReport({ repoId, teamId, params, generation }: Props) {
  const { startDate, endDate } = toIsoDateBounds(
    params.startDate,
    params.endDate,
  );
  const tz = useMemo(() => browserTimeZone(), []);
  const { repoUrl, teamName } = useReportHeaderMeta(repoId, teamId);

  const query = useQuery({
    queryKey: [
      'report-budget',
      repoId,
      teamId ?? null,
      startDate,
      endDate,
      tz,
      generation,
    ],
    queryFn: () =>
      fetchBudgetReport(repoId, { teamId, startDate, endDate, tz }),
  });
  const data = query.data;

  const { downloadError, handleDownload } = useReportPdfDownload(() => {
    if (!data) throw new Error('The report is not loaded yet');
    return buildPdf(data, tz, repoUrl, teamName, params);
  }, `budget_${params.startDate}_${params.endDate}.pdf`);

  return (
    <ReportDocumentShell
      isLoading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      canDownload={data != null && !query.isFetching && !query.error}
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
      maxWidthClassName="max-w-[884px]"
    >
      <ReportDocumentHeader
        title={TITLE}
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {data?.budgets.map(({ budget, periods, topSlices }) => {
        const periodRows = buildBudgetPeriodRows(budget, periods);
        return (
          <section
            key={budget.id}
            className="mb-8"
            data-testid={`report-budget-${budget.period}`}
          >
            <h2 className="text-sm font-semibold text-foreground">
              {budget.label}
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Periods in {budget.timeZone}, newest first. Log Hub does not stop
              usage when the budget is reached.
            </p>
            {periodRows.length > 0 ? (
              <PlainTable
                columns={BUDGET_PERIOD_COLUMNS}
                rows={periodRows.map((r) => r.cells)}
                testIds={{
                  1: 'report-budget-spend',
                  2: 'report-budget-percent',
                }}
                rowClassName={(i) =>
                  periodRows[i].overspendRisk
                    ? 'bg-amber-50/60'
                    : periodRows[i].isCurrent
                      ? 'font-medium'
                      : undefined
                }
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No budget period overlaps this date range.
              </p>
            )}
            {buildBudgetSliceSections(topSlices).map((s) => (
              <div key={s.title} className="mt-4">
                <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
                  {s.title}
                </h3>
                <PlainTable columns={BUDGET_SLICE_COLUMNS} rows={s.rows} />
              </div>
            ))}
          </section>
        );
      })}
      {data?.noBudgetPeriods != null && (
        <section className="mb-6" data-testid="report-budget-none">
          <p className="mb-2 text-sm text-muted-foreground">{NO_BUDGET_NOTE}</p>
          <PlainTable
            columns={NO_BUDGET_COLUMNS}
            rows={buildNoBudgetRows(data.noBudgetPeriods, tz)}
            testIds={{ 1: 'report-budget-spend' }}
          />
        </section>
      )}
    </ReportDocumentShell>
  );
}
