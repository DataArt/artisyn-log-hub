import { useMemo } from 'react';
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { formatCost } from '@/lib/format';
import { fetchRepositoryBranches } from '../../../api';
import { BranchCostChart } from './BranchCostChart';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportKpiTable } from './ReportKpiTable';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { BarChartPdf } from './pdf/BarChartPdf';
import { pdfStyles } from './pdf/pdfStyles';
import {
  formatGeneratedAt,
  formatPeriodLabel,
  formatReportDuration,
} from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

export function CostByBranchReport({
  repoId,
  teamId,
  params,
  generation,
}: Props) {
  const { startDate, endDate } = toIsoDateBounds(
    params.startDate,
    params.endDate,
  );
  const { repoUrl, teamName } = useReportHeaderMeta(repoId, teamId);

  const query = useQuery({
    queryKey: [
      'report-cost-by-branch',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      generation,
    ],
    queryFn: () =>
      fetchRepositoryBranches(repoId, teamId, { startDate, endDate }),
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    return params.branches.length > 0
      ? all.filter(
          (r) => r.branch != null && params.branches.includes(r.branch),
        )
      : all;
  }, [query.data, params.branches]);

  const totalSessions = rows.reduce((sum, r) => sum + r.sessionCount, 0);
  const totalWorkTimeMs = rows.reduce((sum, r) => sum + r.totalWorkTimeMs, 0);
  const hasCost = rows.some((r) => r.totalCost != null);
  const totalCost = hasCost
    ? rows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0)
    : null;

  const chartData = [...rows]
    .map((r) => ({ label: r.branch ?? 'no branch', value: r.totalCost ?? 0 }))
    .sort((a, b) => b.value - a.value);

  const { downloadError, handleDownload } = useReportPdfDownload(
    () =>
      PdfDocumentShell({
        title: 'Cost by Branch',
        repoUrl,
        teamName,
        periodLabel: formatPeriodLabel(params.startDate, params.endDate),
        generatedAt: formatGeneratedAt(),
        kpiRows: [
          { label: 'Total Sessions', value: String(totalSessions) },
          {
            label: 'Total Work Time',
            value: formatReportDuration(totalWorkTimeMs),
          },
          { label: 'Total Cost', value: formatCost(totalCost) },
        ],
        children: (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Cost per Branch</Text>
            <BarChartPdf
              data={chartData}
              color="#fcd34d"
              formatValue={(v) => (v % 1 === 0 ? `$${v}` : `$${v.toFixed(2)}`)}
            />
          </View>
        ),
      }),
    `cost-by-branch_${params.startDate}_${params.endDate}.pdf`,
  );

  return (
    <ReportDocumentShell
      isLoading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      canDownload={query.data != null && !query.isFetching && !query.error}
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
    >
      <ReportDocumentHeader
        title="Cost by Branch"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      <ReportKpiTable
        rows={[
          { label: 'Total Sessions', value: String(totalSessions) },
          {
            label: 'Total Work Time',
            value: formatReportDuration(totalWorkTimeMs),
          },
          {
            label: 'Total Cost',
            value: formatCost(totalCost),
            emphasize: true,
          },
        ]}
      />
      <section>
        <h2 className="text-sm font-semibold text-foreground">
          Cost per Branch
        </h2>
        <BranchCostChart branches={rows} />
      </section>
    </ReportDocumentShell>
  );
}
