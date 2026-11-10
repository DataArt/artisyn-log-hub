import { AlertTriangle, X } from 'lucide-react';
import {
  budgetNoticePeriodLabel,
  budgetNoticeToneClass,
  useBudgetNotices,
} from '../hooks/useBudgetNotices';
import {
  BUDGET_LIMITS,
  budgetNoticePath,
  formatUsdMicros,
} from '../pages/budgets/budget-format';

/**
 * The global budget banner under the top nav (2026-11-05 budgets-threshold-alerts, DD-18):
 * the caller's unread notices from the `['budget-notices']` query, highest threshold first,
 * at most `BUDGET_LIMITS.bannerMax` stacked. × marks the notice read.
 */
export function BudgetNoticeBanner() {
  const { notices, markRead, openNotice } = useBudgetNotices();

  const shown = notices
    .filter((n) => !n.read)
    .sort((a, b) => b.threshold - a.threshold || b.id - a.id)
    .slice(0, BUDGET_LIMITS.bannerMax);

  if (shown.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 py-1.5 border-b border-border/40">
      {shown.map((n) => (
        <div
          key={n.id}
          role="status"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1.5 text-sm ${budgetNoticeToneClass(n.threshold)}`}
          data-testid="budget-notice-banner"
          data-threshold={n.threshold}
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">
              {n.threshold} % of {n.budgetLabel} reached
            </span>{' '}
            · {n.scopeLabel} · {formatUsdMicros(n.spendMicros)} of{' '}
            {formatUsdMicros(n.amountMicros)} · {budgetNoticePeriodLabel(n)}
          </span>
          {budgetNoticePath(n.link) !== null && (
            <button
              type="button"
              className="shrink-0 font-medium underline-offset-2 hover:underline"
              onClick={() => openNotice(n)}
              data-testid="budget-notice-open"
            >
              Open spend →
            </button>
          )}
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-black/5 disabled:opacity-50"
            onClick={() => markRead.mutate({ ids: [n.id] })}
            disabled={markRead.isPending}
            aria-label="Dismiss budget notice"
            data-testid="budget-notice-dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
