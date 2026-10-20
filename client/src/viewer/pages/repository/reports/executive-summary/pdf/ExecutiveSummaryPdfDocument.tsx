import { Document, Page, Text, View } from '@react-pdf/renderer';
import { formatCost } from '@/lib/format';
import type { ExecutiveSummaryReportData } from '../../../../../../models/repositories';
import { PRODUCTIVITY_METRICS } from '../../../analytics/metrics';
import {
  formatReportDate,
  formatReportDuration,
  formatReportTokens,
} from '../../report-format';
import { pdfStyles } from '../../pdf/pdfStyles';
import { TablePdf } from '../../pdf/TablePdf';
import { UsageTrendChartPdf } from './UsageTrendChartPdf';
import { CostTrendChartPdf } from './CostTrendChartPdf';
import { ModelMixChartPdf } from './ModelMixChartPdf';
import { AvgCostPerSessionChartPdf } from './AvgCostPerSessionChartPdf';
import { ExecutiveSummaryLimitationsPdf } from './ExecutiveSummaryLimitationsPdf';

export interface ExecutiveSummaryPdfProps {
  data: ExecutiveSummaryReportData;
  repoUrl: string;
  teamName: string | null;
  periodLabel: string;
  generatedAt: string;
}

const COST_PER_LINE_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'costPerLine',
)!.format;
const LINES_PER_HOUR_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'linesPerHour',
)!.format;

// PDF counterpart of ExecutiveSummaryReport.tsx — built from @react-pdf/renderer
// primitives fed the same ExecutiveSummaryReportData, not a screenshot of the
// on-page DOM.
export function ExecutiveSummaryPdfDocument({
  data,
  repoUrl,
  teamName,
  periodLabel,
  generatedAt,
}: ExecutiveSummaryPdfProps) {
  return (
    <Document>
      <Page size="A4" style={pdfStyles.page}>
        <View style={pdfStyles.headerRow}>
          <Text style={pdfStyles.title}>AI Usage — Executive Summary</Text>
          <Text style={pdfStyles.meta}>Generated on {generatedAt} UTC</Text>
        </View>
        <Text style={pdfStyles.meta}>Artisyn Log Hub · Telemetry Report</Text>
        <Text style={pdfStyles.meta}>
          {repoUrl}
          {teamName ? ` · ${teamName}` : ''}
        </Text>
        <Text style={pdfStyles.meta}>Period: {periodLabel}</Text>
        <View style={pdfStyles.divider} />

        <View style={pdfStyles.table}>
          <View style={pdfStyles.tableHeaderRow}>
            <Text style={pdfStyles.headerCell}>METRIC</Text>
            <Text style={[pdfStyles.headerCell, { textAlign: 'right' }]}>
              VALUE
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Total AI Cost</Text>
            <Text style={pdfStyles.valueCell}>
              {formatCost(data.totalCost)}
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Total Sessions</Text>
            <Text style={pdfStyles.valueCell}>{data.totalSessions}</Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Active Users / Team Size</Text>
            <Text style={pdfStyles.valueCell}>
              {data.teamSize != null
                ? `${data.activeUsers} of ${data.teamSize}`
                : data.activeUsers}
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Avg Cost / Session</Text>
            <Text style={pdfStyles.valueCell}>
              {formatCost(data.avgCostPerSession)}
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Total Lines Changed</Text>
            <Text style={pdfStyles.valueCell}>
              {data.totalLinesChanged.toLocaleString()}
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Avg Cost / Line</Text>
            <Text style={pdfStyles.valueCell}>
              {data.totalLinesChanged > 0
                ? COST_PER_LINE_FORMAT(data.avgCostPerLine)
                : '–'}
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <Text style={pdfStyles.metricCell}>Avg Lines / Hour</Text>
            <Text style={pdfStyles.valueCell}>
              {data.avgLinesPerHour > 0
                ? LINES_PER_HOUR_FORMAT(data.avgLinesPerHour)
                : '–'}
            </Text>
          </View>
          {/* Sibling rows mirroring KpiTiles.tsx's
              Advisor Spend / Attribute Extraction Spend tiles — two separate rows, never
              merged into one figure, both outside Total AI Cost above. */}
          <View style={pdfStyles.tableRow}>
            <View style={pdfStyles.metricCell}>
              <Text>Advisor Spend</Text>
              <Text style={pdfStyles.meta}>
                {data.advisorSpend.evaluationCount.toLocaleString()} turns ·{' '}
                {data.advisorSpend.distinctInvokingSessions.toLocaleString()}{' '}
                sessions · outside Total AI Cost
              </Text>
            </View>
            <Text style={pdfStyles.valueCell}>
              {formatCost(data.advisorSpend.costUsd)}
            </Text>
          </View>
          <View style={pdfStyles.tableRow}>
            <View style={pdfStyles.metricCell}>
              <Text>Attribute Extraction Spend</Text>
              <Text style={pdfStyles.meta}>
                {data.attributionSpend.evaluationCount.toLocaleString()} evals ·{' '}
                {data.attributionSpend.distinctInvokingSessions.toLocaleString()}{' '}
                sessions · outside Total AI Cost
              </Text>
            </View>
            <Text style={pdfStyles.valueCell}>
              {formatCost(data.attributionSpend.costUsd)}
            </Text>
          </View>
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Usage Trend</Text>
          <Text style={pdfStyles.sectionSubtitle}>Sessions per week</Text>
          <UsageTrendChartPdf weeklyBuckets={data.weeklyBuckets} />
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Cost Trend</Text>
          <Text style={pdfStyles.sectionSubtitle}>Cost per week (USD)</Text>
          <CostTrendChartPdf weeklyBuckets={data.weeklyBuckets} />
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Model Mix</Text>
          <Text style={pdfStyles.sectionSubtitle}>
            Share of sessions by model
          </Text>
          <ModelMixChartPdf modelMix={data.modelMix} />
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>
            Avg Cost per Session — Weekly
          </Text>
          <Text style={pdfStyles.sectionSubtitle}>
            Average cost per session, by week
          </Text>
          <AvgCostPerSessionChartPdf weeklyBuckets={data.weeklyBuckets} />
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Usage by Engineer</Text>
          <Text style={pdfStyles.sectionSubtitle}>
            Per-engineer breakdown for the selected period
          </Text>
          {data.engineerBreakdown.length > 0 ? (
            <TablePdf
              columns={[
                'Engineer',
                'Sessions',
                'Share',
                'Total Cost',
                'Avg Cost/Session',
                'Avg Work Time',
                'Sub-agents / Session',
                'Cost/Line',
                'Lines/Hour',
              ]}
              rows={[
                ...data.engineerBreakdown.map((e) => [
                  e.userEmail,
                  String(e.sessionCount),
                  `${(e.share * 100).toFixed(0)}%`,
                  formatCost(e.totalCost),
                  formatCost(e.avgCostPerSession),
                  formatReportDuration(e.avgSessionLengthMs),
                  e.subAgentsPerSession.toFixed(1),
                  e.costPerLine > 0 ? COST_PER_LINE_FORMAT(e.costPerLine) : '–',
                  e.linesPerHour > 0
                    ? LINES_PER_HOUR_FORMAT(e.linesPerHour)
                    : '–',
                ]),
                [
                  'Total / Avg',
                  String(data.totalSessions),
                  '100%',
                  formatCost(data.totalCost),
                  formatCost(data.avgCostPerSession),
                  formatReportDuration(data.avgSessionLengthMs),
                  (
                    data.engineerBreakdown.reduce(
                      (sum, e) => sum + e.subAgentsPerSession * e.sessionCount,
                      0,
                    ) / Math.max(data.totalSessions, 1)
                  ).toFixed(1),
                  data.totalLinesChanged > 0
                    ? COST_PER_LINE_FORMAT(data.avgCostPerLine)
                    : '–',
                  data.avgLinesPerHour > 0
                    ? LINES_PER_HOUR_FORMAT(data.avgLinesPerHour)
                    : '–',
                ],
              ]}
            />
          ) : (
            <Text style={pdfStyles.meta}>
              No sessions in the selected period.
            </Text>
          )}
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>
            Top 5 Most Expensive Sessions
          </Text>
          <Text style={pdfStyles.sectionSubtitle}>
            Highest-cost sessions in the selected period
          </Text>
          {data.topSessions.length > 0 ? (
            <TablePdf
              columns={[
                'Date',
                'Engineer',
                'Branch',
                'Work Time',
                'Cost',
                'Model',
                'Tokens (In/Out)',
                'Cache (Read/Write)',
              ]}
              rows={data.topSessions.map((s) => [
                formatReportDate(s.startTime),
                s.userEmail,
                s.branch ?? 'no branch',
                formatReportDuration(s.workTimeMs),
                // An unpriced row must not print a cost that omits this session's
                // spend. The PDF's built-in Helvetica has no U+26A0 glyph, so the amber
                // pill degrades here to the tinted row (below) plus this literal.
                s.costUnavailableReason === 'unknown-model'
                  ? 'no pricing'
                  : formatCost(s.cost),
                s.model ?? 'unknown',
                `${formatReportTokens(s.inputTokens)} / ${formatReportTokens(s.outputTokens)}`,
                `${formatReportTokens(s.cacheReadTokens)} / ${formatReportTokens(s.cacheWriteTokens)}`,
              ])}
              highlightRows={data.topSessions.map(
                (s) => s.costUnavailableReason === 'unknown-model',
              )}
            />
          ) : (
            <Text style={pdfStyles.meta}>
              No sessions in the selected period.
            </Text>
          )}
        </View>

        <ExecutiveSummaryLimitationsPdf
          excludedSessionCount={data.excludedSessionCount}
          excludedModels={data.excludedModels}
        />
      </Page>
    </Document>
  );
}
