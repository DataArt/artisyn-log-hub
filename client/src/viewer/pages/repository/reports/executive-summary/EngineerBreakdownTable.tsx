import { formatCost } from '@/lib/format';
import type { ExecutiveSummaryReportData } from '../../../../../models/repositories';
import { PRODUCTIVITY_METRICS } from '../../analytics/metrics';
import { formatReportDuration } from '../report-format';

interface Props {
  data: ExecutiveSummaryReportData;
}

const COST_PER_LINE_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'costPerLine',
)!.format;
const LINES_PER_HOUR_FORMAT = PRODUCTIVITY_METRICS.find(
  (m) => m.key === 'linesPerHour',
)!.format;

// On-page "Usage by Engineer" table — no Efficiency column/badge (see
// requirements.md notes.md #4); Cost/Line and Lines/Hour replace it, using
// the same PRODUCTIVITY_METRICS formatters as the report-level KPIs.
export function EngineerBreakdownTable({ data }: Props) {
  if (data.engineerBreakdown.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sessions in the selected period.
      </p>
    );
  }

  // Inline bar track: widest row's share spans the full track (per
  // wireframes/engineer-breakdown-table.svg), remaining rows scaled
  // relative to it.
  const maxShare = Math.max(...data.engineerBreakdown.map((e) => e.share));

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Engineer
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sessions
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Share of Cost
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Total Cost
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Avg Cost/Session
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Avg Work Time
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sub-agents / Session
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Cost/Line
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Lines/Hour
            </th>
          </tr>
        </thead>
        <tbody>
          {data.engineerBreakdown.map((e) => (
            <tr key={e.userEmail} className="border-t border-border">
              <td className="px-3 py-2 font-mono">{e.userEmail}</td>
              <td className="px-3 py-2 text-right">{e.sessionCount}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  <span className="h-2 w-[86px] overflow-hidden rounded-sm bg-muted">
                    <span
                      className="block h-full rounded-sm bg-[#3b82f6]"
                      style={{
                        width: `${maxShare > 0 ? (e.share / maxShare) * 100 : 0}%`,
                      }}
                      aria-hidden="true"
                    />
                  </span>
                  <span>{(e.share * 100).toFixed(0)}%</span>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-semibold">
                {formatCost(e.totalCost)}
              </td>
              <td className="px-3 py-2 text-right">
                {formatCost(e.avgCostPerSession)}
              </td>
              <td className="px-3 py-2 text-right">
                {formatReportDuration(e.avgSessionLengthMs)}
              </td>
              <td className="px-3 py-2 text-right">
                {e.subAgentsPerSession.toFixed(1)}
              </td>
              <td className="px-3 py-2 text-right">
                {e.costPerLine > 0 ? COST_PER_LINE_FORMAT(e.costPerLine) : '–'}
              </td>
              <td className="px-3 py-2 text-right">
                {e.linesPerHour > 0
                  ? LINES_PER_HOUR_FORMAT(e.linesPerHour)
                  : '–'}
              </td>
            </tr>
          ))}
          <tr className="border-t border-border bg-muted/20 font-semibold">
            <td className="px-3 py-2">Total / Avg</td>
            <td className="px-3 py-2 text-right">{data.totalSessions}</td>
            <td className="px-3 py-2 text-right">
              <div className="flex items-center justify-end gap-2">
                <span className="h-2 w-[86px] overflow-hidden rounded-sm bg-muted">
                  <span
                    className="block h-full w-full rounded-sm bg-[#93b8f9]"
                    aria-hidden="true"
                  />
                </span>
                <span>100%</span>
              </div>
            </td>
            <td className="px-3 py-2 text-right">
              {formatCost(data.totalCost)}
            </td>
            <td className="px-3 py-2 text-right">
              {formatCost(data.avgCostPerSession)}
            </td>
            <td className="px-3 py-2 text-right">
              {formatReportDuration(data.avgSessionLengthMs)}
            </td>
            <td className="px-3 py-2 text-right">
              {(
                data.engineerBreakdown.reduce(
                  (sum, e) => sum + e.subAgentsPerSession * e.sessionCount,
                  0,
                ) / Math.max(data.totalSessions, 1)
              ).toFixed(1)}
            </td>
            <td className="px-3 py-2 text-right">
              {data.totalLinesChanged > 0
                ? COST_PER_LINE_FORMAT(data.avgCostPerLine)
                : '–'}
            </td>
            <td className="px-3 py-2 text-right">
              {data.avgLinesPerHour > 0
                ? LINES_PER_HOUR_FORMAT(data.avgLinesPerHour)
                : '–'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
