import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_PRICING_TIERS,
  MAX_RATE,
  MAX_TIER_THRESHOLD,
} from '../model-pricing.constants';

/** Largest `chars_per_token` that `numeric(6,3)` holds. */
const MAX_CHARS_PER_TOKEN = 999.999;

/** Upper bound of an admin-entered context length. */
const MAX_CONTEXT_LENGTH = 100_000_000;

/**
 * One prompt-length tier of an admin price input (DD1). Rates are USD per million tokens and
 * apply to a call whose prompt size is strictly greater than `aboveTokens`. Ordering and
 * uniqueness of thresholds are checked by `validatePricingTiers` in the admin service.
 */
export class PricingTierDto {
  @IsInt()
  @Min(1)
  @Max(MAX_TIER_THRESHOLD)
  aboveTokens: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceIn: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceOut: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceCacheR: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceCacheW5m: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceCacheW1h: number;
}

/**
 * Admin price input shared by `PUT /price` and `PUT /override`. Token rates are USD
 * per million tokens, `priceWebSearch` USD per request. Omitted optional fields get their
 * defaults in `ModelPricingAdminService` (cache writes from `priceIn` × multiplier, cache read
 * and web search 0, chars-per-token / context length / tiers carried from the current effective
 * row). `tiers: null` or `[]` clears the tiers.
 */
export class ModelPriceInputDto {
  @IsString()
  @Length(1, 255)
  modelId: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceIn: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceOut: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceCacheR?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceCacheW5m?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceCacheW1h?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_RATE)
  priceWebSearch?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_CHARS_PER_TOKEN)
  charsPerToken?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(MAX_CONTEXT_LENGTH)
  contextLength?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRICING_TIERS)
  @ValidateNested({ each: true })
  @Type(() => PricingTierDto)
  tiers?: PricingTierDto[] | null;
}
