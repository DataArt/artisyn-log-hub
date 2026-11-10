/**
 * Analytics › Budget burn (2026-11-05 budgets-threshold-alerts, DD-19, wireframe
 * `budget-burn.svg`): the cumulative spend of the budget's current period against the budget
 * line, the threshold lines, a dashed forecast to the period end, the previous period's line and
 * the anomaly days. Fed by `GET …/analytics/budget-burn` (repository-only).
 *
 * The Branches / Users filters narrow only the cumulative lines; the budget, thresholds and
 * forecast stay whole-scope, which the "filtered" label says. With no budget the view covers the
 * current calendar month in the viewer's time zone and draws the cumulative spend only.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { fetchBudgetBurn } from '../../../api';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';
import {
  browserTimeZone,
  budgetBand,
  formatUsdMicros,
} from '../../budgets/budget-format';
import {
  formatPercent,
  formatSpendBucketKey,
  formatSpendPeriodLabel,
} from '../../spend/spend-format';
import { buildBudgetBurnRows, type BudgetBurnRow } from './budget-burn-series';

const LINE_STROKE = '#3b82f6';
const PREVIOUS_STROKE = '#94a3b8';
const BUDGET_STROKE = '#ef4444';
const THRESHOLD_STROKE = '#f59e0b';
const ANOMALY_FILL = '#f59e0b';

interface Props {
  repoId: number;
  teamId?: number;
  branches: string[];
  users: string[];
}

function usd(v: number): string {
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

function BurnTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: readonly { payload?: BudgetBurnRow }[];
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-md border border-border bg-background px-2 py-1.5 text-xs shadow-sm">
      <div className="font-medium">{formatSpendBucketKey(row.key)}</div>
      {row.cumulative !== null && (
        <div className="tabular-nums">Spent ${row.cumulative.toFixed(2)}</div>
      )}
      {row.forecast !== null && row.cumulative === null && (
        <div className="tabular-nums text-muted-foreground">
          Forecast ${row.forecast.toFixed(2)}
        </div>
      )}
      {row.previous !== null && (
        <div className="tabular-nums text-muted-foreground">
          Previous period ${row.previous.toFixed(2)}
        </div>
      )}
    </div>
  );
}

export function BudgetBurnView({ repoId, teamId, branches, users }: Props) {
  const [budgetId, setBudgetId] = useState<number | undefined>(undefined);
  const tz = useMemo(() => browserTimeZone(), []);

  const query = useQuery({
    queryKey: [
      'analytics-budget-burn',
      repoId,
      teamId ?? null,
      budgetId ?? null,
      branches,
      users,
      tz,
    ],
    queryFn: ({ signal }) =>
      fetchBudgetBurn(
        repoId,
        { teamId, budgetId, branches, users, tz },
        signal,
      ),
  });

  const view = query.data;
  const timeZone = view?.budget?.timeZone ?? tz;
  const rows = useMemo(
    () => (view ? buildBudgetBurnRows(view, timeZone) : []),
    [view, timeZone],
  );

  if (query.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    );
  }
  if (query.error || !view) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : 'Failed to load the budget burn'}
        </p>
      </div>
    );
  }

  const budget = view.budget;
  const amountUsd = budget ? budget.amountMicros / 1e6 : null;
  const lastPoint = view.points[view.points.length - 1];
  const lastMicros = lastPoint?.cumulativeMicros ?? 0;
  const percent =
    budget && budget.amountMicros > 0
      ? (view.spendMicros / budget.amountMicros) * 100
      : null;
  const periodLabel = formatSpendPeriodLabel(
    budget?.period ?? 'month',
    view.periodStart,
    view.periodEnd,
    timeZone,
  );
  const rowByKey = new Map(rows.map((r) => [r.key, r]));

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {view.budgets.length > 1 && (
          <div
            className="flex items-center rounded-md border border-input"
            role="group"
            aria-label="Budget"
          >
            {view.budgets.map((b, i) => (
              <button
                key={b.id}
                type="button"
                data-testid={`budget-burn-budget-${b.period}`}
                onClick={() => setBudgetId(b.id)}
                className={cn(
                  'px-3 py-1.5 text-sm',
                  i === 0 && 'rounded-l-md',
                  i === view.budgets.length - 1 && 'rounded-r-md',
                  budget?.id === b.id
                    ? 'bg-accent font-medium'
                    : 'hover:bg-accent/50',
                )}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
        <span className="font-medium">
          {budget ? budget.label : 'No budget'} · {periodLabel}
        </span>
        <span className="text-muted-foreground">
          Spent{' '}
          <span
            className="tabular-nums text-foreground"
            data-testid="budget-burn-last"
          >
            {formatUsdMicros(lastMicros)}
          </span>
          {budget && percent !== null && (
            <>
              {' '}
              of {formatUsdMicros(budget.amountMicros)} ·{' '}
              <span className={budgetBand(percent).textClass}>
                {formatPercent(percent)}
              </span>
            </>
          )}
          {view.forecastMicros !== null && (
            <> · forecast {formatUsdMicros(view.forecastMicros)}</>
          )}
        </span>
        {view.filtered && (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-100">
            filtered — budget line is for the whole scope
          </span>
        )}
      </div>
      {!budget && (
        <p className="text-xs text-muted-foreground">
          This repository has no budget — showing the cumulative spend of the
          current month. Set a budget in Settings › Budgets.
        </p>
      )}
      <div className="flex-1 min-h-[280px]" data-testid="budget-burn-chart">
        <ChartResponsiveContainer>
          <ComposedChart
            data={rows}
            margin={{ top: 12, right: 24, bottom: 0, left: 8 }}
          >
            <CartesianGrid strokeDasharray="4 3" vertical={false} />
            <XAxis
              dataKey="key"
              tick={{ fontSize: 11 }}
              tickFormatter={formatSpendBucketKey}
              minTickGap={16}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={usd}
              width={56}
              domain={[
                0,
                (dataMax: number) =>
                  Math.max(dataMax, amountUsd ?? 0) * 1.05 || 1,
              ]}
            />
            <Tooltip content={<BurnTooltip />} />
            <Line
              dataKey="previous"
              stroke={PREVIOUS_STROKE}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              name="Previous period"
            />
            <Area
              dataKey="cumulative"
              stroke={LINE_STROKE}
              fill={LINE_STROKE}
              fillOpacity={0.15}
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
              name="Spent"
            />
            <Line
              dataKey="forecast"
              stroke={LINE_STROKE}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              name="Forecast"
            />
            {budget &&
              amountUsd !== null &&
              budget.thresholds
                .filter((t) => t !== 100)
                .map((t) => (
                  <ReferenceLine
                    key={t}
                    y={(amountUsd * t) / 100}
                    stroke={THRESHOLD_STROKE}
                    strokeDasharray="2 4"
                    label={{
                      value: `${t} %`,
                      position: 'insideTopLeft',
                      fontSize: 10,
                      fill: THRESHOLD_STROKE,
                    }}
                  />
                ))}
            {amountUsd !== null && (
              <ReferenceLine
                y={amountUsd}
                stroke={BUDGET_STROKE}
                strokeWidth={1.5}
                label={{
                  value: `budget ${usd(amountUsd)}`,
                  position: 'insideTopRight',
                  fontSize: 10,
                  fill: BUDGET_STROKE,
                }}
              />
            )}
            {view.anomalyKeys.map((key) => {
              const y = rowByKey.get(key)?.cumulative;
              if (y === null || y === undefined) return null;
              return (
                <ReferenceDot
                  key={key}
                  x={key}
                  y={y}
                  r={5}
                  fill={ANOMALY_FILL}
                  stroke="#ffffff"
                />
              );
            })}
          </ComposedChart>
        </ChartResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 align-middle bg-[#3b82f6]" />
          cumulative spend
        </span>
        {view.forecastMicros !== null && (
          <span>
            <span className="mr-1 inline-block w-4 align-middle border-t-2 border-dashed border-[#3b82f6]" />
            forecast
          </span>
        )}
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 align-middle bg-[#94a3b8]" />
          previous period
        </span>
        {view.anomalyKeys.length > 0 && (
          <span>
            <span className="mr-1 inline-block size-2 rounded-full align-middle bg-[#f59e0b]" />
            anomaly day (≥ 2× the average)
          </span>
        )}
      </div>
    </div>
  );
}
