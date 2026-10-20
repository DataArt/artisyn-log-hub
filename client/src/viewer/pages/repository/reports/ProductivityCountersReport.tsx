/**
 * "Productivity Counters" report — diff-based lines added/removed, commits and pull
 * requests, with published coverage.
 *
 * This page deliberately shows NO written-lines figure. `session_stats.lines_changed` (labelled
 * "Lines changed (written)") is a different measure — lines written by Edit/Write with no delta
 * and no removals, roughly 3x the diff-based added count — and the requirement forbids the two
 * appearing on the same page. It stays in the Productivity and Executive Summary reports.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchProductivityCountersReport } from '../../../api';
import { UsageReportDocument } from './UsageReportDocument';
import {
  buildProductivityFootnote,
  buildProductivityKpiRows,
  buildProductivityTableRow,
  PRODUCTIVITY_TABLE_COLUMNS,
} from './usage-report-rows';
import { toIsoDateBounds, type ReportParamsState } from './report-url';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

export function ProductivityCountersReport({
  repoId,
  teamId,
  params,
  generation,
}: Props) {
  const { startDate, endDate } = toIsoDateBounds(
    params.startDate,
    params.endDate,
  );

  const query = useQuery({
    queryKey: [
      'report-productivity-counters',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchProductivityCountersReport(repoId, {
        teamId,
        startDate,
        endDate,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
      }),
  });

  const data = query.data;

  return (
    <UsageReportDocument
      title="Productivity Counters"
      repoId={repoId}
      teamId={teamId}
      params={params}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={data != null}
      pdfFilePrefix="productivity-counters"
      kpiRows={data ? buildProductivityKpiRows(data) : []}
      sections={
        data
          ? [
              {
                title: 'By day',
                subtitle: 'Diff-based line counts per UTC day',
                columns: PRODUCTIVITY_TABLE_COLUMNS,
                rows: data.buckets.map(buildProductivityTableRow),
                footnote: buildProductivityFootnote(data),
                emptyLabel: 'No productivity activity in the selected range.',
              },
            ]
          : []
      }
    />
  );
}
