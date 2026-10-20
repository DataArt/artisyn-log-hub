import { useMemo, useState } from 'react';
import { View, Text } from '@react-pdf/renderer';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown } from 'lucide-react';
import { fetchRepositoryBranches } from '../../../api';
import { formatCost } from '@/lib/format';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportKpiTable } from './ReportKpiTable';
import { ReportDocumentShell } from './ReportDocumentShell';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { TablePdf } from './pdf/TablePdf';
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

type SortKey =
  | 'branch'
  | 'sessionCount'
  | 'totalWorkTimeMs'
  | 'totalLinesChanged'
  | 'totalCost';

export function BranchSummaryReport({
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
  const [sortKey, setSortKey] = useState<SortKey>('sessionCount');
  const [sortDesc, setSortDesc] = useState(true);

  const query = useQuery({
    queryKey: [
      'report-branch-summary',
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
    const filtered =
      params.branches.length > 0
        ? all.filter(
            (r) => r.branch != null && params.branches.includes(r.branch),
          )
        : all;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? (sortKey === 'branch' ? '' : 0);
      const bv = b[sortKey] ?? (sortKey === 'branch' ? '' : 0);
      if (av < bv) return sortDesc ? 1 : -1;
      if (av > bv) return sortDesc ? -1 : 1;
      return 0;
    });
  }, [query.data, params.branches, sortKey, sortDesc]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  const totalSessions = rows.reduce((sum, r) => sum + r.sessionCount, 0);
  const totalWorkTimeMs = rows.reduce((sum, r) => sum + r.totalWorkTimeMs, 0);
  const hasCost = rows.some((r) => r.totalCost != null);
  const totalCost = hasCost
    ? rows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0)
    : null;

  const tableRows = rows.map((r) => [
    r.branch ?? 'no branch',
    String(r.sessionCount),
    formatReportDuration(r.totalWorkTimeMs),
    String(r.totalLinesChanged),
    formatCost(r.totalCost),
  ]);

  const { downloadError, handleDownload } = useReportPdfDownload(
    () =>
      PdfDocumentShell({
        title: 'Branch Summary',
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
            <Text style={pdfStyles.sectionTitle}>Branches</Text>
            <TablePdf
              columns={[
                'Branch',
                'Sessions',
                'Work time',
                'Lines changed',
                'Cost',
              ]}
              rows={tableRows}
            />
          </View>
        ),
      }),
    `branch-summary_${params.startDate}_${params.endDate}.pdf`,
  );

  function Header({ label, sortField }: { label: string; sortField: SortKey }) {
    return (
      <th
        onClick={() => handleSort(sortField)}
        className="cursor-pointer select-none px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {sortKey === sortField && <ArrowUpDown className="size-3" />}
        </span>
      </th>
    );
  }

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
        title="Branch Summary"
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
        <h2 className="text-sm font-semibold text-foreground">Branches</h2>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <Header label="Branch" sortField="branch" />
                <Header label="Sessions" sortField="sessionCount" />
                <Header label="Work time" sortField="totalWorkTimeMs" />
                <Header label="Lines changed" sortField="totalLinesChanged" />
                <Header label="Cost" sortField="totalCost" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.branch ?? 'no-branch'}
                  className="border-t border-border"
                >
                  <td className="px-3 py-2 font-mono">
                    {r.branch ?? 'no branch'}
                  </td>
                  <td className="px-3 py-2">{r.sessionCount}</td>
                  <td className="px-3 py-2">
                    {formatReportDuration(r.totalWorkTimeMs)}
                  </td>
                  <td className="px-3 py-2">{r.totalLinesChanged}</td>
                  <td className="px-3 py-2">{formatCost(r.totalCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </ReportDocumentShell>
  );
}
