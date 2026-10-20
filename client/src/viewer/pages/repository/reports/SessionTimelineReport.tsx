import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { formatCost } from '@/lib/format';
import { fetchAnalyticsTimeline } from '../../../api';
import { GroupByFanOutCaveat } from './GroupByFanOutCaveat';
import { SessionCountByDayChart } from './SessionCountByDayChart';
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

export function SessionTimelineReport({
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
      'report-session-timeline',
      repoId,
      teamId,
      startDate,
      endDate,
      params.groupBy,
      params.branches,
      generation,
    ],
    queryFn: () =>
      fetchAnalyticsTimeline(repoId, {
        teamId,
        startDate,
        endDate,
        groupBy: params.groupBy !== 'none' ? params.groupBy : undefined,
        branches: params.branches.length > 0 ? params.branches : undefined,
      }),
  });

  const sessions = query.data ?? [];
  const hasCost = sessions.some((s) => s.totalCost != null);
  const totalCost = hasCost
    ? sessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0)
    : null;
  const workTimeMs = sessions.reduce((sum, s) => sum + s.workTimeMs, 0);

  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const day = dayKey(s.startTime);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const chartData = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, value]) => ({ label, value }));

  // Sum of per-group session counts vs the
  // report's own total; each session carries exactly one `group` value today (the server
  // folds a `string[]` attribute's values into one joined label rather than fanning a
  // session into several rows), so this is currently always equal — the check stays exact
  // rather than assumed, so it starts firing correctly if that ever changes.
  const groupedSessionTotal = (() => {
    const perGroup = new Map<string, number>();
    for (const s of sessions) {
      const g = s.group ?? 'unknown';
      perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    }
    return Array.from(perGroup.values()).reduce((sum, n) => sum + n, 0);
  })();
  const showFanOutCaveat =
    params.groupBy.startsWith('attr:') && groupedSessionTotal > sessions.length;

  const { downloadError, handleDownload } = useReportPdfDownload(
    () =>
      PdfDocumentShell({
        title: 'Session Timeline',
        repoUrl,
        teamName,
        periodLabel: formatPeriodLabel(params.startDate, params.endDate),
        generatedAt: formatGeneratedAt(),
        kpiRows: [
          { label: 'Total Sessions', value: String(sessions.length) },
          { label: 'Total Work Time', value: formatReportDuration(workTimeMs) },
          { label: 'Total Cost', value: formatCost(totalCost) },
        ],
        children: (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Sessions per Day</Text>
            <BarChartPdf data={chartData} color="#93c5fd" />
          </View>
        ),
      }),
    `session-timeline_${params.startDate}_${params.endDate}.pdf`,
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
        title="Session Timeline"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      <ReportKpiTable
        rows={[
          { label: 'Total Sessions', value: String(sessions.length) },
          { label: 'Total Work Time', value: formatReportDuration(workTimeMs) },
          {
            label: 'Total Cost',
            value: formatCost(totalCost),
            emphasize: true,
          },
        ]}
      />
      <GroupByFanOutCaveat show={showFanOutCaveat} />
      <section>
        <h2 className="text-sm font-semibold text-foreground">
          Sessions per Day
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          {params.groupBy !== 'none'
            ? `Grouped by ${params.groupBy}`
            : 'Total sessions started each day'}
        </p>
        <SessionCountByDayChart sessions={sessions} groupBy={params.groupBy} />
      </section>
    </ReportDocumentShell>
  );
}
