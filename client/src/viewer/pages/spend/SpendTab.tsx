/**
 * The Spend tab of a repository (personal or team) and of a team page
 * (2026-11-05 budgets-threshold-alerts, FR-3 / FR-4 / FR-7, DD-9 / DD-15 / DD-16 / DD-20,
 * spend-view.svg): the period picker with ‹ › (URL `sp` / `so`), the budget card, the daily
 * chart, the cost slices and the costly sessions. Every member sees it; a plain member of a
 * restricted team gets the DD-9 view (own spend only, no breakdowns).
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { BudgetPeriod } from '../../../models/budgets';
import { ApiError, fetchSpend, type BudgetScopeRef } from '../../api';
import { cn } from '@/lib/cn';
import { BUDGET_PERIOD_LABELS } from '../budgets/budget-event-format';
import { budgetScopeKey } from '../budgets/BudgetsSection';
import {
  BUDGET_LIMITS,
  browserTimeZone,
  formatUsdMicros,
} from '../budgets/budget-format';
import { BudgetCard } from './BudgetCard';
import { CostlySessionsList } from './CostlySessionsList';
import { DailySpendChart } from './DailySpendChart';
import { SliceTable } from './SliceTable';
import {
  SpendSessionsModal,
  type SpendSessionsTarget,
} from './SpendSessionsModal';
import {
  formatSpendBucketKey,
  formatSpendPeriodLabel,
  SPEND_PERIOD_NOUNS,
  SPEND_SLICE_LABELS,
} from './spend-format';
import { useSpendUrlState } from './useSpendUrlState';

const PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month'];

interface Props {
  scope: BudgetScopeRef;
}

export function SpendTab({ scope }: Props) {
  const scopeKey = budgetScopeKey(scope);
  const { period, offset, setPeriod, setOffset } = useSpendUrlState();
  const [searchParams, setSearchParams] = useSearchParams();
  const [target, setTarget] = useState<SpendSessionsTarget | null>(null);
  const tz = browserTimeZone();

  // Same key shape as the Budgets section's current-period cell, so both share the cache.
  const query = useQuery({
    queryKey: ['spend', scopeKey, period, offset, tz],
    queryFn: ({ signal }) => fetchSpend(scope, { period, offset, tz }, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const view = query.data;

  function openBudgetSettings() {
    const next = new URLSearchParams(searchParams);
    for (const key of ['sp', 'so', 'ssl']) next.delete(key);
    if ('repoId' in scope) {
      next.set('mtab', 'settings');
      next.set('stab', 'budgets');
    } else {
      next.set('ttab', 'settings');
    }
    setSearchParams(next, { replace: true });
  }

  const forbidden =
    query.error instanceof ApiError && query.error.statusCode === 403;

  return (
    <div
      className="h-full space-y-4 overflow-y-auto p-4"
      data-testid="spend-tab"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                'rounded px-2.5 py-0.5 text-xs transition-colors',
                p === period
                  ? 'bg-blue-600 text-white'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
              aria-pressed={p === period}
              data-testid={`spend-period-${p}`}
            >
              {BUDGET_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOffset(offset - 1)}
            disabled={offset <= BUDGET_LIMITS.minOffset}
            className="rounded border border-border p-0.5 text-muted-foreground hover:bg-accent/50 disabled:opacity-40"
            title={`Previous ${SPEND_PERIOD_NOUNS[period]}`}
            data-testid="spend-prev"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setOffset(offset + 1)}
            disabled={offset >= 0}
            className="rounded border border-border p-0.5 text-muted-foreground hover:bg-accent/50 disabled:opacity-40"
            title={`Next ${SPEND_PERIOD_NOUNS[period]}`}
            data-testid="spend-next"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <span className="text-sm font-medium" data-testid="spend-period-label">
          {view
            ? formatSpendPeriodLabel(
                view.period,
                view.periodStart,
                view.periodEnd,
                view.timeZone,
              )
            : ''}
        </span>
        {query.isFetching && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
        {view?.canManage && (
          <button
            type="button"
            onClick={openBudgetSettings}
            className="ml-4 text-xs text-blue-600 hover:underline"
            data-testid="spend-manage-budgets"
          >
            Manage budgets in Settings →
          </button>
        )}
      </div>

      {forbidden ? (
        <p className="text-sm text-muted-foreground">No access</p>
      ) : query.isError ? (
        <p className="text-sm text-red-700">Could not load the spend.</p>
      ) : !view ? (
        <div className="flex justify-center p-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : view.restricted ? (
        <div className="max-w-4xl space-y-3">
          {view.budget !== null ? (
            <BudgetCard view={view} />
          ) : (
            <p className="text-sm" data-testid="spend-restricted">
              Your own spend this {SPEND_PERIOD_NOUNS[view.period]}:{' '}
              <span
                className="font-semibold tabular-nums"
                data-testid="spend-total"
              >
                {formatUsdMicros(view.spendMicros)}
              </span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Team-wide spend and breakdowns are visible to the team owner,
            managers and members with team analytics access.
          </p>
        </div>
      ) : (
        <div className="max-w-5xl space-y-6">
          <BudgetCard view={view} />
          <section className="space-y-1">
            <h3 className="text-sm font-semibold">
              {view.period === 'day' ? 'Hourly spend' : 'Daily spend'}
            </h3>
            <DailySpendChart
              daily={view.daily}
              paceMicros={
                view.budget !== null && view.totalUnits > 0
                  ? view.budget.amountMicros / view.totalUnits
                  : null
              }
              onBucketClick={(b) =>
                setTarget({
                  slice: 'day',
                  key: b.key,
                  title: `Sessions · ${formatSpendBucketKey(b.key)}`,
                })
              }
            />
          </section>
          <SliceTable
            slices={view.slices}
            spendMicros={view.spendMicros}
            sessions={view.sessions}
            restricted={view.restricted}
            onRowClick={(kind, key, label) =>
              setTarget({
                slice: kind,
                key,
                title: `${SPEND_SLICE_LABELS[kind]} · ${label}`,
              })
            }
          />
          <CostlySessionsList
            costly={view.costlySessions}
            onListAll={() =>
              setTarget({
                slice: 'costly',
                key: 'all',
                title: 'Costly sessions',
              })
            }
          />
        </div>
      )}

      <SpendSessionsModal
        scope={scope}
        scopeKey={scopeKey}
        period={period}
        offset={offset}
        tz={tz}
        target={target}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}
