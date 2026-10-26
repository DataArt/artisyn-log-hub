import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  OPENROUTER_FETCH_TIMEOUT_MS,
  OPENROUTER_MODELS_URL,
} from './model-pricing.constants';
import { ratesEqual } from './model-pricing-rates';
import {
  loadModelStates,
  lockPricingWrites,
  recordFetchState,
  setOverrideBase,
  writeEffectivePrices,
  type EffectivePriceWrite,
} from './model-pricing-store';
import type {
  ModelPricingRates,
  OpenRouterImportResult,
} from './model-pricing.types';
import { notifySessionCostsStale } from './session-cost-invalidation';
import {
  parseOpenRouterCatalog,
  type OpenRouterCatalog,
} from './openrouter-catalog-parser';

const IMPORT_SOURCE = 'openrouter';

/**
 * The admin-triggered import of the OpenRouter public model catalog. Synchronous on the
 * admin click; a fetch/HTTP/parse failure writes no price, records a `failed` state and surfaces
 * as 502.
 */
@Injectable()
export class OpenRouterImportService {
  private readonly logger = new Logger(OpenRouterImportService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Fetches and parses the catalog, then applies it in one transaction under the advisory
   * lock (batched writes), recording the `imported` state with the result counts.
   *
   * @throws BadGatewayException on a fetch, HTTP or parse failure (nothing written).
   */
  async runImport(
    url: string = OPENROUTER_MODELS_URL,
  ): Promise<OpenRouterImportResult> {
    const catalog = await this.fetchCatalog(url);
    let result: OpenRouterImportResult;
    try {
      result = await this.apply(catalog);
    } catch (err) {
      await this.recordFailure(`failed to persist: ${errorMessage(err)}`, err);
      throw err;
    }
    // The import transaction has committed: wake the sweeper for the costs it flagged stale.
    await notifySessionCostsStale();
    return result;
  }

  private async fetchCatalog(url: string): Promise<OpenRouterCatalog> {
    let message: string;
    let cause: unknown;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const catalog = parseOpenRouterCatalog(await response.json());
        if (catalog) return catalog;
        message = `OpenRouter catalog at ${url} has no usable model entries`;
      } else {
        message = `OpenRouter catalog fetch failed: HTTP ${response.status} from ${url}`;
      }
    } catch (err) {
      message = `OpenRouter catalog fetch failed: ${errorMessage(err)}`;
      cause = err;
    }
    await this.recordFailure(message, cause);
    throw new BadGatewayException(message);
  }

  /** Applies the parsed catalog and returns the counts. */
  private async apply(
    catalog: OpenRouterCatalog,
  ): Promise<OpenRouterImportResult> {
    return this.db.transaction(async (tx) => {
      await lockPricingWrites(tx);
      const { states, meta, knownIds } = await loadModelStates(tx);

      const result: OpenRouterImportResult = {
        updated: 0,
        added: 0,
        unchanged: 0,
        skippedOverride: 0,
        skippedAnthropic: catalog.skippedAnthropic,
        skippedOther: catalog.skippedOther,
      };
      // Writes to existing models (counted updated/unchanged after the write) vs new models.
      const existingWrites: EffectivePriceWrite[] = [];
      const newWrites: EffectivePriceWrite[] = [];

      for (const entry of catalog.entries) {
        const candidates = [
          ...new Set([entry.fullId, entry.strippedId]),
        ].filter((id) => knownIds.has(id));

        if (candidates.length === 0) {
          newWrites.push({
            modelId: entry.strippedId,
            rates: { ...entry.rates, tiers: null },
            source: IMPORT_SOURCE,
          });
          continue;
        }

        for (const modelId of candidates) {
          const state = states.get(modelId);
          if (state?.source === 'anthropic' || modelId.startsWith('claude-')) {
            result.skippedOther++;
            continue;
          }
          if (state?.overrideActive) {
            result.skippedOverride++;
            const rates = carryForward(entry.rates, state.base);
            const stored = meta.get(modelId);
            if (
              !stored?.overrideBase ||
              stored.overrideBaseSource !== IMPORT_SOURCE ||
              !ratesEqual(stored.overrideBase, rates)
            ) {
              await setOverrideBase(tx, modelId, rates, IMPORT_SOURCE);
            }
            continue;
          }
          existingWrites.push({
            modelId,
            rates: carryForward(entry.rates, state?.effective ?? null),
            source: IMPORT_SOURCE,
          });
        }
      }

      const written = await writeEffectivePrices(tx, [
        ...existingWrites,
        ...newWrites,
      ]);
      for (const { modelId } of existingWrites) {
        if (written.has(modelId)) result.updated++;
        else result.unchanged++;
      }
      result.added = newWrites.length;

      await recordFetchState(tx, IMPORT_SOURCE, {
        result: 'imported',
        counts: { ...result },
        error: null,
        stampAttempt: true,
      });
      return result;
    });
  }

  /** Logs the failure and records it on the fetch-state row (nothing else is written). */
  private async recordFailure(message: string, err?: unknown): Promise<void> {
    this.logger.error(
      `OpenRouter import failed: ${message}`,
      err instanceof Error ? err.stack : undefined,
    );
    try {
      await recordFetchState(this.db, IMPORT_SOURCE, {
        result: 'failed',
        counts: null,
        error: message,
        stampAttempt: true,
      });
    } catch (stateErr) {
      this.logger.error(
        `OpenRouter import failed to record its failed state: ${errorMessage(stateErr)}`,
        stateErr instanceof Error ? stateErr.stack : undefined,
      );
    }
  }
}

/**
 * The catalog has no chars-per-token and may lack a context length: keep the model's current
 * values for whatever the catalog does not provide. OpenRouter carries no prompt-length tiers,
 * so every imported row is written with `tiers: null`.
 */
function carryForward(
  rates: ModelPricingRates,
  current: ModelPricingRates | null,
): ModelPricingRates {
  return {
    ...rates,
    tiers: null,
    charsPerToken: rates.charsPerToken ?? current?.charsPerToken ?? null,
    contextLength: rates.contextLength ?? current?.contextLength ?? null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
