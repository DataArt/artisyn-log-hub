/**
 * "Cache Read Ratio" report document.
 *
 * Every aggregate is reported twice — root session only, and root + all
 * recursive descendants — which is why the KPI table runs
 * in the shared shells' two-value-column mode rather than in a bespoke table.
 * The cause decomposition below it is deliberately root-only.
 */
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { CACHE_RATIO_SCOPE_COLORS } from '@/lib/cache-ratio-ui';
import { fetchCacheReadRatioReport } from '../../../api';
import { CacheReadRatioChart } from './CacheReadRatioChart';
import { GroupByFanOutCaveat } from './GroupByFanOutCaveat';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportKpiTable } from './ReportKpiTable';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { GroupedBarChartPdf } from './pdf/GroupedBarChartPdf';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import {
  buildCacheRatioCauseFootnote,
  buildCacheRatioCauseRows,
  buildCacheRatioGroupRow,
  buildCacheRatioKpiRows,
  CACHE_RATIO_GROUP_COLUMNS,
  CACHE_RATIO_VALUE_HEADERS,
} from './cache-read-ratio-rows';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import type { CacheReadRatioReportData } from '../../../../models/repositories';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

function shortDayLabel(bucket: string): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  if (isNaN(d.getTime())) return bucket;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

function buildPdf(
  data: CacheReadRatioReportData,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
) {
  const causeRows = buildCacheRatioCauseRows(data.causes);
  return PdfDocumentShell({
    title: 'Cache Read Ratio',
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    valueHeaders: CACHE_RATIO_VALUE_HEADERS,
    kpiRows: buildCacheRatioKpiRows(data),
    children: (
      <>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Cache Read Ratio per Day</Text>
          <Text style={pdfStyles.sectionSubtitle}>
            Root only (blue) vs root + descendants (teal); dashed stub = n/a
          </Text>
          <GroupedBarChartPdf
            data={data.buckets.map((bucket) => ({
              label: shortDayLabel(bucket.bucket),
              a: bucket.root.ratio == null ? null : bucket.root.ratio * 100,
              b:
                bucket.withDescendants.ratio == null
                  ? null
                  : bucket.withDescendants.ratio * 100,
            }))}
            colorA={CACHE_RATIO_SCOPE_COLORS.root}
            colorB={CACHE_RATIO_SCOPE_COLORS.withDescendants}
            axisMaxOverride={100}
            formatValue={(v) => `${v}%`}
            undefinedColor={CACHE_RATIO_SCOPE_COLORS.undefinedRatio}
          />
        </View>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>
            Why was cache creation high?
          </Text>
          <TablePdf
            columns={['Cause', 'Turns', 'Creation tokens', '% of creation']}
            rows={causeRows.map((r) => [
              r.cause,
              r.turns,
              r.creationTokens,
              r.share,
            ])}
          />
          <Text style={pdfStyles.meta}>
            {buildCacheRatioCauseFootnote(data.causes)}
          </Text>
        </View>
        {data.groups && data.groups.length > 0 ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Breakdown by group</Text>
            <TablePdf
              columns={CACHE_RATIO_GROUP_COLUMNS}
              rows={data.groups.map(buildCacheRatioGroupRow)}
            />
          </View>
        ) : (
          <View />
        )}
      </>
    ),
  });
}

export function CacheReadRatioReport({
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
      'report-cache-read-ratio',
      repoId,
      teamId,
      startDate,
      endDate,
      params.groupBy,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchCacheReadRatioReport(repoId, {
        teamId,
        startDate,
        endDate,
        groupBy: params.groupBy !== 'none' ? params.groupBy : undefined,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
      }),
  });

  const data = query.data;

  // Sum of each group's own root-scope
  // session count vs the report's overall root-scope total (the report keeps both
  // scopes, but the fan-out comparison only makes sense against one — root, matching how
  // the group table itself already leads with root figures).
  const groupedSessionTotal = data?.groups
    ? data.groups.reduce((sum, g) => sum + g.root.sessionCount, 0)
    : 0;
  const showFanOutCaveat =
    data != null &&
    params.groupBy.startsWith('attr:') &&
    groupedSessionTotal > data.root.sessionCount;

  const { downloadError, handleDownload } = useReportPdfDownload(
    () => buildPdf(data!, repoUrl, teamName, params),
    `cache-read-ratio_${params.startDate}_${params.endDate}.pdf`,
  );

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
        title="Cache Read Ratio"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {data && (
        <>
          <ReportKpiTable
            rows={buildCacheRatioKpiRows(data)}
            valueHeaders={CACHE_RATIO_VALUE_HEADERS}
          />

          <GroupByFanOutCaveat show={showFanOutCaveat} />

          <section className="mb-6">
            <h2 className="text-sm font-semibold text-foreground">
              Cache Read Ratio per Day
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Ratio of summed tokens (token-weighted), per UTC day
            </p>
            <CacheReadRatioChart buckets={data.buckets} />
          </section>

          <CauseSection data={data} />

          {data.groups && data.groups.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-foreground">
                Breakdown by {params.groupBy === 'branch' ? 'branch' : 'user'}
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Both scopes per group, over the whole period
              </p>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      {CACHE_RATIO_GROUP_COLUMNS.map((col, i) => (
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
                    {data.groups.map((g) => (
                      <tr key={g.group} className="border-t border-border">
                        {buildCacheRatioGroupRow(g).map((cell, i) => (
                          <td
                            key={i}
                            className={
                              i === 0
                                ? 'px-3 py-2 font-mono'
                                : 'px-3 py-2 text-right'
                            }
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
          )}
        </>
      )}
    </ReportDocumentShell>
  );
}

function CauseSection({ data }: { data: CacheReadRatioReportData }) {
  const rows = buildCacheRatioCauseRows(data.causes);
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-foreground">
        Why was cache creation high?
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Turns above the high cache-creation threshold, attributed to a cause
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Cause
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Turns
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Creation tokens
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                % of creation
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.cause}
                className={`border-t border-border ${
                  r.muted ? 'text-muted-foreground' : ''
                } ${r.total ? 'font-semibold' : ''}`}
              >
                <td className="px-3 py-2">{r.cause}</td>
                <td className="px-3 py-2 text-right">{r.turns}</td>
                <td className="px-3 py-2 text-right">{r.creationTokens}</td>
                <td className="px-3 py-2 text-right">{r.share}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {buildCacheRatioCauseFootnote(data.causes)}
      </p>
    </section>
  );
}
