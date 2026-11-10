/**
 * The root sessions behind a Spend tab slice row, a day bar or the costly list
 * (2026-11-05 budgets-threshold-alerts, DD-20): a viewport-safe modal fed by
 * `GET …/spend/sessions`, each row linking to the session in its repository view.
 */
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BudgetPeriod, SpendSessionsSlice } from '../../../models/budgets';
import { ApiError, fetchSpendSessions, type BudgetScopeRef } from '../../api';
import { DateTime } from '../../components/DateTime';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { formatUsdMicros } from '../budgets/budget-format';
import { spendSessionPath } from './spend-format';

/** What the modal lists: a slice kind (or `day` / `costly`) and its row key. */
export interface SpendSessionsTarget {
  slice: SpendSessionsSlice;
  key: string;
  /** The modal heading, e.g. `Model · claude-opus-4`. */
  title: string;
}

interface Props {
  scope: BudgetScopeRef;
  scopeKey: string;
  period: BudgetPeriod;
  offset: number;
  tz: string;
  target: SpendSessionsTarget | null;
  onClose: () => void;
}

export function SpendSessionsModal({
  scope,
  scopeKey,
  period,
  offset,
  tz,
  target,
  onClose,
}: Props) {
  const query = useQuery({
    queryKey: [
      'spend-sessions',
      scopeKey,
      period,
      offset,
      tz,
      target?.slice,
      target?.key,
    ],
    queryFn: ({ signal }) =>
      fetchSpendSessions(
        scope,
        {
          period,
          offset,
          tz,
          slice: target!.slice,
          key: target!.key,
        },
        signal,
      ),
    enabled: target !== null,
    staleTime: 60_000,
  });

  const forbidden =
    query.error instanceof ApiError && query.error.statusCode === 403;

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-3 overflow-hidden"
        data-testid="spend-sessions-modal"
      >
        <DialogHeader>
          <DialogTitle>{target?.title ?? 'Sessions'}</DialogTitle>
          <DialogDescription>
            Root sessions of the period, costliest first. Costs include
            sub-agents.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {query.isLoading ? (
            <div className="flex justify-center p-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : forbidden ? (
            <p className="p-4 text-sm text-muted-foreground">No access</p>
          ) : query.isError ? (
            <p className="p-4 text-sm text-red-700">
              Could not load the sessions.
            </p>
          ) : (query.data?.sessions.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No sessions.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Start</th>
                  <th className="py-2 pr-3 font-medium">User</th>
                  <th className="py-2 pr-3 font-medium">Branch</th>
                  <th className="py-2 pr-3 text-right font-medium">Cost</th>
                  <th className="py-2 font-medium">First prompt</th>
                </tr>
              </thead>
              <tbody>
                {query.data?.sessions.map((s) => {
                  const path = spendSessionPath(s);
                  return (
                    <tr
                      key={s.sessionId}
                      className="border-t border-border align-top"
                      data-testid="spend-session-row"
                    >
                      <td className="whitespace-nowrap py-2 pr-3">
                        {path !== null ? (
                          <Link
                            to={path}
                            onClick={onClose}
                            className="text-blue-600 hover:underline"
                          >
                            <DateTime value={s.startTime} />
                          </Link>
                        ) : (
                          <DateTime value={s.startTime} />
                        )}
                      </td>
                      <td
                        className="max-w-40 truncate py-2 pr-3"
                        title={s.userEmail}
                      >
                        {s.userEmail}
                      </td>
                      <td
                        className="max-w-32 truncate py-2 pr-3"
                        title={s.branch ?? ''}
                      >
                        {s.branch ?? (
                          <span className="text-muted-foreground">
                            no branch
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">
                        {s.source === 'none' ? (
                          <span className="text-muted-foreground">
                            unpriced
                          </span>
                        ) : (
                          formatUsdMicros(s.micros)
                        )}
                      </td>
                      <td
                        className="max-w-72 truncate py-2"
                        title={s.firstPrompt ?? ''}
                      >
                        {s.firstPrompt ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {query.data?.truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the {query.data.sessions.length} costliest sessions.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
