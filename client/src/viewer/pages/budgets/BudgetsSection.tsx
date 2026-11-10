/**
 * Settings › Budgets of a scope — a personal repository, a team repository or a whole team
 * (2026-11-05 budgets-threshold-alerts, FR-1 / FR-7, DD-17, budget-form.svg): the budget table,
 * "+ Add budget" with the inline form, the "Budget event log" window, read-only mode for a
 * viewer who cannot manage, and a note instead of everything for a plain member (403).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type {
  BudgetDto,
  BudgetPeriod,
  BudgetScopeKind,
} from '../../../models/budgets';
import {
  ApiError,
  deleteBudget,
  fetchBudgets,
  fetchSpend,
  type BudgetScopeRef,
} from '../../api';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { browserTimeZone, budgetBand, formatUsdMicros } from './budget-format';
import { BUDGET_PERIOD_LABELS } from './budget-event-format';
import { BudgetEventLog } from './BudgetEventLog';
import { BudgetForm, invalidateBudgetQueries } from './BudgetForm';

const PERIOD_ORDER: BudgetPeriod[] = ['month', 'week', 'day'];

/** A stable query-key part of a budget scope. */
export function budgetScopeKey(scope: BudgetScopeRef): string {
  if ('repoId' in scope) {
    return scope.teamId != null
      ? `team-repo:${scope.teamId}:${scope.repoId}`
      : `repo:${scope.repoId}`;
  }
  return `team:${scope.teamId}`;
}

function scopeKindOf(scope: BudgetScopeRef): BudgetScopeKind {
  if ('repoId' in scope) return scope.teamId != null ? 'team-repo' : 'repo';
  return 'team';
}

type Editing = { mode: 'add' } | { mode: 'edit'; id: number } | null;

const TH = 'py-2 pr-4 font-medium';
const TD = 'py-2 pr-4 align-top';

/** "$151.00 · 50 %" of the budget's current period; a click opens the Spend tab. */
function CurrentPeriodCell({
  scope,
  scopeKey,
  budget,
}: {
  scope: BudgetScopeRef;
  scopeKey: string;
  budget: BudgetDto;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tz = browserTimeZone();
  const spend = useQuery({
    queryKey: ['spend', scopeKey, budget.period, 0, tz],
    queryFn: ({ signal }) =>
      fetchSpend(scope, { period: budget.period, offset: 0, tz }, signal),
    staleTime: 60_000,
  });

  function openSpend() {
    const next = new URLSearchParams(searchParams);
    if ('repoId' in scope) {
      next.set('mtab', 'spend');
      next.delete('stab');
    } else {
      next.set('ttab', 'spend');
    }
    next.set('sp', budget.period);
    next.set('so', '0');
    setSearchParams(next, { replace: true });
  }

  const percent = spend.data?.forecast?.percentUsed ?? null;
  return (
    <button
      type="button"
      className="text-left hover:underline"
      onClick={openSpend}
      title="Open the Spend view"
    >
      {spend.data ? (
        <>
          {formatUsdMicros(spend.data.spendMicros)}
          {percent !== null && (
            <span className={budgetBand(percent).textClass}>
              {' '}
              · {Math.round(percent)} %
            </span>
          )}
        </>
      ) : spend.isError ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      )}
    </button>
  );
}

interface Props {
  scope: BudgetScopeRef;
}

export function BudgetsSection({ scope }: Props) {
  const queryClient = useQueryClient();
  const scopeKey = budgetScopeKey(scope);
  const scopeKind = scopeKindOf(scope);
  const [editing, setEditing] = useState<Editing>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [deleting, setDeleting] = useState<BudgetDto | null>(null);

  const query = useQuery({
    queryKey: ['budgets', scopeKey],
    queryFn: () => fetchBudgets(scope),
    retry: (count, err) =>
      !(err instanceof ApiError && err.statusCode === 403) && count < 2,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteBudget(scope, id),
    onSuccess: (_void, id) => {
      invalidateBudgetQueries(queryClient);
      if (editing?.mode === 'edit' && editing.id === id) setEditing(null);
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (query.error instanceof ApiError && query.error.statusCode === 403) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="budgets-restricted"
      >
        Team budgets are visible to the team owner, managers and members with
        team analytics access
      </p>
    );
  }
  if (query.isError || !query.data) {
    return <p className="text-sm text-destructive">Error</p>;
  }

  const { canManage } = query.data;
  const budgets = [...query.data.budgets].sort(
    (a, b) => PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period),
  );
  const freePeriod =
    PERIOD_ORDER.find((p) => !budgets.some((b) => b.period === p)) ?? 'month';

  return (
    <section className="flex flex-col gap-4" data-testid="budgets-section">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div>
          <h2 className="text-base font-semibold">Budgets</h2>
          <p className="text-xs text-muted-foreground">
            Reference amounts only — Log Hub does not stop or limit usage.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLogOpen(true)}
            data-testid="budget-event-log-open"
          >
            Budget event log
          </Button>
          {canManage && (
            <Button
              size="sm"
              disabled={editing !== null}
              onClick={() => setEditing({ mode: 'add' })}
              data-testid="budget-add"
            >
              + Add budget
            </Button>
          )}
        </div>
      </div>

      {!canManage && (
        <p className="text-xs font-medium text-muted-foreground">
          Managed by the team owner and managers
        </p>
      )}

      {budgets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No budgets yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <th className={TH}>Period</th>
              <th className={TH}>Amount</th>
              <th className={TH}>Notify at</th>
              <th className={TH}>Time zone</th>
              <th className={TH}>Current period</th>
              {canManage && <th className={TH} aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {budgets.map((b) => {
              const isEdited = editing?.mode === 'edit' && editing.id === b.id;
              return [
                <tr
                  key={b.id}
                  className="border-b border-border/60"
                  data-testid={`budget-row-${b.period}`}
                >
                  <td className={TD}>{BUDGET_PERIOD_LABELS[b.period]}</td>
                  <td className={`${TD} tabular-nums`}>
                    {formatUsdMicros(b.amountMicros)}
                  </td>
                  <td className={TD}>{b.thresholds.join(' · ')} %</td>
                  <td className={TD}>{b.timeZone}</td>
                  <td className={`${TD} tabular-nums`}>
                    <CurrentPeriodCell
                      scope={scope}
                      scopeKey={scopeKey}
                      budget={b}
                    />
                  </td>
                  {canManage && (
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      {isEdited ? (
                        <span className="text-xs text-muted-foreground">
                          Editing…
                        </span>
                      ) : (
                        <span className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={editing !== null}
                            onClick={() =>
                              setEditing({ mode: 'edit', id: b.id })
                            }
                            data-testid={`budget-edit-${b.period}`}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-destructive"
                            disabled={editing !== null}
                            onClick={() => setDeleting(b)}
                            data-testid={`budget-delete-${b.period}`}
                          >
                            Delete
                          </Button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>,
                isEdited && (
                  <tr key={`${b.id}-form`}>
                    <td colSpan={canManage ? 6 : 5} className="py-3">
                      <BudgetForm
                        scope={scope}
                        scopeKind={scopeKind}
                        budget={b}
                        onClose={() => setEditing(null)}
                        onDelete={() => setDeleting(b)}
                      />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}

      {editing?.mode === 'add' && (
        <BudgetForm
          scope={scope}
          scopeKind={scopeKind}
          defaultPeriod={freePeriod}
          onClose={() => setEditing(null)}
        />
      )}

      {deleteMutation.isError && (
        <p className="text-sm text-destructive">Error</p>
      )}

      <ConfirmDialog
        open={deleting !== null}
        header="Delete budget"
        message={
          deleting
            ? `Delete the ${deleting.label} budget? Its notices and event log entries are kept.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleting) deleteMutation.mutate(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />

      <BudgetEventLog
        scope={scope}
        scopeKey={scopeKey}
        budgets={budgets}
        open={logOpen}
        onOpenChange={setLogOpen}
      />
    </section>
  );
}
