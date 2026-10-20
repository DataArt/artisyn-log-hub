/**
 * "Attribution Usage" report document.
 *
 * Population is `session_attribution_runs` — every evaluation ATTEMPT, including `failed`
 * ones — not sessions carrying resolved values (that's Attribution Breakdown). No `attr=`
 * filter (`supportsAttributeFilter: false`): a `failed` run stores no
 * `values` at all, so filtering runs by attribute value would silently drop every failure.
 * Its own scope-narrowing control is a repeatable `outcome=` instead, rendered via
 * `AttributionUsageOutcomeToggle` — a local, presentation-only toggle group (same
 * "not URL-synced" precedent as `HarnessUsageTable`'s kind filter). The two on-page tables
 * live in `AttributionUsageTables.tsx` to keep this file under the component-size guidance.
 */
import { useState } from 'react';
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { fetchAttributionUsageReport } from '../../../api';
import {
  AttributionUsageOutcomeTable,
  AttributionUsageOutcomeToggle,
  AttributionUsageTopSessionsTable,
} from './AttributionUsageTables';
import { AttributionUsageByDayChart } from './AttributionUsageByDayChart';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportKpiTable } from './ReportKpiTable';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { BarChartPdf } from './pdf/BarChartPdf';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import {
  ATTRIBUTION_USAGE_OUTCOME_COLUMNS,
  ATTRIBUTION_USAGE_TOP_COLUMNS,
  buildAttributionUsageKpiRows,
  buildAttributionUsageOutcomeRow,
  buildAttributionUsageTopRow,
} from './attribution-usage-rows';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import type {
  AttributionUsageReportData,
  SessionAttributionRunOutcome,
} from '../../../../models/repositories';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

function buildPdf(
  data: AttributionUsageReportData,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
) {
  return PdfDocumentShell({
    title: 'Attribute Extraction Usage',
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    kpiRows: buildAttributionUsageKpiRows(data),
    children: (
      <>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Outcome breakdown</Text>
          <TablePdf
            columns={ATTRIBUTION_USAGE_OUTCOME_COLUMNS}
            rows={data.outcomeBreakdown.map(buildAttributionUsageOutcomeRow)}
          />
        </View>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Evaluations per Day</Text>
          <BarChartPdf
            data={data.byDay.map((d) => ({ label: d.date, value: d.count }))}
            color="#8b5cf6"
          />
        </View>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Most re-evaluated sessions</Text>
          <TablePdf
            columns={ATTRIBUTION_USAGE_TOP_COLUMNS}
            rows={data.topReevaluatedSessions.map(buildAttributionUsageTopRow)}
          />
        </View>
      </>
    ),
  });
}

export function AttributionUsageReport({
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

  // Presentation-only outcome narrowing — not URL-synced (same precedent as
  // HarnessUsageTable's kind filter chips). Empty set means "no narrowing", same as omitting
  // `outcome=` entirely.
  const [selectedOutcomes, setSelectedOutcomes] = useState<
    Set<SessionAttributionRunOutcome>
  >(new Set());
  const outcomesParam = Array.from(selectedOutcomes).sort();

  const query = useQuery({
    queryKey: [
      'report-attribution-usage',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      outcomesParam.join(','),
      generation,
    ],
    queryFn: () =>
      fetchAttributionUsageReport(repoId, {
        teamId,
        startDate,
        endDate,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
        outcomes: outcomesParam.length > 0 ? outcomesParam : undefined,
      }),
  });

  const data = query.data;

  const { downloadError, handleDownload } = useReportPdfDownload(
    () => buildPdf(data!, repoUrl, teamName, params),
    `attribute-extraction-usage_${params.startDate}_${params.endDate}.pdf`,
  );

  function toggleOutcome(outcome: SessionAttributionRunOutcome) {
    setSelectedOutcomes((prev) => {
      const next = new Set(prev);
      if (next.has(outcome)) next.delete(outcome);
      else next.add(outcome);
      return next;
    });
  }

  return (
    <ReportDocumentShell
      isLoading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      canDownload={data != null && !query.isFetching && !query.error}
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
    >
      <ReportDocumentHeader
        title="Attribute Extraction Usage"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />

      <AttributionUsageOutcomeToggle
        selectedOutcomes={selectedOutcomes}
        onToggle={toggleOutcome}
        onClear={() => setSelectedOutcomes(new Set())}
      />

      {data && (
        <>
          <ReportKpiTable rows={buildAttributionUsageKpiRows(data)} />

          <AttributionUsageOutcomeTable rows={data.outcomeBreakdown} />

          <section className="mb-6">
            <h2 className="text-sm font-semibold text-foreground">
              Evaluations per Day
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              UTC day of the evaluation attempt itself, not the invoking
              session&apos;s start time
            </p>
            <AttributionUsageByDayChart byDay={data.byDay} />
          </section>

          <AttributionUsageTopSessionsTable
            rows={data.topReevaluatedSessions}
          />
        </>
      )}
    </ReportDocumentShell>
  );
}
