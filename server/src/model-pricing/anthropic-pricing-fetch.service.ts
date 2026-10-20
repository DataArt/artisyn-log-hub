import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { parseAnthropicPricing } from './anthropic-pricing-parser';
import {
  ANTHROPIC_FETCH_TIMEOUT_MS,
  ANTHROPIC_PRICING_URL,
  RETRY_AFTER_HOURS,
  STALE_AFTER_HOURS,
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
import type { ModelPricingRates } from './model-pricing.types';

export type RunFetchResult = 'changed' | 'unchanged' | 'failed' | 'skipped';

const FETCH_SOURCE = 'anthropic';

/**
 * Daily scrape of the official Anthropic pricing page.
 *
 * `runFetch` is safe to call from every cluster worker at once: a conditional UPDATE on
 * `model_pricing_fetch_state.last_attempt_at` lets exactly one worker per stale/retry window
 * fetch the page; every other worker returns `'skipped'` without touching anything else.
 */
@Injectable()
export class AnthropicPricingFetchService {
  private readonly logger = new Logger(AnthropicPricingFetchService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Seeds and claims the `'anthropic'` fetch-state row, then — only when the claim succeeds —
   * fetches and parses the page and persists the prices with the fetch state in one
   * transaction. Any fetch, parse or persist failure records a `failed` state (no price is
   * written) and returns `'failed'`.
   */
  async runFetch(url: string = ANTHROPIC_PRICING_URL): Promise<RunFetchResult> {
    await this.db.execute(
      sql`INSERT INTO model_pricing_fetch_state (source) VALUES (${FETCH_SOURCE}) ON CONFLICT (source) DO NOTHING`,
    );
    if (!(await this.claim())) return 'skipped';

    let fetched: Map<string, ModelPricingRates>;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ANTHROPIC_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return await this.fail(`HTTP ${response.status} from ${url}`);
      }
      const parsed = parseAnthropicPricing(await response.text());
      if (!parsed) {
        return await this.fail(
          `unexpected pricing page layout at ${url} (model table or web-search price not found)`,
        );
      }
      fetched = parsed;
    } catch (err) {
      return await this.fail(errorMessage(err), err);
    }

    try {
      const changed = await this.persist(fetched);
      return changed > 0 ? 'changed' : 'unchanged';
    } catch (err) {
      return await this.fail(`failed to persist: ${errorMessage(err)}`, err);
    }
  }

  /**
   * Cluster claim: stamps `last_attempt_at = now()` only when the last success is stale and no
   * other worker attempted within the retry window. Returns true when this worker won.
   */
  private async claim(): Promise<boolean> {
    const result = await this.db.execute<{ source: string }>(sql`
      UPDATE model_pricing_fetch_state SET last_attempt_at = now()
       WHERE source = ${FETCH_SOURCE}
         AND (last_success_at IS NULL OR last_success_at < now() - make_interval(hours => ${STALE_AFTER_HOURS}))
         AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => ${RETRY_AFTER_HOURS}))
      RETURNING source
    `);
    return (result.rows[0] ?? null) !== null;
  }

  /**
   * Applies the fetched prices under the lock and records the fetch state in the
   * same transaction. Returns the number of changed models.
   */
  private async persist(
    fetched: Map<string, ModelPricingRates>,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await lockPricingWrites(tx);
      const { states, meta } = await loadModelStates(tx, [...fetched.keys()]);

      let changed = 0;
      const writes: EffectivePriceWrite[] = [];
      for (const [modelId, pageRates] of fetched) {
        const state = states.get(modelId);
        if (state?.overrideActive) {
          // Keep the override; refresh the hidden base it would fall back to. The stored meta
          // base is compared (not the resolved one), so a drifted, missing base gets written.
          const stored = meta.get(modelId);
          const rates = carryForward(pageRates, state.base);
          if (
            !stored?.overrideBase ||
            stored.overrideBaseSource !== FETCH_SOURCE ||
            !ratesEqual(stored.overrideBase, rates)
          ) {
            await setOverrideBase(tx, modelId, rates, FETCH_SOURCE);
            changed++;
          }
          continue;
        }
        writes.push({
          modelId,
          rates: carryForward(pageRates, state?.effective ?? null),
          source: FETCH_SOURCE,
        });
      }
      changed += (await writeEffectivePrices(tx, writes)).size;

      await recordFetchState(tx, FETCH_SOURCE, {
        result: changed > 0 ? 'changed' : 'unchanged',
        counts: { changed },
        error: null,
        stampAttempt: false,
      });
      return changed;
    });
  }

  /** Logs the failure and records it on the fetch-state row (nothing else is written). */
  private async fail(message: string, err?: unknown): Promise<'failed'> {
    this.logger.error(
      `Anthropic pricing fetch failed: ${message}`,
      err instanceof Error ? err.stack : undefined,
    );
    try {
      await recordFetchState(this.db, FETCH_SOURCE, {
        result: 'failed',
        counts: null,
        error: message,
        stampAttempt: false,
      });
    } catch (stateErr) {
      this.logger.error(
        `Anthropic pricing fetch failed to record its failed state: ${errorMessage(stateErr)}`,
        stateErr instanceof Error ? stateErr.stack : undefined,
      );
    }
    return 'failed';
  }
}

/**
 * The pricing page carries no chars-per-token or context length: keep the model's current
 * values (its effective row, or the override base), else null.
 */
function carryForward(
  rates: ModelPricingRates,
  current: ModelPricingRates | null,
): ModelPricingRates {
  return {
    ...rates,
    charsPerToken: current?.charsPerToken ?? null,
    contextLength: current?.contextLength ?? null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
