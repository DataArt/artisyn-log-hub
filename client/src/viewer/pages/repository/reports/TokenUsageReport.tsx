/**
 * "Token Usage" report — input/output/cache-read/cache-creation totals with the
 * `ephemeral_5m` vs `ephemeral_1h` TTL split reported separately, plus the `service_tier`
 * breakdown (including the `unknown` bucket) and a per-UTC-day table.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchTokenUsageReport } from '../../../api';
import { UsageReportDocument } from './UsageReportDocument';
import {
  buildTokenKpiRows,
  buildTokenTableRow,
  TOKEN_FOOTNOTE,
  TOKEN_TABLE_COLUMNS,
} from './usage-report-rows';
import { toIsoDateBounds, type ReportParamsState } from './report-url';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

export function TokenUsageReport({
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
      'report-token-usage',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchTokenUsageReport(repoId, {
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
      title="Token Usage"
      repoId={repoId}
      teamId={teamId}
      params={params}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={data != null}
      pdfFilePrefix="token-usage"
      kpiRows={data ? buildTokenKpiRows(data) : []}
      sections={
        data
          ? [
              {
                title: 'By service tier',
                subtitle:
                  'Messages with no service_tier field are grouped under "unknown"',
                columns: TOKEN_TABLE_COLUMNS,
                rows: data.byServiceTier.map((tier) =>
                  buildTokenTableRow(tier.tier, tier),
                ),
                footnote: TOKEN_FOOTNOTE,
                emptyLabel: 'No token activity in the selected range.',
              },
              {
                title: 'By day',
                subtitle: 'Per UTC day, keyed on each session’s start time',
                columns: TOKEN_TABLE_COLUMNS,
                rows: data.buckets.map((bucket) =>
                  buildTokenTableRow(bucket.bucket, bucket),
                ),
                emptyLabel: 'No daily token activity in the selected range.',
              },
            ]
          : []
      }
    />
  );
}
