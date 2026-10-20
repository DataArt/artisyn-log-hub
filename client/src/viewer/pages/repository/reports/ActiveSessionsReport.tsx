/**
 * "Active Sessions" report — the sessions most recently active inside the selected date
 * range, with tree-aggregated headline figures per session.
 *
 * Every report renders in full even with zero rows (see `ReportDocumentShell`), which is exactly
 * the explicit zero-row state the requirement asks for here.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchActiveSessionsReport } from '../../../api';
import { UsageReportDocument } from './UsageReportDocument';
import {
  ACTIVE_SESSIONS_FOOTNOTE,
  ACTIVE_SESSIONS_TABLE_COLUMNS,
  buildActiveSessionRow,
  buildActiveSessionsKpiRows,
} from './usage-report-rows';
import { toIsoDateBounds, type ReportParamsState } from './report-url';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

export function ActiveSessionsReport({
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
      'report-active-sessions',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchActiveSessionsReport(repoId, {
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
      title="Active Sessions"
      repoId={repoId}
      teamId={teamId}
      params={params}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={data != null}
      pdfFilePrefix="active-sessions"
      kpiRows={data ? buildActiveSessionsKpiRows(data) : []}
      sections={
        data
          ? [
              {
                title: 'Sessions by last activity',
                subtitle:
                  'Most recently active first; figures include each session’s sub-agents',
                columns: ACTIVE_SESSIONS_TABLE_COLUMNS,
                rows: data.sessions.map(buildActiveSessionRow),
                footnote: ACTIVE_SESSIONS_FOOTNOTE,
                emptyLabel: 'No sessions active in this range.',
              },
            ]
          : []
      }
    />
  );
}
