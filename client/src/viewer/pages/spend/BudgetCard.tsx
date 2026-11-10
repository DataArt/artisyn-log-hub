/**
 * The Spend tab budget card (2026-11-05 budgets-threshold-alerts, spend-view.svg, Visual notes):
 * the title with the overspend-risk pill, the spend line, the banded bar with threshold ticks,
 * the "not blocked" note, four tiles, and the unpriced / OTEL-only line. Without a budget it is
 * one "Spent this <period>" line.
 */
import { AlertTriangle, Wallet } from 'lucide-react';
import type { SpendView } from '../../../models/budgets';
import {
  budgetBand,
  formatUnitsLeft,
  formatUsdMicros,
} from '../budgets/budget-format';
import {
  formatPercent,
  formatResetDate,
  SPEND_PERIOD_NOUNS,
  SPEND_PERIOD_TITLES,
} from './spend-format';

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function UnpricedLine({ view }: { view: SpendView }) {
  const parts: string[] = [];
  if (view.unpricedTrees > 0)
    parts.push(`${view.unpricedTrees} sessions unpriced`);
  if (view.otelOnlyTrees > 0) parts.push(`${view.otelOnlyTrees} OTEL-only`);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="spend-unpriced">
      {parts.join(' · ')}
    </p>
  );
}

/** The bar scale: 100 %, stretched to the highest threshold and the spend (capped at 200 %). */
function barScale(percent: number, thresholds: readonly number[]): number {
  return Math.min(200, Math.max(100, percent, ...thresholds));
}

export function BudgetCard({ view }: { view: SpendView }) {
  const budget = view.budget;
  const noun = SPEND_PERIOD_NOUNS[view.period];

  if (budget === null) {
    return (
      <div
        className="space-y-1 rounded-lg border border-border p-4"
        data-testid="budget-card"
      >
        <p className="text-sm">
          <Wallet className="mr-1.5 inline size-4 text-muted-foreground" />
          Spent {view.isCurrent ? 'this' : 'that'} {noun}{' '}
          <span
            className="font-semibold tabular-nums"
            data-testid="spend-total"
          >
            {formatUsdMicros(view.spendMicros)}
          </span>
          {view.previous !== null && (
            <span className="text-muted-foreground">
              {' '}
              · previous {formatUsdMicros(view.previous.spendMicros)}
            </span>
          )}
        </p>
        <UnpricedLine view={view} />
      </div>
    );
  }

  const forecast = view.forecast;
  const percent =
    forecast?.percentUsed ?? (view.spendMicros / budget.amountMicros) * 100;
  const band = budgetBand(percent);
  const scale = barScale(percent, budget.thresholds);
  const unitWord = forecast?.unit === 'hour' ? 'hour' : 'day';
  const elapsedWord = view.elapsedUnits === 1 ? unitWord : `${unitWord}s`;

  return (
    <div
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="budget-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Wallet className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          {SPEND_PERIOD_TITLES[budget.period]} budget ·{' '}
          {formatUsdMicros(budget.amountMicros)}
        </h3>
        {forecast?.overspendRisk && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-100"
            data-testid="spend-overspend-risk"
          >
            <AlertTriangle className="size-3" /> Overspend risk
          </span>
        )}
        {view.restricted && (
          <span className="text-xs text-muted-foreground">your own spend</span>
        )}
      </div>

      <p className="text-sm">
        <span className="font-semibold tabular-nums" data-testid="spend-total">
          {formatUsdMicros(view.spendMicros)}
        </span>{' '}
        of {formatUsdMicros(budget.amountMicros)} ·{' '}
        <span className={band.textClass} data-testid="budget-percent">
          {formatPercent(percent)}
        </span>
        <span className="text-muted-foreground">
          {' '}
          · {view.isCurrent ? 'resets on' : 'ended'}{' '}
          {formatResetDate(view.periodEnd, view.timeZone)}
        </span>
      </p>

      <div className="relative pb-4">
        <div className="h-2.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${band.barClass}`}
            style={{ width: `${Math.min(100, (percent / scale) * 100)}%` }}
          />
        </div>
        {budget.thresholds.map((t) => (
          <div
            key={t}
            className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
            style={{ left: `${(Math.min(t, scale) / scale) * 100}%` }}
          >
            <div className="h-2.5 w-px bg-foreground/50" />
            <span className="text-[10px] text-muted-foreground">{t}%</span>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Log Hub does not stop usage when the budget is reached.
      </p>

      {forecast !== null && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label="Burn rate"
            value={`${formatUsdMicros(forecast.burnRateMicrosPerUnit)}/${unitWord}`}
            sub={`${view.elapsedUnits} ${elapsedWord} elapsed`}
          />
          <Tile
            label="Forecast"
            value={formatUsdMicros(forecast.forecastMicros)}
            sub={formatPercent(
              (forecast.forecastMicros / budget.amountMicros) * 100,
            )}
          />
          <Tile
            label="Runs out in"
            value={
              view.isCurrent ? formatUnitsLeft(forecast, view.periodStart) : '—'
            }
          />
          <Tile
            label="Previous period"
            value={
              view.previous !== null
                ? formatUsdMicros(view.previous.spendMicros)
                : '—'
            }
            sub={
              view.previous?.percentOfCurrentAmount != null
                ? `${formatPercent(view.previous.percentOfCurrentAmount)} of current amount`
                : undefined
            }
          />
        </div>
      )}

      <UnpricedLine view={view} />
    </div>
  );
}
