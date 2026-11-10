/**
 * The "Budget event log" window of a scope (2026-11-05 budgets-threshold-alerts, FR-10,
 * budget-settings.svg): newest first, Budget / Event filters, "Load older events" paging on
 * `nextBefore`, deleted budgets kept with a "(deleted)" suffix. Times are in the browser zone.
 */
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { BudgetDto } from '../../../models/budgets';
import { ApiError, fetchBudgetEvents, type BudgetScopeRef } from '../../api';
import { DateTime } from '../../components/DateTime';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { BUDGET_LIMITS } from './budget-format';
import {
  BUDGET_EVENT_LABELS,
  BUDGET_EVENT_TYPES,
  budgetEventDetails,
  budgetEventLabel,
} from './budget-event-format';

const SELECT_CLASS =
  'h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

interface Props {
  scope: BudgetScopeRef;
  /** Stable key of the scope, part of the query key. */
  scopeKey: string;
  /** The scope's current budgets, for the Budget filter. */
  budgets: BudgetDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BudgetEventLog({
  scope,
  scopeKey,
  budgets,
  open,
  onOpenChange,
}: Props) {
  const [budgetId, setBudgetId] = useState<number | undefined>(undefined);
  const [event, setEvent] = useState<string>('');

  const query = useInfiniteQuery({
    queryKey: ['budget-events', scopeKey, budgetId ?? null, event],
    queryFn: ({ pageParam }) =>
      fetchBudgetEvents(scope, {
        budgetId,
        event: event || undefined,
        before: pageParam,
        limit: BUDGET_LIMITS.eventsPage.default,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: open,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const noAccess =
    query.error instanceof ApiError && query.error.statusCode === 403;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-5xl flex-col sm:max-w-5xl"
        data-testid="budget-event-log"
      >
        <DialogHeader>
          <DialogTitle>Budget event log</DialogTitle>
          <DialogDescription>
            Newest first · includes deleted budgets · times in your browser time
            zone
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Budget</span>
            <select
              className={SELECT_CLASS}
              value={budgetId ?? ''}
              onChange={(e) =>
                setBudgetId(
                  e.target.value === '' ? undefined : Number(e.target.value),
                )
              }
              data-testid="budget-event-filter-budget"
            >
              <option value="">All budgets</option>
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Event</span>
            <select
              className={SELECT_CLASS}
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              data-testid="budget-event-filter-event"
            >
              <option value="">All events</option>
              {BUDGET_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BUDGET_EVENT_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {query.isLoading && (
            <div className="flex items-center gap-2 py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {query.isError && (
            <p className="py-4 text-sm text-destructive">
              {noAccess ? 'No access' : 'Error'}
            </p>
          )}
          {query.isSuccess && items.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">No events yet.</p>
          )}
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">Actor</th>
                  <th className="py-2 pr-4 font-medium">Budget</th>
                  <th className="py-2 pr-4 font-medium">Event</th>
                  <th className="py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-border/60 align-top"
                    data-testid="budget-event-row"
                    data-event-type={e.eventType}
                  >
                    <td className="whitespace-nowrap py-2 pr-4 tabular-nums">
                      <DateTime value={e.createdAt} />
                    </td>
                    <td className="py-2 pr-4">
                      {e.actorEmail ?? (
                        <span className="text-muted-foreground">
                          system · threshold job
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4">
                      {e.budgetLabel}
                      {e.budgetDeleted && (
                        <span className="text-muted-foreground">
                          {' '}
                          (deleted)
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4">
                      {budgetEventLabel(e.eventType)}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {budgetEventDetails(e.eventType, e.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {query.hasNextPage && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              data-testid="budget-event-load-older"
            >
              {query.isFetchingNextPage && <Loader2 className="animate-spin" />}
              Load older events
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
