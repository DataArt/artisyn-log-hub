import { and, desc, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  modelPricing,
  modelPricingFetchState,
  modelPricingMeta,
} from '../database/schema/index';
import {
  IMPORT_BATCH_SIZE,
  MODEL_PRICING_LOCK_KEY,
} from './model-pricing.constants';
import {
  deriveModelState,
  ratesEqual,
  round6,
  type ModelPricingMeta,
  type ModelState,
  type PriceVersion,
} from './model-pricing-rates';
import type {
  ModelPricingRates,
  OverrideBaseSource,
  PricingFetchStatus,
  StoredPricingSource,
} from './model-pricing.types';

/**
 * Shared DB helpers of the model-pricing module. Every function takes the
 * caller's handle so it runs inside the caller's transaction; price-writing transactions call
 * {@link lockPricingWrites} first.
 */

/**
 * Serializes price-writing transactions: a transaction-scoped advisory lock, released
 * on commit/rollback. Must be called inside a transaction.
 */
export async function lockPricingWrites(tx: DrizzleDb): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${MODEL_PRICING_LOCK_KEY})`,
  );
}

/** Everything the services need to resolve and change models' prices. */
export interface ModelStates {
  /** Resolved state per known id. */
  states: Map<string, ModelState>;
  /** Newest `model_pricing` row with `effective_from <= CURRENT_DATE`, per model. */
  effective: Map<string, PriceVersion>;
  /** Newest effective row with `source <> 'override'`, per model (data-drift fallback). */
  fallback: Map<string, PriceVersion>;
  /** `model_pricing_meta` rows, per model. */
  meta: Map<string, ModelPricingMeta>;
  /** Union of `model_pricing` ids (any date) and `model_pricing_meta` ids. */
  knownIds: Set<string>;
  /** Ids with a row dated after today (a scheduled price change). */
  futureDated: Set<string>;
}

/**
 * Loads the current pricing state of the given ids, or of every known model when `ids` is
 * omitted. Ids without any row are simply absent from the result.
 */
export async function loadModelStates(
  tx: DrizzleDb,
  ids?: readonly string[],
): Promise<ModelStates> {
  const empty: ModelStates = {
    states: new Map(),
    effective: new Map(),
    fallback: new Map(),
    meta: new Map(),
    knownIds: new Set(),
    futureDated: new Set(),
  };
  if (ids !== undefined && ids.length === 0) return empty;
  const idList = ids === undefined ? undefined : [...new Set(ids)];

  const pricingIdFilter = idList
    ? inArray(modelPricing.modelId, idList)
    : undefined;
  const metaIdFilter = idList
    ? inArray(modelPricingMeta.modelId, idList)
    : undefined;

  const [effectiveRows, fallbackRows, metaRows, idRows] = await Promise.all([
    selectNewestVersions(tx, pricingIdFilter, false),
    selectNewestVersions(tx, pricingIdFilter, true),
    tx.select().from(modelPricingMeta).where(metaIdFilter),
    tx
      .select({
        modelId: modelPricing.modelId,
        future: sql<boolean>`bool_or(${modelPricing.effectiveFrom} > CURRENT_DATE)`,
      })
      .from(modelPricing)
      .where(pricingIdFilter)
      .groupBy(modelPricing.modelId),
  ]);

  const result = empty;
  for (const row of effectiveRows) result.effective.set(row.modelId, row);
  for (const row of fallbackRows) result.fallback.set(row.modelId, row);
  for (const row of metaRows) {
    result.meta.set(row.modelId, toMeta(row));
    result.knownIds.add(row.modelId);
  }
  for (const row of idRows) {
    result.knownIds.add(row.modelId);
    if (row.future) result.futureDated.add(row.modelId);
  }
  for (const modelId of result.knownIds) {
    result.states.set(
      modelId,
      deriveModelState(
        result.effective.get(modelId) ?? null,
        result.meta.get(modelId) ?? null,
        modelId,
        result.fallback.get(modelId) ?? null,
      ),
    );
  }
  return result;
}

/** Newest effective row per model (`DISTINCT ON`), optionally excluding override rows. */
async function selectNewestVersions(
  tx: DrizzleDb,
  idFilter: SQL | undefined,
  excludeOverride: boolean,
): Promise<PriceVersion[]> {
  const rows = await tx
    .selectDistinctOn([modelPricing.modelId])
    .from(modelPricing)
    .where(
      and(
        idFilter,
        lte(modelPricing.effectiveFrom, sql`CURRENT_DATE`),
        excludeOverride ? ne(modelPricing.source, 'override') : undefined,
      ),
    )
    .orderBy(modelPricing.modelId, desc(modelPricing.effectiveFrom));
  return rows.map((row) => ({
    modelId: row.modelId,
    effectiveFrom: row.effectiveFrom,
    source: toStoredSource(row.source),
    priceIn: Number(row.priceIn),
    priceOut: Number(row.priceOut),
    priceCacheR: Number(row.priceCacheR),
    priceCacheW5m: Number(row.priceCacheW5m),
    priceCacheW1h: Number(row.priceCacheW1h),
    priceWebSearch: Number(row.priceWebSearch),
    charsPerToken: nullableNumber(row.charsPerToken),
    contextLength: row.contextLength,
  }));
}

function toMeta(row: typeof modelPricingMeta.$inferSelect): ModelPricingMeta {
  const baseSource = toOverrideBaseSource(row.overrideBaseSource);
  const hasBase =
    baseSource !== null &&
    row.overrideBasePriceIn !== null &&
    row.overrideBasePriceOut !== null;
  return {
    modelId: row.modelId,
    firstSeenAt: row.firstSeenAt ? row.firstSeenAt.toISOString() : null,
    overrideBaseSource: hasBase ? baseSource : null,
    overrideBase: hasBase
      ? {
          priceIn: Number(row.overrideBasePriceIn),
          priceOut: Number(row.overrideBasePriceOut),
          priceCacheR: Number(row.overrideBasePriceCacheR ?? 0),
          priceCacheW5m: Number(row.overrideBasePriceCacheW5m ?? 0),
          priceCacheW1h: Number(row.overrideBasePriceCacheW1h ?? 0),
          priceWebSearch: Number(row.overrideBasePriceWebSearch ?? 0),
          charsPerToken: nullableNumber(row.overrideBaseCharsPerToken),
          contextLength: row.overrideBaseContextLength,
        }
      : null,
  };
}

const STORED_SOURCES: readonly StoredPricingSource[] = [
  'anthropic',
  'openrouter',
  'manual',
  'override',
];

/** Narrows a DB `source` value; anything unexpected reads as `manual` (the column default). */
function toStoredSource(value: string): StoredPricingSource {
  return STORED_SOURCES.find((s) => s === value) ?? 'manual';
}

function toOverrideBaseSource(value: string | null): OverrideBaseSource | null {
  if (value === 'anthropic' || value === 'openrouter') return value;
  return null;
}

function nullableNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Numeric column value as a string (drizzle's `numeric` input type), rounded to 6 decimals. */
function num6(value: number): string {
  return String(round6(value));
}

/** `chars_per_token` is `numeric(6,3)`. */
function num3(value: number | null): string | null {
  return value === null ? null : String(Number(value.toFixed(3)));
}

/** One price write for {@link writeEffectivePrices}. */
export interface EffectivePriceWrite {
  modelId: string;
  rates: ModelPricingRates;
  source: StoredPricingSource;
}

/**
 * Writes one model's effective price. Returns true when a row was written, false when
 * the current effective row already carries the same rates and source.
 */
export async function writeEffectivePrice(
  tx: DrizzleDb,
  modelId: string,
  rates: ModelPricingRates,
  source: StoredPricingSource,
): Promise<boolean> {
  const written = await writeEffectivePrices(tx, [{ modelId, rates, source }]);
  return written.has(modelId);
}

/**
 * Batched form of {@link writeEffectivePrice}. Loads the current effective rows of all
 * ids in one query, skips items whose rates (6-decimal compare, incl. chars-per-token and
 * context length) and source are unchanged, and upserts the rest as today's row
 * (`effective_from = CURRENT_DATE`, overwriting a row already written today) in multi-row
 * `INSERT … ON CONFLICT DO UPDATE` batches of {@link IMPORT_BATCH_SIZE}. Rows dated before today
 * are never modified. For a duplicated id the last item wins. Returns the ids written.
 */
export async function writeEffectivePrices(
  tx: DrizzleDb,
  items: readonly EffectivePriceWrite[],
): Promise<Set<string>> {
  const written = new Set<string>();
  if (items.length === 0) return written;

  const byId = new Map<string, EffectivePriceWrite>();
  for (const item of items) byId.set(item.modelId, item);

  const current = new Map<string, PriceVersion>();
  for (const row of await selectNewestVersions(
    tx,
    inArray(modelPricing.modelId, [...byId.keys()]),
    false,
  ))
    current.set(row.modelId, row);

  const changed = [...byId.values()].filter((item) => {
    const row = current.get(item.modelId);
    return !row || row.source !== item.source || !ratesEqual(row, item.rates);
  });

  for (let i = 0; i < changed.length; i += IMPORT_BATCH_SIZE) {
    const batch = changed.slice(i, i + IMPORT_BATCH_SIZE);
    await tx
      .insert(modelPricing)
      .values(
        batch.map(({ modelId, rates, source }) => ({
          modelId,
          priceIn: num6(rates.priceIn),
          priceOut: num6(rates.priceOut),
          priceCacheR: num6(rates.priceCacheR),
          // Deprecated column, kept equal to the 5m rate.
          priceCacheW: num6(rates.priceCacheW5m),
          priceCacheW5m: num6(rates.priceCacheW5m),
          priceCacheW1h: num6(rates.priceCacheW1h),
          priceWebSearch: num6(rates.priceWebSearch),
          currency: 'USD',
          effectiveFrom: sql`CURRENT_DATE`,
          charsPerToken: num3(rates.charsPerToken),
          contextLength: rates.contextLength,
          source,
        })),
      )
      .onConflictDoUpdate({
        target: [modelPricing.modelId, modelPricing.effectiveFrom],
        set: {
          priceIn: sql`excluded.price_in`,
          priceOut: sql`excluded.price_out`,
          priceCacheR: sql`excluded.price_cache_r`,
          priceCacheW: sql`excluded.price_cache_w`,
          priceCacheW5m: sql`excluded.price_cache_w_5m`,
          priceCacheW1h: sql`excluded.price_cache_w_1h`,
          priceWebSearch: sql`excluded.price_web_search`,
          currency: sql`excluded.currency`,
          charsPerToken: sql`excluded.chars_per_token`,
          contextLength: sql`excluded.context_length`,
          source: sql`excluded.source`,
        },
      });
    for (const item of batch) written.add(item.modelId);
  }
  return written;
}

/**
 * Stores the fetched/imported price hidden under an active override: upserts the meta
 * row, touching only the `override_base_*` columns and `updated_at`.
 */
export async function setOverrideBase(
  tx: DrizzleDb,
  modelId: string,
  rates: ModelPricingRates,
  source: OverrideBaseSource,
): Promise<void> {
  const base = {
    overrideBaseSource: source,
    overrideBasePriceIn: num6(rates.priceIn),
    overrideBasePriceOut: num6(rates.priceOut),
    overrideBasePriceCacheR: num6(rates.priceCacheR),
    overrideBasePriceCacheW5m: num6(rates.priceCacheW5m),
    overrideBasePriceCacheW1h: num6(rates.priceCacheW1h),
    overrideBasePriceWebSearch: num6(rates.priceWebSearch),
    overrideBaseCharsPerToken: num3(rates.charsPerToken),
    overrideBaseContextLength: rates.contextLength,
  };
  await tx
    .insert(modelPricingMeta)
    .values({ modelId, ...base })
    .onConflictDoUpdate({
      target: modelPricingMeta.modelId,
      set: { ...base, updatedAt: sql`now()` },
    });
}

/** Nulls the override base of a model (after an override is cleared). Keeps `first_seen_at`. */
export async function clearOverrideBase(
  tx: DrizzleDb,
  modelId: string,
): Promise<void> {
  await tx
    .update(modelPricingMeta)
    .set({
      overrideBaseSource: null,
      overrideBasePriceIn: null,
      overrideBasePriceOut: null,
      overrideBasePriceCacheR: null,
      overrideBasePriceCacheW5m: null,
      overrideBasePriceCacheW1h: null,
      overrideBasePriceWebSearch: null,
      overrideBaseCharsPerToken: null,
      overrideBaseContextLength: null,
      updatedAt: sql`now()`,
    })
    .where(sql`${modelPricingMeta.modelId} = ${modelId}`);
}

/** Source key of a `model_pricing_fetch_state` row. */
export type FetchStateSource = 'anthropic' | 'openrouter';

/** Outcome of one fetch/import attempt, as stored on the source's fetch-state row. */
export interface FetchStateUpdate {
  result: Exclude<PricingFetchStatus['lastResult'], null>;
  counts: Record<string, number> | null;
  error: string | null;
  /** Stamp `last_attempt_at = now()` too (the Anthropic claim already did). */
  stampAttempt: boolean;
}

/**
 * Records one attempt on the source's `model_pricing_fetch_state` row (upserted, so a missing
 * seed row is tolerated). `last_success_at` moves only on a non-failed result.
 */
export async function recordFetchState(
  tx: DrizzleDb,
  source: FetchStateSource,
  update: FetchStateUpdate,
): Promise<void> {
  const succeeded = update.result !== 'failed';
  const set = {
    lastResult: update.result,
    lastCounts: update.counts,
    lastError: update.error,
    ...(update.stampAttempt ? { lastAttemptAt: sql`now()` } : {}),
    ...(succeeded ? { lastSuccessAt: sql`now()` } : {}),
  };
  await tx
    .insert(modelPricingFetchState)
    .values({ source, ...set })
    .onConflictDoUpdate({ target: modelPricingFetchState.source, set });
}
