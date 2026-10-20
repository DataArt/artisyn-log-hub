import { useState } from 'react';
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  type AdminModelPricingRow,
  type ModelPriceInput,
  type ModelPricingRates,
} from '../../../../../models/pricing';
import { useModelPricingMutations } from '../../../../hooks/useAdminModelPricing';
import { Button } from '../../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../ui/dialog';
import { formatUsdPerMillion } from './format';
import { PricingSourceBadge } from './PricingSourceBadge';
import {
  FIELDS,
  emptyForm,
  formFromRates,
  validatePriceForm,
  type FieldKey,
  type PriceForm,
} from './priceForm';

export type ModelPriceDialogMode = 'set' | 'edit' | 'override';

interface Props {
  row: AdminModelPricingRow;
  mode: ModelPriceDialogMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TITLES: Record<ModelPriceDialogMode, string> = {
  set: 'Set price',
  edit: 'Edit price',
  override: 'Override',
};

/** Live placeholder for a blank cache-write rate: the server default `multiplier × In`. */
function cacheWritePlaceholder(priceIn: string, multiplier: number): string {
  const label = `${multiplier} × In`;
  const n = Number(priceIn);
  if (priceIn.trim() === '' || !Number.isFinite(n)) return label;
  return `${Number((n * multiplier).toFixed(6))} (${label})`;
}

function placeholderFor(key: FieldKey, form: PriceForm): string {
  if (key === 'priceCacheW5m')
    return cacheWritePlaceholder(form.priceIn, CACHE_WRITE_5M_MULTIPLIER);
  if (key === 'priceCacheW1h')
    return cacheWritePlaceholder(form.priceIn, CACHE_WRITE_1H_MULTIPLIER);
  if (key === 'priceCacheR' || key === 'priceWebSearch') return '0';
  return '';
}

function BaseRates({ rates }: { rates: ModelPricingRates }) {
  return (
    <span>
      base: in {formatUsdPerMillion(rates.priceIn)} · out{' '}
      {formatUsdPerMillion(rates.priceOut)}
    </span>
  );
}

/** The "Current source" strip: the badge plus the first-seen date or the base price. */
function SourceStrip({ row }: { row: AdminModelPricingRow }) {
  const baseRates = row.base ?? row.effective;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <span>Current source:</span>
      <PricingSourceBadge
        source={row.source}
        overrideActive={row.overrideActive}
      />
      {row.effective === null && row.firstSeenAt && (
        <span>first seen {row.firstSeenAt.slice(0, 10)}</span>
      )}
      {row.source !== 'unpriced' && row.source !== 'manual' && baseRates && (
        <BaseRates rates={baseRates} />
      )}
    </div>
  );
}

/**
 * Set price (unpriced) / Edit price (manual) / Override (fetched or imported) dialog for one
 * model. Blank optional fields are left out of the request, so the server applies its
 * defaults (cache writes from the multipliers, the rest 0 or carried forward).
 */
export function ModelPriceDialog({ row, mode, open, onOpenChange }: Props) {
  const { setPrice, setOverride } = useModelPricingMutations();
  const mutation = mode === 'override' ? setOverride : setPrice;
  const [form, setForm] = useState<PriceForm>(() =>
    mode === 'set' || row.effective === null
      ? emptyForm()
      : formFromRates(row.effective),
  );
  const [error, setError] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validatePriceForm(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError('');
    const input: ModelPriceInput = { modelId: row.modelId, ...result.values };
    mutation.mutate(input, {
      onSuccess: () => onOpenChange(false),
      onError: (err: unknown) => {
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'Failed to save the price',
        );
      },
    });
  }

  const showFr5Note = row.source === 'unpriced' || row.source === 'manual';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="model-price-dialog">
        <DialogHeader>
          <DialogTitle>
            {TITLES[mode]} — {row.modelId}
          </DialogTitle>
          <DialogDescription>
            USD per 1M tokens (web search: USD per request)
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
          noValidate
        >
          <SourceStrip row={row} />
          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map((field) => (
              <label key={field.key} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {field.label}
                  {field.required && (
                    <span className="text-destructive"> *</span>
                  )}
                </span>
                <input
                  className="w-full border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  name={field.key}
                  inputMode="decimal"
                  value={form[field.key]}
                  placeholder={placeholderFor(field.key, form)}
                  onChange={(e) =>
                    setForm({ ...form, [field.key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
          {showFr5Note && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="model-price-fr5-note"
            >
              ⓘ If this model later appears in Anthropic&apos;s fetched pricing,
              the manual price is replaced by the fetched one automatically.
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
