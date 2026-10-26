import {
  MAX_PRICING_TIERS,
  MAX_RATE,
  validatePricingTiers,
} from '@loghub/pricing';
import type {
  ModelPriceInput,
  ModelPricingRates,
  PricingTier,
} from '../../../../../models/pricing';

/** Editable scalar fields of the price dialog, in grid order (tiers are edited separately). */
export type FieldKey = Exclude<keyof ModelPricingRates, 'tiers'>;

/** Raw text of every field, as typed. */
export type PriceForm = Record<FieldKey, string>;

/** Same upper bounds as the server's `ModelPriceInputDto` (`MAX_RATE` is shared). */
const MAX_CHARS_PER_TOKEN = 999.999;
const MAX_CONTEXT_LENGTH = 100_000_000;

export { MAX_PRICING_TIERS };

export const FIELDS: { key: FieldKey; label: string; required: boolean }[] = [
  { key: 'priceIn', label: 'Price In', required: true },
  { key: 'priceOut', label: 'Price Out', required: true },
  { key: 'priceCacheR', label: 'Cache Read', required: false },
  { key: 'priceWebSearch', label: 'Web search (per request)', required: false },
  { key: 'priceCacheW5m', label: 'Cache W 5m', required: false },
  { key: 'priceCacheW1h', label: 'Cache W 1h', required: false },
  { key: 'charsPerToken', label: 'Chars/Token', required: false },
  { key: 'contextLength', label: 'Context Length', required: false },
];

export function emptyForm(): PriceForm {
  return {
    priceIn: '',
    priceOut: '',
    priceCacheR: '',
    priceCacheW5m: '',
    priceCacheW1h: '',
    priceWebSearch: '',
    charsPerToken: '',
    contextLength: '',
  };
}

/** Prefills the form from a model's current rates (Edit / Override). */
export function formFromRates(rates: ModelPricingRates): PriceForm {
  const text = (v: number | null) => (v === null ? '' : String(v));
  return {
    priceIn: text(rates.priceIn),
    priceOut: text(rates.priceOut),
    priceCacheR: text(rates.priceCacheR),
    priceCacheW5m: text(rates.priceCacheW5m),
    priceCacheW1h: text(rates.priceCacheW1h),
    priceWebSearch: text(rates.priceWebSearch),
    charsPerToken: text(rates.charsPerToken),
    contextLength: text(rates.contextLength),
  };
}

type PriceValues = Omit<ModelPriceInput, 'modelId'>;

export type PriceFormResult =
  | { ok: true; values: PriceValues }
  | { ok: false; error: string };

function labelOf(key: FieldKey): string {
  return FIELDS.find((f) => f.key === key)?.label ?? key;
}

/**
 * Validates the typed form against the server's DTO rules. Blank optional fields are
 * omitted from the result so the server applies its defaults.
 */
export function validatePriceForm(form: PriceForm): PriceFormResult {
  const values: Partial<Record<FieldKey, number>> = {};
  for (const field of FIELDS) {
    const raw = form[field.key].trim();
    if (raw === '') {
      if (field.required)
        return { ok: false, error: `${field.label} is required` };
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${field.label} must be a number` };
    }
    values[field.key] = n;
  }

  for (const key of [
    'priceIn',
    'priceOut',
    'priceCacheR',
    'priceCacheW5m',
    'priceCacheW1h',
    'priceWebSearch',
  ] as const) {
    const v = values[key];
    if (v !== undefined && (v < 0 || v > MAX_RATE)) {
      return {
        ok: false,
        error: `${labelOf(key)} must be between 0 and ${MAX_RATE}`,
      };
    }
  }
  const cpt = values.charsPerToken;
  if (cpt !== undefined && (cpt <= 0 || cpt > MAX_CHARS_PER_TOKEN)) {
    return {
      ok: false,
      error: `Chars/Token must be greater than 0 and at most ${MAX_CHARS_PER_TOKEN}`,
    };
  }
  const ctx = values.contextLength;
  if (
    ctx !== undefined &&
    (!Number.isInteger(ctx) || ctx <= 0 || ctx > MAX_CONTEXT_LENGTH)
  ) {
    return {
      ok: false,
      error: `Context Length must be a whole number between 1 and ${MAX_CONTEXT_LENGTH.toLocaleString('en-US')}`,
    };
  }

  const { priceIn, priceOut } = values;
  if (priceIn === undefined || priceOut === undefined) {
    return { ok: false, error: 'Price In and Price Out are required' };
  }
  return { ok: true, values: { ...values, priceIn, priceOut } };
}

/** One editable tier row: every field as typed. */
export type TierRow = Record<keyof PricingTier, string>;

/** Tier columns of the editor, in table order. */
export const TIER_FIELDS: { key: keyof PricingTier; label: string }[] = [
  { key: 'aboveTokens', label: 'Above (tokens)' },
  { key: 'priceIn', label: 'Input' },
  { key: 'priceOut', label: 'Output' },
  { key: 'priceCacheR', label: 'Cache read' },
  { key: 'priceCacheW5m', label: '5m write' },
  { key: 'priceCacheW1h', label: '1h write' },
];

export function emptyTierRow(): TierRow {
  return {
    aboveTokens: '',
    priceIn: '',
    priceOut: '',
    priceCacheR: '',
    priceCacheW5m: '',
    priceCacheW1h: '',
  };
}

/** Prefills the tier rows from a model's current tiers (none → no rows). */
export function tierRowsFromTiers(
  tiers: readonly PricingTier[] | null | undefined,
): TierRow[] {
  return (tiers ?? []).map((t) => ({
    aboveTokens: String(t.aboveTokens),
    priceIn: String(t.priceIn),
    priceOut: String(t.priceOut),
    priceCacheR: String(t.priceCacheR),
    priceCacheW5m: String(t.priceCacheW5m),
    priceCacheW1h: String(t.priceCacheW1h),
  }));
}

export type TierRowsResult =
  | { ok: true; tiers: PricingTier[] | null }
  | { ok: false; error: string };

/**
 * Converts the typed tier rows to the request's `tiers` (`null` when there are none), sorted
 * ascending by threshold, and checks them with the server's own `validatePricingTiers`
 * (`@loghub/pricing`), so the dialog rejects exactly what the API would.
 */
export function tiersFromRows(rows: readonly TierRow[]): TierRowsResult {
  if (rows.length === 0) return { ok: true, tiers: null };
  const tiers: PricingTier[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const badField = TIER_FIELDS.find((field) => {
      const raw = row[field.key].trim();
      return raw === '' || !Number.isFinite(Number(raw));
    });
    if (badField) {
      return {
        ok: false,
        error: `Tier ${i + 1}: ${badField.label} must be a number`,
      };
    }
    tiers.push({
      aboveTokens: Number(row.aboveTokens.trim()),
      priceIn: Number(row.priceIn.trim()),
      priceOut: Number(row.priceOut.trim()),
      priceCacheR: Number(row.priceCacheR.trim()),
      priceCacheW5m: Number(row.priceCacheW5m.trim()),
      priceCacheW1h: Number(row.priceCacheW1h.trim()),
    });
  }
  tiers.sort((a, b) => a.aboveTokens - b.aboveTokens);
  const error = validatePricingTiers(tiers);
  return error === null ? { ok: true, tiers } : { ok: false, error };
}
