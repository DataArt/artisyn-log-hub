/**
 * "Harness Usage" report document — one wide, sortable, kind-filterable table of
 * every skill/rule/MCP-server/tool the repo's harness has ever self-reported, merged with
 * its real per-session usage/token facts. Not the usage-report `UsageReportDocument` multi-section
 * shell — closest precedent is `BranchSummaryReport`'s hand-rolled sort
 * pattern, here delegated to `HarnessUsageTable` so a grouped view can render one independent
 * table per group.
 */
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import { fetchHarnessUsageReport } from '../../../api';
import { GroupByFanOutCaveat } from './GroupByFanOutCaveat';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportDocumentShell } from './ReportDocumentShell';
import { HarnessUsageTable } from './HarnessUsageTable';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import {
  buildHarnessKpiTiles,
  buildHarnessPdfRows,
  HARNESS_TABLE_COLUMNS,
} from './harness-usage-rows';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { toIsoDateBounds, type ReportParamsState } from './report-url';
import type { HarnessUsageReportData } from '../../../../models/harness-usage';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

interface TileSpec {
  label: string;
  value: string;
  accentClassName: string;
}

// Four headline tiles (wireframe order: elements, never-used, total uses, sessions in
// period) — no delta pills here, unlike Executive Summary's `KpiTiles`, since this report
// has no previous-period comparison concept.
function HarnessKpiTiles({ data }: { data: HarnessUsageReportData }) {
  const [elements, neverUsed, totalUses, sessionCount] =
    buildHarnessKpiTiles(data);
  const tiles: TileSpec[] = [
    { ...elements, accentClassName: 'bg-blue-500 dark:bg-blue-400' },
    { ...neverUsed, accentClassName: 'bg-red-500 dark:bg-red-400' },
    { ...totalUses, accentClassName: 'bg-violet-500 dark:bg-violet-400' },
    { ...sessionCount, accentClassName: 'bg-amber-500 dark:bg-amber-400' },
  ];
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="relative overflow-hidden rounded-md border border-border bg-background p-3 pl-4"
        >
          <span
            className={`absolute inset-y-0 left-0 w-1 ${tile.accentClassName}`}
            aria-hidden="true"
          />
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {tile.label}
          </span>
          <p className="mt-2 text-lg font-bold text-foreground">{tile.value}</p>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/20 px-6 py-16 text-center">
      <PackageSearch className="size-9 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">
        No harness inventory reported yet
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        This repo&apos;s installed hook has never uploaded a harness inventory
        self-report (skills, rules, MCP servers, tools) — usually an older hook
        version, or no session has run yet since this feature shipped.
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        The report intentionally does not fall back to usage-only rows here —
        without an inventory, &quot;0 uses&quot; can&apos;t be distinguished
        from &quot;not tracked&quot;, so it stays empty.
      </p>
      <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
        Check hook version — see Installed Hooks
      </span>
    </div>
  );
}

function buildPdf(
  data: HarnessUsageReportData,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
) {
  return PdfDocumentShell({
    title: 'Harness Usage',
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    kpiRows: buildHarnessKpiTiles(data),
    children: !data.inventoryReported ? (
      <View style={pdfStyles.section}>
        <Text style={pdfStyles.sectionTitle}>
          No harness inventory reported yet
        </Text>
        <Text style={pdfStyles.meta}>
          This repo&apos;s installed hook has never uploaded a harness inventory
          self-report.
        </Text>
      </View>
    ) : data.groups && data.groups.length > 0 ? (
      <>
        {data.groups.map((g) => (
          <View key={g.group} style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>{g.group}</Text>
            <TablePdf
              columns={HARNESS_TABLE_COLUMNS}
              rows={buildHarnessPdfRows(g.rows)}
            />
          </View>
        ))}
      </>
    ) : (
      <View style={pdfStyles.section}>
        <Text style={pdfStyles.sectionTitle}>All harness elements</Text>
        <TablePdf
          columns={HARNESS_TABLE_COLUMNS}
          rows={buildHarnessPdfRows(data.rows)}
        />
      </View>
    ),
  });
}

export function HarnessUsageReport({
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
      'report-harness-usage',
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
      fetchHarnessUsageReport(repoId, {
        teamId,
        startDate,
        endDate,
        groupBy: params.groupBy !== 'none' ? params.groupBy : undefined,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
      }),
  });

  const data = query.data;

  // `HarnessUsageGroup` carries element rows
  // (skills/rules/MCP servers/tools), not a per-group session count, so there is no total to
  // compare against here the way `session-timeline`/`cost-by-user`/`cache-read-ratio` can.
  // Falls back to always showing the caveat once grouped by an attribute, since it can't be
  // ruled out from this report's response shape.
  const showFanOutCaveat = params.groupBy.startsWith('attr:');

  const { downloadError, handleDownload } = useReportPdfDownload(
    () => buildPdf(data!, repoUrl, teamName, params),
    `harness-usage_${params.startDate}_${params.endDate}.pdf`,
  );

  return (
    <ReportDocumentShell
      isLoading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      canDownload={data != null && !query.isFetching && !query.error}
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
      maxWidthClassName="max-w-[1000px]"
    >
      <ReportDocumentHeader
        title="Harness Usage"
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {data && (
        <>
          <HarnessKpiTiles data={data} />
          <GroupByFanOutCaveat show={showFanOutCaveat} />
          {!data.inventoryReported ? (
            <EmptyState />
          ) : data.groups && data.groups.length > 0 ? (
            data.groups.map((g) => (
              <HarnessUsageTable key={g.group} rows={g.rows} title={g.group} />
            ))
          ) : (
            <HarnessUsageTable rows={data.rows} />
          )}
        </>
      )}
    </ReportDocumentShell>
  );
}
