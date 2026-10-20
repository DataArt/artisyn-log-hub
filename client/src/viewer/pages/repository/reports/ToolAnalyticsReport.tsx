/**
 * "Tool Analytics" report — every tool ranked by call count, with its outcome split,
 * duration statistics and coverage, plus the MCP-per-server rollup.
 *
 * Delegates to the same server service the `analytics/tools` view uses, so the report and the
 * view can never disagree.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchToolAnalyticsReport } from '../../../api';
import { UsageReportDocument } from './UsageReportDocument';
import {
  buildMcpTableRow,
  buildToolKpiRows,
  buildToolTableRow,
  MCP_TABLE_COLUMNS,
  TOOL_DURATION_FOOTNOTE,
  TOOL_TABLE_COLUMNS,
} from './usage-report-rows';
import { toIsoDateBounds, type ReportParamsState } from './report-url';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

export function ToolAnalyticsReport({
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
      'report-tool-analytics',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchToolAnalyticsReport(repoId, {
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
      title="Tool Analytics"
      repoId={repoId}
      teamId={teamId}
      params={params}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={data != null}
      pdfFilePrefix="tool-analytics"
      kpiRows={data ? buildToolKpiRows(data) : []}
      sections={
        data
          ? [
              {
                title: 'Tools by call count',
                subtitle:
                  'Every tool_use block, including Read/Edit/Write/Glob/Skill and Task',
                columns: TOOL_TABLE_COLUMNS,
                rows: data.tools.map(buildToolTableRow),
                footnote: TOOL_DURATION_FOOTNOTE,
                emptyLabel: 'No tool activity in the selected range.',
              },
              {
                title: 'Main agent vs sub-agents',
                subtitle:
                  'The same calls split by who made them — depth 0 is the session itself',
                columns: TOOL_TABLE_COLUMNS,
                rows: [
                  ...data.mainAgent.map((row) => [
                    `main · ${row.tool}`,
                    ...buildToolTableRow(row).slice(1),
                  ]),
                  ...data.subAgent.map((row) => [
                    `sub · ${row.tool}`,
                    ...buildToolTableRow(row).slice(1),
                  ]),
                ],
                emptyLabel: 'No tool activity to split in the selected range.',
              },
              {
                title: 'MCP servers',
                subtitle: 'MCP tools rolled up per server',
                columns: MCP_TABLE_COLUMNS,
                rows: data.mcpServers.map(buildMcpTableRow),
                emptyLabel: 'No MCP tool activity in the selected range.',
              },
            ]
          : []
      }
    />
  );
}
