/**
 * "Change Surface" report document.
 *
 * Reports → Code → "Change Surface". Same shell as every other report document (header, KPI
 * table, chart, PDF export); the shape closest to it is `CacheReadRatioReport` — a bounded
 * 0–100 metric on a fixed axis, a two-value-column KPI table and a grouped breakdown table.
 *
 * Three things this report must never do:
 *
 * - Render an absent value as `0`. `computed: false` (no session in the period ever had its
 *   change surface computed) gets its own empty state; a `null` concentration reads `n/a`;
 *   and a missing `repo_code_inventory` snapshot makes both `%` indicators read
 *   "n/a · denominator unavailable".
 * - Imply the grouped rows add up to the repo row. They are each recomputed from the union of
 *   that group's changed paths and legitimately overlap, so the caveat sentence is printed
 *   inline under the table rather than left to the reader.
 * - Offer a scope toggle. Everything here is tree-scoped, always: sub-agent
 *   edits are part of the parent's surface on every surface, and the spec requires the
 *   report and the analytics chart to agree — both read the same aggregate service.
 */
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { FolderSearch } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CHANGE_BAND_COLORS,
  CHANGE_BAND_LEGEND,
  CHANGE_SURFACE_NA,
  CONCENTRATION_AXIS_MAX,
} from '@/lib/change-surface-ui';
import { fetchChangeSurfaceReport } from '../../../api';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';
import { GroupByFanOutCaveat } from './GroupByFanOutCaveat';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportDocumentShell } from './ReportDocumentShell';
import { ReportKpiTable } from './ReportKpiTable';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import {
  buildChangeSurfaceGroupRow,
  buildChangeSurfaceKpiRows,
  buildChangeSurfaceShareRows,
  buildConcentrationWeekRows,
  buildConcentrationWeeks,
  buildInventoryCaption,
  CHANGE_SURFACE_GROUP_CAVEAT,
  CHANGE_SURFACE_VALUE_HEADERS,
  CHANGE_SURFACE_WEEK_COLUMNS,
  changeSurfaceGroupColumns,
  type ConcentrationWeekPoint,
} from './change-surface-rows';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import type { ChangeSurfaceReportData } from '../../../../models/repositories';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/20 px-6 py-16 text-center">
      <FolderSearch className="size-9 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">
        No change-surface data for this period
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        No session in the selected range has a computed change surface — usually
        an older hook version that never reported the changed paths, or no
        session has run in this period since the feature shipped.
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        The report deliberately shows nothing here rather than zeros: &quot;no
        files were changed&quot; and &quot;we never recorded which files were
        changed&quot; are opposite statements and must not look alike.
      </p>
    </div>
  );
}

/**
 * The three band ranges, drawn as shaded background zones. Display copy describing the
 * server's fixed thresholds — exactly what `ChangeSurfaceBarChart`
 * does on the analytics tab. No datum's band is derived from these: the report's weekly
 * bucket carries no `band` field, so the bars keep one neutral colour and the zones alone
 * say where a week sits.
 */
const BAND_ZONES = [
  { band: 'scattered', from: 0, to: 40 },
  { band: 'mixed', from: 40, to: 60 },
  { band: 'focused', from: 60, to: CONCENTRATION_AXIS_MAX },
] as const;

/** Slate-500 — deliberately none of the three band hues, which belong to the zones. */
const WEEK_BAR_COLOR = '#64748b';

/**
 * Weekly concentration on a **fixed** 0–100 axis: the metric is bounded,
 * so rescaling to the data would make a two-point wobble look like a collapse, and
 * `zoneColor()` — relative to a dataset max — would paint the most focused week orange. A
 * week with no changed files has no concentration at all: its value is `null`, so Recharts
 * draws no bar (never a `0` one) and the tooltip reads `n/a`.
 */
function ConcentrationPerWeekChart({
  weeks,
}: {
  weeks: ConcentrationWeekPoint[];
}) {
  if (weeks.length === 0) {
    return (
      <div className="flex h-48 w-full items-center justify-center text-sm text-muted-foreground">
        No sessions in this range
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ChartResponsiveContainer>
        <BarChart data={weeks}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis
            domain={[0, CONCENTRATION_AXIS_MAX]}
            ticks={[0, 25, 50, 75, 100]}
            tick={{ fontSize: 11 }}
          />
          {BAND_ZONES.map((zone) => (
            <ReferenceArea
              key={zone.band}
              y1={zone.from}
              y2={zone.to}
              fill={CHANGE_BAND_COLORS[zone.band]}
              fillOpacity={0.08}
              ifOverflow="extendDomain"
            />
          ))}
          <Tooltip
            formatter={(value) => [
              typeof value === 'number'
                ? `${value} / ${CONCENTRATION_AXIS_MAX}`
                : CHANGE_SURFACE_NA,
              'Concentration',
            ]}
          />
          <Bar
            dataKey="concentration"
            fill={WEEK_BAR_COLOR}
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}

function buildPdf(
  data: ChangeSurfaceReportData,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
) {
  const shareRows = buildChangeSurfaceShareRows(data);
  const groupColumns = changeSurfaceGroupColumns(params.groupBy);
  return PdfDocumentShell({
    title: 'Change Surface',
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    valueHeaders: CHANGE_SURFACE_VALUE_HEADERS,
    kpiRows: buildChangeSurfaceKpiRows(data),
    children: !data.repo.computed ? (
      <View style={pdfStyles.section}>
        <Text style={pdfStyles.sectionTitle}>
          No change-surface data for this period
        </Text>
        <Text style={pdfStyles.meta}>
          No session in the selected range has a computed change surface, so
          this report has nothing to divide, group or plot.
        </Text>
      </View>
    ) : (
      <>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>
            Share of codebase — git-tracked files only
          </Text>
          <TablePdf
            columns={['Indicator', 'Absolute', 'Share']}
            rows={shareRows.map((row) => [
              row.label,
              row.ratio ?? '–',
              row.value,
            ])}
          />
          <Text style={pdfStyles.meta}>
            {buildInventoryCaption(data.inventory)}
          </Text>
        </View>
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Concentration per week</Text>
          <Text style={pdfStyles.sectionSubtitle}>
            Bounded 0–100 score; a week with no changed files has no
            concentration and reads n/a
          </Text>
          <TablePdf
            columns={CHANGE_SURFACE_WEEK_COLUMNS}
            rows={buildConcentrationWeekRows(data.buckets)}
          />
        </View>
        {data.groups && data.groups.length > 0 ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Breakdown by group</Text>
            <TablePdf
              columns={groupColumns}
              rows={data.groups.map(buildChangeSurfaceGroupRow)}
            />
            <Text style={pdfStyles.meta}>{CHANGE_SURFACE_GROUP_CAVEAT}</Text>
          </View>
        ) : (
          <View />
        )}
      </>
    ),
  });
}

export function ChangeSurfaceReport({
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
      'report-change-surface',
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
      fetchChangeSurfaceReport(repoId, {
        teamId,
        startDate,
        endDate,
        groupBy: params.groupBy !== 'none' ? params.groupBy : undefined,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
      }),
  });

  const data = query.data;

  // A `string[]`-typed attribute can put one session in
  // several groups, so the grouped session counts can legitimately exceed the report's own
  // session population. Compared against `sessionsWithChanges + noChangeSessions`, which is
  // the whole population the groups were carved out of.
  const groupedSessionTotal = data?.groups
    ? data.groups.reduce((sum, g) => sum + g.sessions, 0)
    : 0;
  const showFanOutCaveat =
    data != null &&
    params.groupBy.startsWith('attr:') &&
    groupedSessionTotal > data.sessionsWithChanges + data.noChangeSessions;

  const { downloadError, handleDownload } = useReportPdfDownload(
    () => buildPdf(data!, repoUrl, teamName, params),
    `change-surface_${params.startDate}_${params.endDate}.pdf`,
  );

  const shareRows = data ? buildChangeSurfaceShareRows(data) : [];
  const groupColumns = changeSurfaceGroupColumns(params.groupBy);

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
        title="Change Surface"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {data &&
        (!data.repo.computed ? (
          <EmptyState />
        ) : (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {data.sessionsWithChanges.toLocaleString()} session(s) changed at
              least one file in this period;{' '}
              {data.noChangeSessions.toLocaleString()} changed nothing and are
              excluded from the medians. Every figure is tree-scoped — sub-agent
              sessions are part of their parent&apos;s surface.
            </p>
            {data.truncated && (
              <div className="mb-4 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                <span aria-hidden="true">⚠</span>
                <span>
                  This period holds more changed paths than the report reads in
                  one pass, so the union below is partial — narrow the date
                  range for an exact figure.
                </span>
              </div>
            )}

            <ReportKpiTable
              rows={buildChangeSurfaceKpiRows(data)}
              valueHeaders={CHANGE_SURFACE_VALUE_HEADERS}
            />

            <GroupByFanOutCaveat show={showFanOutCaveat} />

            <section className="mb-6">
              <h2 className="text-sm font-semibold text-foreground">
                Share of codebase — two separate indicators, git-tracked files
                only
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Files and lines have different denominators and are never
                blended into one number
              </p>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <tbody>
                    {shareRows.map((row) => (
                      <tr
                        key={row.label}
                        className="border-b border-border/60 last:border-b-0"
                      >
                        <td className="px-3 py-2">{row.label}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                          {row.ratio ?? '–'}
                        </td>
                        <td
                          className={
                            row.available
                              ? 'px-3 py-2 text-right font-semibold'
                              : 'px-3 py-2 text-right text-muted-foreground'
                          }
                        >
                          {row.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {buildInventoryCaption(data.inventory)}
              </p>
            </section>

            {data.groups && data.groups.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold text-foreground">
                  Grouped view — by {groupColumns[0].toLowerCase()}
                </h2>
                <div className="mt-2 overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        {groupColumns.map((col, i) => (
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
                      {data.groups.map((group) => (
                        <tr key={group.key} className="border-t border-border">
                          {buildChangeSurfaceGroupRow(group).map((cell, i) => (
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
                <p className="mt-2 text-xs text-muted-foreground">
                  {CHANGE_SURFACE_GROUP_CAVEAT}
                </p>
              </section>
            )}

            <section>
              <h2 className="text-sm font-semibold text-foreground">
                Concentration per week
              </h2>
              <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Bounded 0–100 score on a fixed axis; a week with no changed
                  files has no bar
                </span>
                {CHANGE_BAND_LEGEND.map(({ band, label, range }) => (
                  <span key={band} className="flex items-center gap-1">
                    <span
                      className="inline-block size-2 rounded-sm"
                      style={{ backgroundColor: CHANGE_BAND_COLORS[band] }}
                      aria-hidden="true"
                    />
                    {label} {range}
                  </span>
                ))}
              </div>
              <ConcentrationPerWeekChart
                weeks={buildConcentrationWeeks(data.buckets)}
              />
            </section>
          </>
        ))}
    </ReportDocumentShell>
  );
}
