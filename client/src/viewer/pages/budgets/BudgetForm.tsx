/**
 * The inline create / edit form of a budget (2026-11-05 budgets-threshold-alerts, Visual notes
 * "Budgets section", budget-form.svg). Client validation mirrors DD-12; the server's 400 / 409
 * message is shown inline.
 */
import { useId, useMemo, useState } from 'react';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { Info, Loader2, X } from 'lucide-react';
import type {
  BudgetDto,
  BudgetPeriod,
  BudgetScopeKind,
} from '../../../models/budgets';
import {
  ApiError,
  createBudget,
  updateBudget,
  type BudgetScopeRef,
} from '../../api';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  BUDGET_LIMITS,
  browserTimeZone,
  formatUsdMicros,
} from './budget-format';
import { BUDGET_PERIOD_LABELS } from './budget-event-format';
import {
  amountInputText,
  budgetRecipientsText,
  budgetScopeText,
  isValidThreshold,
  timeZoneOptions,
  validateBudgetForm,
  type BudgetFormErrors,
} from './budget-form-model';

const PERIODS: BudgetPeriod[] = ['day', 'week', 'month'];

/** Refreshes everything a budget change can move: the list, the event log and spend views. */
export function invalidateBudgetQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['budgets'] });
  void queryClient.invalidateQueries({ queryKey: ['budget-events'] });
  void queryClient.invalidateQueries({ queryKey: ['spend'] });
}

function saveErrorText(err: unknown, period: BudgetPeriod): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 409) {
      return (
        err.message ||
        `A ${period} budget already exists for this scope — one budget per period type.`
      );
    }
    if (err.statusCode === 400 && err.message) return err.message;
    if (err.statusCode === 403) return 'No access';
  }
  return 'Error';
}

interface Props {
  scope: BudgetScopeRef;
  scopeKind: BudgetScopeKind;
  /** The edited budget; absent for "+ Add budget". */
  budget?: BudgetDto;
  /** First free period for a new budget. */
  defaultPeriod?: BudgetPeriod;
  onClose: () => void;
  /** Edit mode only: asks the section to confirm and delete. */
  onDelete?: () => void;
}

export function BudgetForm({
  scope,
  scopeKind,
  budget,
  defaultPeriod = 'month',
  onClose,
  onDelete,
}: Props) {
  const queryClient = useQueryClient();
  const tzListId = useId();
  const zones = useMemo(timeZoneOptions, []);
  const [period, setPeriod] = useState<BudgetPeriod>(
    budget?.period ?? defaultPeriod,
  );
  const [amount, setAmount] = useState(
    budget ? amountInputText(budget.amountMicros) : '',
  );
  const [timeZone, setTimeZone] = useState(
    budget?.timeZone ?? browserTimeZone(),
  );
  const [thresholds, setThresholds] = useState<number[]>(
    budget?.thresholds ?? [...BUDGET_LIMITS.defaultThresholds],
  );
  const [newThreshold, setNewThreshold] = useState('');
  const [errors, setErrors] = useState<BudgetFormErrors>({});

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof createBudget>[1]) =>
      budget
        ? updateBudget(scope, budget.id, input)
        : createBudget(scope, input),
    onSuccess: () => {
      invalidateBudgetQueries(queryClient);
      onClose();
    },
  });

  const newThresholdValue = Number(newThreshold);
  const canAddThreshold =
    newThreshold.trim() !== '' &&
    isValidThreshold(newThresholdValue) &&
    !thresholds.includes(newThresholdValue) &&
    thresholds.length < BUDGET_LIMITS.maxThresholds;

  function addThreshold() {
    if (!canAddThreshold) return;
    setThresholds([...thresholds, newThresholdValue].sort((a, b) => a - b));
    setNewThreshold('');
  }

  function save() {
    const result = validateBudgetForm({ period, amount, timeZone, thresholds });
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    mutation.mutate(result.input);
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-md border border-border bg-muted/30 p-4 text-sm"
      data-testid="budget-form"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-semibold">
          {budget ? 'Edit budget' : 'New budget'}
        </h3>
        <span className="text-xs text-muted-foreground">
          Scope: {budgetScopeText(scopeKind)}
        </span>
      </div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />A reference amount. Log Hub
        shows spend against it and warns at the thresholds below — it never
        stops or limits usage.
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium">Period</legend>
        <div className="flex gap-4">
          {PERIODS.map((p) => (
            <label key={p} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name={`budget-period-${tzListId}`}
                value={p}
                checked={period === p}
                onChange={() => setPeriod(p)}
                data-testid={`budget-period-${p}`}
              />
              {BUDGET_PERIOD_LABELS[p]}
            </label>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          Week starts Monday · Month = calendar month
        </span>
      </fieldset>

      <label className="flex max-w-xs flex-col gap-1">
        <span className="text-xs font-medium">Amount, USD</span>
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={errors.amount ? true : undefined}
          placeholder="100.00"
          data-testid="budget-amount"
        />
        {budget && (
          <span className="text-xs text-muted-foreground">
            was {formatUsdMicros(budget.amountMicros)} · applies to the whole
            period
          </span>
        )}
        {errors.amount && (
          <span className="text-xs text-destructive">{errors.amount}</span>
        )}
      </label>

      <label className="flex max-w-xs flex-col gap-1">
        <span className="text-xs font-medium">Time zone</span>
        <Input
          list={tzListId}
          value={timeZone}
          onChange={(e) => setTimeZone(e.target.value)}
          aria-invalid={errors.timeZone ? true : undefined}
          data-testid="budget-timezone"
        />
        <datalist id={tzListId}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <span className="text-xs text-muted-foreground">
          Resets at 00:00 in this zone
        </span>
        {errors.timeZone && (
          <span className="text-xs text-destructive">{errors.timeZone}</span>
        )}
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Notify at (% of amount)</span>
        <div className="flex flex-wrap items-center gap-2">
          {thresholds.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs ring-1 ring-border"
              data-testid={`budget-threshold-${t}`}
            >
              {t} %
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${t} %`}
                onClick={() => setThresholds(thresholds.filter((x) => x !== t))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <Input
            className="h-7 w-20"
            inputMode="numeric"
            value={newThreshold}
            onChange={(e) => setNewThreshold(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addThreshold();
              }
            }}
            placeholder="120"
            aria-label="New threshold"
            data-testid="budget-threshold-input"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!canAddThreshold}
            onClick={addThreshold}
          >
            + Add
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          Whole numbers {BUDGET_LIMITS.thresholdMin}–
          {BUDGET_LIMITS.thresholdMax}. Default{' '}
          {BUDGET_LIMITS.defaultThresholds.join(' / ')}. One notice per
          threshold per period; if several are crossed at once, only the
          highest.
        </span>
        {errors.thresholds && (
          <span className="text-xs text-destructive">{errors.thresholds}</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {budgetRecipientsText(scopeKind)}
      </p>

      {mutation.isError && (
        <p
          className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100"
          data-testid="budget-form-error"
        >
          {saveErrorText(mutation.error, period)}
        </p>
      )}

      <div className="flex items-center gap-2">
        {budget && onDelete && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={onDelete}
            data-testid="budget-form-delete"
          >
            Delete budget
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={mutation.isPending}
            data-testid="budget-save"
          >
            {mutation.isPending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
