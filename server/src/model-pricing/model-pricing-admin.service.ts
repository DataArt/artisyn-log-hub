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
  MAX_RATE,
} from './model-pricing.constants';
import {
  round6,
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

const EMPTY_STATUS: PricingFetchStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastCounts: null,
  lastError: null,
};

const FETCH_RESULTS: readonly Exclude<
  PricingFetchStatus['lastResult'],
  null
>[] = ['changed', 'unchanged', 'imported', 'failed'];

/**
 * Admin view and manual edits of model prices. Every write runs in one
 * transaction under the advisory lock and returns the model's refreshed row.
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
      });
    }

    const models = [...states.values()].sort((a, b) =>
      a.modelId.localeCompare(b.modelId),
    );
    return {
      anthropic: statusOf(statusBySource, 'anthropic'),
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
    return this.db.transaction(async (tx) => {
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
  }

  /**
   * Sets (or edits) an override on an `anthropic` / `openrouter` model. The
   * first override stores the current fetched/imported price as the hidden base.
   *
   * @throws NotFoundException for an unknown id; ConflictException for any other state, or
   *   when the model has a future-dated price row (it would silently end the override).
   */
  async setOverride(dto: ModelPriceInputDto): Promise<AdminModelPricingRow> {
    return this.db.transaction(async (tx) => {
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
  }

  /**
   * Ends an active override: restores the hidden base as the effective price with its own
   * source, then clears the stored base.
   *
   * @throws NotFoundException for an unknown id; ConflictException when no override is active.
   */
  async clearOverride(modelId: string): Promise<AdminModelPricingRow> {
    return this.db.transaction(async (tx) => {
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
  }
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

/** The input rates with the defaults applied for omitted fields. */
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
  };
  // A defaulted cache-write rate can exceed numeric(10,6) for a huge priceIn.
  if (rates.priceCacheW5m > MAX_RATE || rates.priceCacheW1h > MAX_RATE) {
    throw new BadRequestException(
      `Default cache-write rate exceeds ${MAX_RATE}; enter the cache-write rates explicitly`,
    );
  }
  return rates;
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
