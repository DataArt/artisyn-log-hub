/**
 * "Claude Code Version Usage" report — per user, how many root sessions in the selected range
 * ran a Claude Code version older than the npm `stable` release that was current when each
 * session started. Users with outdated sessions are highlighted red and sorted first (server
 * order is kept as-is).
 *
 * No KPI block: the single table is the whole report (see the task wireframe).
 */
import { useQuery } from '@tanstack/react-query';
import { fetchClaudeVersionUsageReport } from '../../../api';
import { UsageReportDocument } from './UsageReportDocument';
import {
  buildClaudeVersionUsageRow,
  CLAUDE_VERSION_USAGE_COLUMNS,
  CLAUDE_VERSION_USAGE_FOOTNOTE,
} from './usage-report-rows';
import { toIsoDateBounds, type ReportParamsState } from './report-url';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

export function ClaudeVersionUsageReport({
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
      'report-claude-version-usage',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchClaudeVersionUsageReport(repoId, {
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
      title="Claude Code Version Usage"
      repoId={repoId}
      teamId={teamId}
      params={params}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={data != null}
      pdfFilePrefix="claude-version-usage"
      kpiRows={[]}
      sections={
        data
          ? [
              {
                title: 'Users on outdated Claude Code',
                columns: CLAUDE_VERSION_USAGE_COLUMNS,
                rows: data.rows.map(buildClaudeVersionUsageRow),
                footnote: CLAUDE_VERSION_USAGE_FOOTNOTE,
                emptyLabel: 'No sessions in this period',
                highlightRows: data.rows.map((r) => r.outdatedSessions > 0),
                highlightTone: 'destructive',
              },
            ]
          : []
      }
    />
  );
}
