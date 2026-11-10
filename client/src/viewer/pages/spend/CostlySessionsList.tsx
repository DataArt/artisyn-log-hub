/**
 * The Spend tab costly sessions (2026-11-05 budgets-threshold-alerts, DD-7 `markCostlySessions`,
 * Visual notes): sessions at ≥ mean + 2σ (amber `2σ` pill) or ≥ mean + 3σ (red `3σ` pill), with
 * the "mean $X · σ $Y" caption. Each row links to its session; "List all" opens the modal.
 */
import { Link } from 'react-router-dom';
import type { SpendView } from '../../../models/budgets';
import { DateTime } from '../../components/DateTime';
import { formatUsdMicros } from '../budgets/budget-format';
import { spendSessionPath } from './spend-format';

interface Props {
  costly: SpendView['costlySessions'];
  onListAll: () => void;
}

const PILL: Record<2 | 3, string> = {
  2: 'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
  3: 'bg-red-50 text-red-700 ring-1 ring-red-100',
};

export function CostlySessionsList({ costly, onListAll }: Props) {
  if (costly.items.length === 0) return null;
  return (
    <div className="max-w-3xl space-y-2" data-testid="spend-costly">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-sm font-semibold">Costly sessions</h3>
        <span className="text-xs text-muted-foreground">
          mean {formatUsdMicros(costly.mean)} · σ{' '}
          {formatUsdMicros(costly.sigma)}
        </span>
        <button
          type="button"
          className="text-xs text-blue-600 hover:underline"
          onClick={onListAll}
        >
          List all
        </button>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border text-sm">
        {costly.items.map((s) => {
          const path = spendSessionPath(s);
          const level = s.level ?? 2;
          return (
            <li
              key={s.sessionId}
              className="flex items-center gap-3 px-3 py-1.5"
              data-testid="spend-costly-row"
            >
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PILL[level]}`}
              >
                {level}σ
              </span>
              <span className="w-24 shrink-0 text-right font-medium tabular-nums">
                {formatUsdMicros(s.micros)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <DateTime value={s.startTime} />
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                title={s.firstPrompt ?? ''}
              >
                {path !== null ? (
                  <Link to={path} className="text-blue-600 hover:underline">
                    {s.firstPrompt ?? s.sessionId}
                  </Link>
                ) : (
                  (s.firstPrompt ?? s.sessionId)
                )}
              </span>
              <span className="hidden max-w-48 truncate text-xs text-muted-foreground sm:inline">
                {s.userEmail}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
