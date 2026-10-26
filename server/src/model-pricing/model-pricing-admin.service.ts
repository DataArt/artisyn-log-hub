import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { modelPricingFetchState } from '../database/schema/index';
import type { ModelPriceInputDto } from './dto/model-price-input.dto';
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  isFetchEnabled,
  MAX_RATE,
  RETRY_AFTER_HOURS,
  STALE_AFTER_HOURS,
} from './model-pricing.constants';
import {
  normalizeTiers,
  round6,
  validatePricingTiers,
  type ModelState,
  type PriceVersion,
} from './model-pricing-rates';
import {
  clearOverrideBase,
  loadModelStates,
  lockPricingWrites,
  setOverrideBase,
  writeEffectivePrice,
  type FetchStateSource,
  type ModelStates,
} from './model-pricing-store';
import type {
  AdminModelPricingResponse,
  AdminModelPricingRow,
  ModelPricingRates,
  PricingFetchStatus,
} from './model-pricing.types';
import { notifySessionCostsStale } from './session-cost-invalidation';

const EMPTY_STATUS: PricingFetchStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastCounts: null,
  lastError: null,
  nextCheckAt: null,
};

const FETCH_RESULTS: readonly Exclude<
  PricingFetchStatus['lastResult'],
  null
>[] = ['changed', 'unchanged', 'imported', 'failed'];

/**
 * Admin view and manual edits of model prices. Every write runs in one
 * transaction under the advisory lock and returns the model's refreshed row. After the
 * transaction commits, the stored session costs it flagged stale are recomputed via
 * `notifySessionCostsStale()`.
 */
@Injectable()
export class ModelPricingAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** Every known model with its resolved state, plus both sources' status. */
  async list(): Promise<AdminModelPricingResponse> {
    const [{ states }, statusRows] = await Promise.all([
      loadModelStates(this.db),
      this.db.select().from(modelPricingFetchState),
    ]);

    const statusBySource = new Map<string, PricingFetchStatus>();
    for (const row of statusRows) {
      statusBySource.set(row.source, {
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        lastResult: FETCH_RESULTS.find((r) => r === row.lastResult) ?? null,
        lastCounts: row.lastCounts ?? null,
        lastError: row.lastError ?? null,
        nextCheckAt: null,
      });
    }

    const models = [...states.values()].sort((a, b) =>
      a.modelId.localeCompare(b.modelId),
    );
    const anthropic = statusOf(statusBySource, 'anthropic');
    return {
      anthropic: { ...anthropic, nextCheckAt: nextAnthropicCheck(anthropic) },
      openrouter: statusOf(statusBySource, 'openrouter'),
      unpricedCount: models.filter((m) => m.source === 'unpriced').length,
      models,
    };
  }

  /**
   * Sets the price of an `unpriced` or `manual` model as a `manual` price version.
   *
   * @throws NotFoundException for an unknown id; ConflictException for any other state.
   */
  async setPrice(dto: ModelPriceInputDto): Promise<AdminModelPricingRow> {
    const row = await this.db.transaction(async (tx) => {
      await lockPricingWrites(tx);
      const loaded = await loadModelStates(tx, [dto.modelId]);
      const state = requireKnown(loaded, dto.modelId);
      if (state.overrideActive || !isManualOrUnpriced(state)) {
        throw new ConflictException(
          `Model ${dto.modelId} has a ${state.source} price; use an override instead`,
        );
      }
      const rates = withDefaults(
        dto,
        loaded.effective.get(dto.modelId) ?? null,
      );
      await writeEffectivePrice(tx, dto.modelId, rates, 'manual');
      return refreshedRow(tx, dto.modelId);
    });
    await notifySessionCostsStale();
    return row;
  }

  /**
   * Sets (or edits) an override on an `anthropic` / `openrouter` model. The
   * first override stores the current fetched/imported price as the hidden base.
   *
   * @throws NotFoundException for an unknown id; ConflictException for any other state, or
   *   when the model has a future-dated price row (it would silently end the override).
   */
  async setOverride(dto: ModelPriceInputDto): Promise<AdminModelPricingRow> {
    const row = await this.db.transaction(async (tx) => {
      await lockPricingWrites(tx);
      const loaded = await loadModelStates(tx, [dto.modelId]);
      const state = requireKnown(loaded, dto.modelId);
      if (state.source !== 'anthropic' && state.source !== 'openrouter') {
        throw new ConflictException(
          `Model ${dto.modelId} is ${state.source}; only fetched or imported prices can be overridden`,
        );
      }
      if (loaded.futureDated.has(dto.modelId)) {
        throw new ConflictException(
          `Model ${dto.modelId} has a scheduled price change`,
        );
      }
      const effective = loaded.effective.get(dto.modelId) ?? null;
      if (!state.overrideActive && effective) {
        await setOverrideBase(tx, dto.modelId, effective, state.source);
      }
      const rates = withDefaults(dto, effective);
      await writeEffectivePrice(tx, dto.modelId, rates, 'override');
      return refreshedRow(tx, dto.modelId);
    });
    await notifySessionCostsStale();
    return row;
  }

  /**
   * Ends an active override: restores the hidden base as the effective price with its own
   * source and tiers, then clears the stored base.
   *
   * @throws NotFoundException for an unknown id; ConflictException when no override is active.
   */
  async clearOverride(modelId: string): Promise<AdminModelPricingRow> {
    const row = await this.db.transaction(async (tx) => {
      await lockPricingWrites(tx);
      const loaded = await loadModelStates(tx, [modelId]);
      const state = requireKnown(loaded, modelId);
      if (!state.overrideActive || !state.base || state.source === 'unpriced') {
        throw new ConflictException(`Model ${modelId} has no active override`);
      }
      await writeEffectivePrice(tx, modelId, state.base, state.source);
      await clearOverrideBase(tx, modelId);
      return refreshedRow(tx, modelId);
    });
    await notifySessionCostsStale();
    return row;
  }
}

/**
 * When the scheduled Anthropic check is next due: the later of "last success is stale"
 * (`STALE_AFTER_HOURS`) and "retry window over" (`RETRY_AFTER_HOURS`) — the two conditions of
 * the fetch claim. Null when the fetch is disabled; now when it never ran.
 */
function nextAnthropicCheck(status: PricingFetchStatus): string | null {
  if (!isFetchEnabled()) return null;
  const hours = (iso: string | null, h: number): number =>
    iso ? new Date(iso).getTime() + h * 3_600_000 : 0;
  const due = Math.max(
    hours(status.lastSuccessAt, STALE_AFTER_HOURS),
    hours(status.lastAttemptAt, RETRY_AFTER_HOURS),
    Date.now(),
  );
  return new Date(due).toISOString();
}

function statusOf(
  bySource: Map<string, PricingFetchStatus>,
  source: FetchStateSource,
): PricingFetchStatus {
  return bySource.get(source) ?? { ...EMPTY_STATUS };
}

function requireKnown(loaded: ModelStates, modelId: string): ModelState {
  const state = loaded.states.get(modelId);
  if (!loaded.knownIds.has(modelId) || !state) {
    throw new NotFoundException(`Unknown model ${modelId}`);
  }
  return state;
}

function isManualOrUnpriced(state: ModelState): boolean {
  return state.source === 'manual' || state.source === 'unpriced';
}

/**
 * The input rates with the defaults applied for omitted fields. Tiers (DD12): omitted carries
 * the current effective row's tiers, `null` / `[]` clears them; invalid tiers are a 400.
 */
function withDefaults(
  dto: ModelPriceInputDto,
  current: PriceVersion | null,
): ModelPricingRates {
  const rates: ModelPricingRates = {
    priceIn: dto.priceIn,
    priceOut: dto.priceOut,
    priceCacheR: dto.priceCacheR ?? 0,
    priceCacheW5m:
      dto.priceCacheW5m ?? round6(dto.priceIn * CACHE_WRITE_5M_MULTIPLIER),
    priceCacheW1h:
      dto.priceCacheW1h ?? round6(dto.priceIn * CACHE_WRITE_1H_MULTIPLIER),
    priceWebSearch: dto.priceWebSearch ?? 0,
    charsPerToken: dto.charsPerToken ?? current?.charsPerToken ?? null,
    contextLength: dto.contextLength ?? current?.contextLength ?? null,
    tiers: resolveTiers(dto.tiers, current),
  };
  // A defaulted cache-write rate can exceed numeric(10,6) for a huge priceIn.
  if (rates.priceCacheW5m > MAX_RATE || rates.priceCacheW1h > MAX_RATE) {
    throw new BadRequestException(
      `Default cache-write rate exceeds ${MAX_RATE}; enter the cache-write rates explicitly`,
    );
  }
  return rates;
}

function resolveTiers(
  input: ModelPriceInputDto['tiers'],
  current: PriceVersion | null,
): ModelPricingRates['tiers'] {
  if (input === undefined) return normalizeTiers(current?.tiers);
  // Validated in the order given: non-increasing thresholds are a 400 (AC5),
  // not silently re-sorted. Only a valid list is normalized for storage.
  const error = validatePricingTiers(input);
  if (error !== null) throw new BadRequestException(error);
  return normalizeTiers(input);
}

async function refreshedRow(
  tx: DrizzleDb,
  modelId: string,
): Promise<AdminModelPricingRow> {
  const { states } = await loadModelStates(tx, [modelId]);
  const state = states.get(modelId);
  if (!state) throw new NotFoundException(`Unknown model ${modelId}`);
  return state;
}
