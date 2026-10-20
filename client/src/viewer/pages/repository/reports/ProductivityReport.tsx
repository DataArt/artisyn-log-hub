import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { formatCost } from '@/lib/format';
import { fetchAnalyticsTimeline } from '../../../api';
import { PRODUCTIVITY_METRICS } from '../analytics/metrics';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportKpiTable } from './ReportKpiTable';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { BarChartPdf } from './pdf/BarChartPdf';
import { pdfStyles } from './pdf/pdfStyles';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import { ProductivityByDayChart } from './ProductivityByDayChart';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

const COST_PER_LINE_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'costPerLine',
)!.format;
const LINES_PER_HOUR_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'linesPerHour',
)!.format;

function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Productivity report — cost/line and lines/hour, computed from per-session
// timeline data using the same formulas as analytics/metrics.ts
// (computeProductivityValue), but aggregated per day and rendered with the
// Reports tab's own chart (not analytics' D3 charts).
export function ProductivityReport({
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
      'report-productivity',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      generation,
    ],
    queryFn: () =>
      fetchAnalyticsTimeline(repoId, {
        teamId,
        startDate,
        endDate,
        branches: params.branches.length > 0 ? params.branches : undefined,
      }),
  });

  const sessions = query.data ?? [];
  const totalLinesChanged = sessions.reduce(
    (sum, s) => sum + s.linesChanged,
    0,
  );
  const totalWorkTimeMs = sessions.reduce((sum, s) => sum + s.workTimeMs, 0);
  const hasCost = sessions.some((s) => s.totalCost != null);
  const totalCost = hasCost
    ? sessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0)
    : null;
  const avgCostPerLine =
    totalCost != null && totalLinesChanged > 0
      ? totalCost / totalLinesChanged
      : null;
  const avgLinesPerHour =
    totalWorkTimeMs > 0
      ? totalLinesChanged / (totalWorkTimeMs / 3_600_000)
      : null;

  const byDay = new Map<string, { cost: number; lines: number }>();
  for (const s of sessions) {
    const day = dayKey(s.startTime);
    const entry = byDay.get(day) ?? { cost: 0, lines: 0 };
    entry.cost += s.totalCost ?? 0;
    entry.lines += s.linesChanged;
    byDay.set(day, entry);
  }
  const chartData = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, { cost, lines }]) => ({
      label,
      value: lines > 0 ? cost / lines : 0,
    }));

  const kpiRows = [
    { label: 'Total Lines Changed', value: totalLinesChanged.toLocaleString() },
    {
      label: 'Avg Cost / Line',
      value:
        avgCostPerLine != null ? COST_PER_LINE_FORMAT(avgCostPerLine) : '–',
    },
    {
      label: 'Avg Lines / Hour',
      value:
        avgLinesPerHour != null ? LINES_PER_HOUR_FORMAT(avgLinesPerHour) : '–',
    },
    { label: 'Total Cost', value: formatCost(totalCost) },
  ];

  const { downloadError, handleDownload } = useReportPdfDownload(
    () =>
      PdfDocumentShell({
        title: 'Productivity',
        repoUrl,
        teamName,
        periodLabel: formatPeriodLabel(params.startDate, params.endDate),
        generatedAt: formatGeneratedAt(),
        kpiRows,
        children: (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Cost per Line by Day</Text>
            <BarChartPdf
              data={chartData}
              color="#a3e635"
              formatValue={(v) =>
                v === 0 ? '$0/line' : COST_PER_LINE_FORMAT(v)
              }
            />
          </View>
        ),
      }),
    `productivity_${params.startDate}_${params.endDate}.pdf`,
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
        title="Productivity"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      <ReportKpiTable rows={kpiRows} />
      <section>
        <h2 className="text-sm font-semibold text-foreground">
          Cost per Line by Day
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Total cost divided by lines changed, per day
        </p>
        <ProductivityByDayChart data={chartData} />
      </section>
    </ReportDocumentShell>
  );
}
