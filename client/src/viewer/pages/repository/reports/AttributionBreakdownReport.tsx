/**
 * "Attribution Breakdown" report document.
 *
 * One section per declared AI Session Attribution attribute: a
 * `string`/`number` section is a ranked table (top 15 + "Other"); a `boolean` section is
 * exactly 4 fixed, unranked rows; a `string[]` section is the same ranked-table shape as
 * `string`/`number` but flags `fanOut: true` — its shares can legitimately sum above 100%,
 * since one session can land in more than one row. "Not determined"/"Unattributed" are
 * always their own rows in every layout, never folded into "Other" — the server already
 * built every row this way (`attribution-breakdown.service.ts`); this component only renders
 * it.
 */
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { Tags } from 'lucide-react';
import { fetchAttributionBreakdownReport } from '../../../api';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportKpiTable } from './ReportKpiTable';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import {
  ATTRIBUTION_BREAKDOWN_SECTION_COLUMNS,
  buildAttributionBreakdownKpiRows,
  buildAttributionBreakdownSectionRow,
  isMutedBreakdownRow,
} from './attribution-breakdown-rows';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import type {
  AttributionBreakdownReportData,
  AttributionBreakdownSection,
} from '../../../../models/repositories';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

// No attributes declared for this repo at all (feature off / no team override yet) — same
// "no attributes" cause the Analytics tab's "Group by" dropdown's ATTRIBUTES section
// reflects by simply having nothing to list.
function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/20 px-6 py-16 text-center">
      <Tags className="size-9 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">
        No attributes declared
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        AI Attribute Extraction is not configured for this repository — a team
        owner can turn it on and declare attributes in Repository Settings.
      </p>
    </div>
  );
}

function SectionTable({ section }: { section: AttributionBreakdownSection }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-foreground">{section.label}</h2>
      {section.fanOut && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
          This attribute can carry more than one value per session — sessions
          and share below can legitimately sum above the report&apos;s total.
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              {ATTRIBUTION_BREAKDOWN_SECTION_COLUMNS.map((col, i) => (
                <th
                  key={col}
                  className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${
                    i === 0 ? 'text-left' : 'text-right'
                  }`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.rows.map((row) => (
              <tr
                key={row.value}
                className={`border-t border-border ${
                  isMutedBreakdownRow(row) ? 'text-muted-foreground italic' : ''
                }`}
              >
                {buildAttributionBreakdownSectionRow(row).map((cell, i) => (
                  <td
                    key={i}
                    className={i === 0 ? 'px-3 py-2' : 'px-3 py-2 text-right'}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildPdf(
  data: AttributionBreakdownReportData,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
) {
  return PdfDocumentShell({
    title: 'Attribute Breakdown',
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    kpiRows: buildAttributionBreakdownKpiRows(data),
    children: (
      <>
        {data.sections.map((section) => (
          <View key={section.key} style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>{section.label}</Text>
            {section.fanOut && (
              <Text style={pdfStyles.sectionSubtitle}>
                Can carry more than one value per session — sessions/share can
                sum above the report&apos;s total.
              </Text>
            )}
            <TablePdf
              columns={ATTRIBUTION_BREAKDOWN_SECTION_COLUMNS}
              rows={section.rows.map(buildAttributionBreakdownSectionRow)}
            />
          </View>
        ))}
      </>
    ),
  });
}

export function AttributionBreakdownReport({
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
      'report-attribution-breakdown',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchAttributionBreakdownReport(repoId, {
        teamId,
        startDate,
        endDate,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
      }),
  });

  const data = query.data;

  const { downloadError, handleDownload } = useReportPdfDownload(
    () => buildPdf(data!, repoUrl, teamName, params),
    `attribute-breakdown_${params.startDate}_${params.endDate}.pdf`,
  );

  return (
    <ReportDocumentShell
      isLoading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      canDownload={
        data != null &&
        data.sections.length > 0 &&
        !query.isFetching &&
        !query.error
      }
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
    >
      <ReportDocumentHeader
        title="Attribute Breakdown"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {data &&
        (data.sections.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <ReportKpiTable rows={buildAttributionBreakdownKpiRows(data)} />
            {data.sections.map((section) => (
              <SectionTable key={section.key} section={section} />
            ))}
          </>
        ))}
    </ReportDocumentShell>
  );
}
