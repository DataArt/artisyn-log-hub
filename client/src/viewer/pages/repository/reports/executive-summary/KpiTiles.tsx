import { formatCost } from '@/lib/format';
import type { ExecutiveSummaryReportData } from '../../../../../models/repositories';

interface Props {
  data: ExecutiveSummaryReportData;
}

// Delta vs. the equal-length preceding window —
// Math.round((current - previous) / previous * 100). `null` return means
// "suppress this tile's pill" — either because there is no previous-period
// data at all, or because this specific metric's
// previous value was exactly 0 (would otherwise divide by zero / show
// "+Infinity%").
function computeDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

interface KpiTileProps {
  label: string;
  value: string;
  subLine?: string;
  delta: number | null;
  accentClassName: string;
  valueClassName?: string;
}

// One headline tile — colour-accented left border, delta pill top-right
// (arrow glyph conveys direction, not colour), value, optional sub-line. The
// pill renders as an empty dashed outline rather than being omitted when
// suppressed, so every tile stays the same height (see
// wireframes/kpi-tiles.svg).
function KpiTile({
  label,
  value,
  subLine,
  delta,
  accentClassName,
  valueClassName,
}: KpiTileProps) {
  return (
    <div className="relative overflow-hidden rounded-md border border-border bg-background p-3 pl-4">
      <span
        className={`absolute inset-y-0 left-0 w-1 ${accentClassName}`}
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {delta === null ? (
          <span
            className="inline-flex h-[18px] min-w-[46px] shrink-0 items-center justify-center rounded-full border border-dashed border-border"
            aria-hidden="true"
          />
        ) : (
          <span className="inline-flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-border bg-muted/40 px-2 text-[10px] font-semibold text-foreground">
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
      <p
        className={`mt-2 text-lg font-bold ${valueClassName ?? 'text-foreground'}`}
      >
        {value}
      </p>
      {subLine && (
        <p className="mt-1 text-[11px] text-muted-foreground">{subLine}</p>
      )}
    </div>
  );
}

// Headline KPI tiles above the existing on-page ReportKpiTable (guide §3
// order: Total AI Cost, Total Sessions, Active Users / Team Size, Avg Cost
// per Session), plus two sibling tiles — Advisor Spend and
// Attribute Extraction Spend — that sit alongside Total AI Cost rather than
// inside it, never merged into one figure. PDF export
// keeps the KPI block as a table — no tile grid there.
export function KpiTiles({ data }: Props) {
  const previous = data.previousPeriod;

  const costDelta = previous
    ? computeDelta(data.totalCost, previous.totalCost)
    : null;
  const sessionsDelta = previous
    ? computeDelta(data.totalSessions, previous.totalSessions)
    : null;
  const activeUsersDelta = previous
    ? computeDelta(data.activeUsers, previous.activeUsers)
    : null;
  const avgCostDelta = previous
    ? computeDelta(data.avgCostPerSession, previous.avgCostPerSession)
    : null;

  // Adoption % = round(activeUsers / teamSize * 100),
  // shown only in a team-scoped view (teamSize non-null); omitted entirely
  // — no suffix, no "0%" — in a personal-repo view.
  const adoptionPct =
    data.teamSize != null && data.teamSize > 0
      ? Math.round((data.activeUsers / data.teamSize) * 100)
      : null;

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiTile
        label="Total AI Cost"
        value={formatCost(data.totalCost)}
        subLine={
          previous
            ? `vs ${formatCost(previous.totalCost)} previous period`
            : undefined
        }
        delta={costDelta}
        accentClassName="bg-green-600 dark:bg-green-400"
        valueClassName="text-green-700 dark:text-green-400"
      />
      <KpiTile
        label="Total Sessions"
        value={data.totalSessions.toLocaleString()}
        subLine={
          previous
            ? `vs ${previous.totalSessions.toLocaleString()} previous period`
            : undefined
        }
        delta={sessionsDelta}
        accentClassName="bg-blue-500 dark:bg-blue-400"
      />
      <KpiTile
        label="Active Users / Team Size"
        value={
          data.teamSize != null
            ? `${data.activeUsers} of ${data.teamSize}`
            : String(data.activeUsers)
        }
        subLine={
          adoptionPct != null ? `${adoptionPct}% adoption rate` : undefined
        }
        delta={activeUsersDelta}
        accentClassName="bg-violet-500 dark:bg-violet-400"
      />
      <KpiTile
        label="Avg Cost / Session"
        value={formatCost(data.avgCostPerSession)}
        subLine={
          previous
            ? `vs ${formatCost(previous.avgCostPerSession)} previous period`
            : undefined
        }
        delta={avgCostDelta}
        accentClassName="bg-orange-500 dark:bg-orange-400"
      />
      {/* Sibling tile, never inside Total AI Cost — no
          previous-period comparison exists for this figure, so the delta pill always
          renders as the suppressed dashed placeholder. */}
      <KpiTile
        label="Advisor Spend"
        value={formatCost(data.advisorSpend.costUsd)}
        subLine={`${data.advisorSpend.evaluationCount.toLocaleString()} turns · ${data.advisorSpend.distinctInvokingSessions.toLocaleString()} sessions · outside Total AI Cost`}
        delta={null}
        accentClassName="bg-cyan-600 dark:bg-cyan-400"
      />
      {/* Sibling tile beside Advisor Spend, never
          merged into one figure. */}
      <KpiTile
        label="Attribute Extraction Spend"
        value={formatCost(data.attributionSpend.costUsd)}
        subLine={`${data.attributionSpend.evaluationCount.toLocaleString()} evals · ${data.attributionSpend.distinctInvokingSessions.toLocaleString()} sessions · outside Total AI Cost`}
        delta={null}
        accentClassName="bg-rose-500 dark:bg-rose-400"
      />
    </div>
  );
}
