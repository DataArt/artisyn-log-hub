import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatCost } from '@/lib/format';
import { fetchExecutiveSummaryReport } from '../../../../api';
import { NoPricingBadge } from '../../../../components/NoPricingBadge';
import { unpricedModelIds } from '../../../../lib/cost-hints';
import { PRODUCTIVITY_METRICS } from '../../analytics/metrics';
import { toIsoDateBounds, type ReportParamsState } from '../report-url';
import {
  formatGeneratedAt,
  formatPeriodLabel,
  formatReportDate,
  formatReportDuration,
  formatReportTokens,
} from '../report-format';
import { ReportDocumentHeader } from '../ReportDocumentHeader';
import { ReportKpiTable } from '../ReportKpiTable';
import { ReportDocumentShell } from '../ReportDocumentShell';
import { useReportHeaderMeta } from '../useReportHeaderMeta';
import { useReportPdfDownload } from '../downloadReportPdf';
import { UsageTrendChart } from './UsageTrendChart';
import { CostTrendChart } from './CostTrendChart';
import { ModelMixChart } from './ModelMixChart';
import { AvgCostPerSessionChart } from './AvgCostPerSessionChart';
import { EngineerBreakdownTable } from './EngineerBreakdownTable';
import { KpiTiles } from './KpiTiles';
import { ExecutiveSummaryLimitations } from './ExecutiveSummaryLimitations';
import { ExecutiveSummaryPdfDocument } from './pdf/ExecutiveSummaryPdfDocument';

type ModelMixBasis = 'sessions' | 'cost';

interface Props {
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  generation: number;
}

const COST_PER_LINE_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'costPerLine',
)!.format;
const LINES_PER_HOUR_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'linesPerHour',
)!.format;

export function ExecutiveSummaryReport({
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
  const [modelMixBasis, setModelMixBasis] = useState<ModelMixBasis>('sessions');

  const reportQuery = useQuery({
    queryKey: [
      'report-executive-summary',
      repoId,
      teamId,
      startDate,
      endDate,
      params.branches,
      params.users,
      generation,
    ],
    queryFn: () =>
      fetchExecutiveSummaryReport(repoId, {
        teamId,
        startDate,
        endDate,
        branches: params.branches.length > 0 ? params.branches : undefined,
        users: params.users.length > 0 ? params.users : undefined,
      }),
  });

  const data = reportQuery.data;

  // The 4 headline metrics now live exclusively in
  // <KpiTiles> above this table — keep only the 3 project-specific rows here
  // so no number is shown twice on the same page.
  const kpiRows = data
    ? [
        {
          label: 'Total Lines Changed',
          value: data.totalLinesChanged.toLocaleString(),
        },
        {
          label: 'Avg Cost / Line',
          value:
            data.totalLinesChanged > 0
              ? COST_PER_LINE_FORMAT(data.avgCostPerLine)
              : '–',
        },
        {
          label: 'Avg Lines / Hour',
          value:
            data.avgLinesPerHour > 0
              ? LINES_PER_HOUR_FORMAT(data.avgLinesPerHour)
              : '–',
        },
      ]
    : [];

  const { downloadError, handleDownload } = useReportPdfDownload(
    () =>
      ExecutiveSummaryPdfDocument({
        data: data!,
        repoUrl,
        teamName,
        periodLabel: formatPeriodLabel(params.startDate, params.endDate),
        generatedAt: formatGeneratedAt(),
      }),
    `executive-summary_${params.startDate}_${params.endDate}.pdf`,
  );

  return (
    <ReportDocumentShell
      isLoading={reportQuery.isLoading}
      error={reportQuery.error}
      onRetry={() => void reportQuery.refetch()}
      canDownload={
        data != null && !reportQuery.isFetching && !reportQuery.error
      }
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
      maxWidthClassName="max-w-[884px]"
    >
      <ReportDocumentHeader
        title="AI Usage — Executive Summary"
        dataSourceLabel="Artisyn Log Hub · Telemetry Report"
        periodAsBadge
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {data && (
        <>
          <KpiTiles data={data} />
          <ReportKpiTable rows={kpiRows} />

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section>
              <h2 className="text-sm font-semibold text-foreground">
                Usage Trend
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Sessions per week
              </p>
              <UsageTrendChart weeklyBuckets={data.weeklyBuckets} />
            </section>

            <section>
              <h2 className="text-sm font-semibold text-foreground">
                Cost Trend
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Cost per week (USD)
              </p>
              <CostTrendChart weeklyBuckets={data.weeklyBuckets} />
            </section>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section>
              <h2 className="text-sm font-semibold text-foreground">
                Avg Cost per Session — Weekly
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Average cost per session, by week
              </p>
              <AvgCostPerSessionChart weeklyBuckets={data.weeklyBuckets} />
            </section>

            <section>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    Model Mix
                  </h2>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {modelMixBasis === 'cost'
                      ? 'Share of cost by model'
                      : 'Share of sessions by model'}
                  </p>
                </div>
                <div className="flex items-center overflow-hidden rounded-md border border-border text-xs">
                  <button
                    type="button"
                    onClick={() => setModelMixBasis('sessions')}
                    className={`px-2.5 py-1 font-medium ${
                      modelMixBasis === 'sessions'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent/50'
                    }`}
                  >
                    Sessions
                  </button>
                  <button
                    type="button"
                    onClick={() => setModelMixBasis('cost')}
                    className={`border-l border-border px-2.5 py-1 font-medium ${
                      modelMixBasis === 'cost'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent/50'
                    }`}
                  >
                    Cost
                  </button>
                </div>
              </div>
              <ModelMixChart modelMix={data.modelMix} basis={modelMixBasis} />
            </section>
          </div>

          <section className="mb-6">
            <h2 className="text-sm font-semibold text-foreground">
              Usage by Engineer
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Per-engineer breakdown for the selected period
            </p>
            <EngineerBreakdownTable data={data} />
          </section>

          <section>
            <h2 className="text-sm font-semibold text-foreground">
              Top 5 Most Expensive Sessions
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Highest-cost sessions in the selected period
            </p>
            {data.topSessions.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Date
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Engineer
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Branch
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Work Time
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Cost
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Model
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Tokens (In / Out)
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Cache (Read / Write)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topSessions.map((s, i) => {
                      // Some model of this session's tree has no `model_pricing` row, so
                      // its `cost` is not a real figure. Show `$???` (and tint the row) instead of
                      // printing a number that silently omits the session's spend; the
                      // report-level limitations footnote below stays the aggregate
                      // disclosure and is unchanged.
                      const unpriced =
                        s.costUnavailableReason === 'unknown-model';
                      return (
                        <tr
                          key={`${s.startTime}-${i}`}
                          className={
                            unpriced
                              ? 'border-t border-border bg-warning/5'
                              : 'border-t border-border'
                          }
                        >
                          <td className="px-3 py-2">
                            {formatReportDate(s.startTime)}
                          </td>
                          <td className="px-3 py-2 font-mono">{s.userEmail}</td>
                          <td className="px-3 py-2 font-mono">
                            {s.branch ?? 'no branch'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatReportDuration(s.workTimeMs)}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold">
                            {unpriced ? (
                              <span className="inline-flex justify-end">
                                <NoPricingBadge
                                  modelIds={unpricedModelIds(
                                    s.unpricedModels,
                                    s.model,
                                  )}
                                />
                              </span>
                            ) : (
                              formatCost(s.cost)
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {s.model ?? 'unknown'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatReportTokens(s.inputTokens)} /{' '}
                            {formatReportTokens(s.outputTokens)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatReportTokens(s.cacheReadTokens)} /{' '}
                            {formatReportTokens(s.cacheWriteTokens)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No sessions in the selected period.
              </p>
            )}
          </section>

          <ExecutiveSummaryLimitations
            excludedSessionCount={data.excludedSessionCount}
            excludedModels={data.excludedModels}
          />
        </>
      )}
    </ReportDocumentShell>
  );
}
