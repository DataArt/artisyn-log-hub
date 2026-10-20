import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { fetchAnalyticsWorkTime } from '../../../api';
import { GroupByFanOutCaveat } from './GroupByFanOutCaveat';
import { WorkTimeByDayChart } from './WorkTimeByDayChart';
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

function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function WorkTimeDistributionReport({
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
      'report-work-time',
      repoId,
      teamId,
      startDate,
      endDate,
      params.groupBy,
      params.branches,
      generation,
    ],
    queryFn: () =>
      fetchAnalyticsWorkTime(repoId, {
        teamId,
        startDate,
        endDate,
        groupBy: params.groupBy !== 'none' ? params.groupBy : undefined,
        branches: params.branches.length > 0 ? params.branches : undefined,
      }),
  });

  const buckets = query.data ?? [];
  const workTimeMs = buckets.reduce(
    (sum, b) => sum + b.workTimeMinutes * 60_000,
    0,
  );

  const byDay = new Map<string, number>();
  for (const b of buckets) {
    const day = dayKey(b.day);
    byDay.set(day, (byDay.get(day) ?? 0) + b.workTimeMinutes);
  }
  const chartData = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, value]) => ({ label, value }));

  // `WorkTimeBucket` carries no session count
  // at all (only minutes per day/group), so there is no total to compare against the way
  // `session-timeline`/`cost-by-user`/`cache-read-ratio` can. Falls back to always showing the
  // caveat once grouped by an attribute, since it can't be ruled out from this report's
  // response shape (same rationale as HarnessUsageReport.tsx).
  const showFanOutCaveat = params.groupBy.startsWith('attr:');

  const { downloadError, handleDownload } = useReportPdfDownload(
    () =>
      PdfDocumentShell({
        title: 'Work Time Distribution',
        repoUrl,
        teamName,
        periodLabel: formatPeriodLabel(params.startDate, params.endDate),
        generatedAt: formatGeneratedAt(),
        kpiRows: [
          { label: 'Total Work Time', value: formatReportDuration(workTimeMs) },
        ],
        children: (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Minutes per Day</Text>
            <BarChartPdf
              data={chartData}
              color="#93c5fd"
              formatValue={(v) =>
                v === 0 ? '0m' : formatReportDuration(v * 60_000)
              }
            />
          </View>
        ),
      }),
    `work-time_${params.startDate}_${params.endDate}.pdf`,
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
        title="Work Time Distribution"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      <ReportKpiTable
        rows={[
          {
            label: 'Total Work Time',
            value: formatReportDuration(workTimeMs),
            emphasize: true,
          },
        ]}
      />
      <GroupByFanOutCaveat show={showFanOutCaveat} />
      <section>
        <h2 className="text-sm font-semibold text-foreground">
          Work Time per Day
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          {params.groupBy !== 'none'
            ? `Grouped by ${params.groupBy}`
            : 'Total autonomous work minutes each day'}
        </p>
        <WorkTimeByDayChart buckets={buckets} />
      </section>
    </ReportDocumentShell>
  );
}
