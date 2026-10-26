import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { normalizeTiers } from '../model-pricing/model-pricing-rates';
import type { PricingTier } from '../model-pricing/model-pricing.types';

/** `asOf` query format: a calendar date, `YYYY-MM-DD`. */
const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `value` is a real calendar date in `YYYY-MM-DD` form. The shape check alone would
 * let `2026-13-45` through to Postgres, where `::date` fails with a 500 instead of a 400.
 */
function isValidAsOf(value: string): boolean {
  if (!AS_OF_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

interface PricingRow {
  model_id: string;
  price_in: string;
  price_out: string;
  price_cache_r: string;
  price_cache_w_5m: string;
  price_cache_w_1h: string;
  price_web_search: string;
  chars_per_token: string | null;
  context_length: number | null;
  tiers: PricingTier[] | null;
}

/** One entry of `GET /api/v1/model-pricing`. `tiers` is present only when the model has tiers. */
export interface PublicModelPricingEntry {
  priceIn: number;
  priceOut: number;
  priceCacheR: number;
  priceCacheW5m: number;
  priceCacheW1h: number;
  priceWebSearch: number;
  charsPerToken: number | null;
  contextLength: number | null;
  tiers?: PricingTier[];
}

/**
 * Public (no auth guard): the hook needs its own token totals priced locally
 * before any session has been ingested, i.e. before it
 * could ever hold a valid session-scoped API key/cookie. Response shape is unchanged and
 * carries no per-user or per-session data — only the repo-wide `model_pricing` table.
 * `tiers` (prompt-length tiers) is emitted only for a model that has them, so entries of
 * untiered models stay byte-identical for old consumers.
 *
 * An optional `asOf=YYYY-MM-DD` returns the rates in force on that date (the client
 * passes a session's UTC start date so its per-turn costs match the server's session price
 * date). Without it the rates are today's — the hook never sends it.
 */
@Controller('api/v1/model-pricing')
export class ModelPricingController {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  @Get()
  async getModelPricing(
    @Query('asOf') asOf?: string,
  ): Promise<Record<string, PublicModelPricingEntry>> {
    if (asOf !== undefined && !isValidAsOf(asOf)) {
      throw new BadRequestException('asOf must be a date in YYYY-MM-DD format');
    }
    const priceDate =
      asOf !== undefined ? sql`${asOf}::date` : sql`CURRENT_DATE`;
    const result = await this.db.execute(sql`
      SELECT DISTINCT ON (model_id) model_id,
             price_in, price_out, price_cache_r,
             price_cache_w_5m, price_cache_w_1h, price_web_search,
             chars_per_token, context_length, tiers
      FROM model_pricing
      WHERE effective_from <= ${priceDate}
      ORDER BY model_id, effective_from DESC
    `);

    const rows = result.rows as unknown as PricingRow[];

    if (rows.length === 0) {
      return {};
    }

    return Object.fromEntries(
      rows.map((row): [string, PublicModelPricingEntry] => {
        const entry: PublicModelPricingEntry = {
          priceIn: parseFloat(row.price_in),
          priceOut: parseFloat(row.price_out),
          priceCacheR: parseFloat(row.price_cache_r),
          priceCacheW5m: parseFloat(row.price_cache_w_5m),
          priceCacheW1h: parseFloat(row.price_cache_w_1h),
          priceWebSearch: parseFloat(row.price_web_search),
          charsPerToken:
            row.chars_per_token !== null
              ? parseFloat(row.chars_per_token)
              : null,
          contextLength: row.context_length,
        };
        const tiers = normalizeTiers(row.tiers);
        if (tiers !== null) entry.tiers = tiers;
        return [row.model_id, entry];
      }),
    );
  }
}
