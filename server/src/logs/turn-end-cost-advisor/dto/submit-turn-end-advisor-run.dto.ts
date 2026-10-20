import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Nested `summary` block of `POST /api/v2/turn-end-cost-advisor`'s body
 * (API changes). Present only when `outcome: 'submitted'`; the controller does not
 * enforce that conditionality itself (a `failed` submission with no `summary` at all is
 * the normal case, and there is no harm in a `submitted` one that happens to omit it —
 * the stored columns simply stay `null`).
 */
export class TurnEndAdvisorSummaryDto {
  @IsString()
  general: string;

  @IsString({ each: true })
  costFactors: string[];

  @IsString({ each: true })
  harnessAdvice: string[];
}

/**
 * Nested `cost` block, same six fields `TurnEndCostAdvisorService`'s
 * `RecordTurnEndAdvisorRunInput` persists (`turn-end-cost-advisor.service.ts`). All
 * optional: a `failed` outcome has no cost to report, and even a `submitted` one may
 * have spent nothing measurable.
 */
export class TurnEndAdvisorCostDto {
  @IsOptional()
  @IsString()
  model?: string | null;

  @IsOptional()
  @IsNumber()
  costUsd?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  inputTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  outputTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cacheReadTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cacheWriteTokens?: number;
}

/**
 * `POST /api/v2/turn-end-cost-advisor` request body (API changes). The
 * hook POSTs exactly once per evaluation attempt, either `outcome: 'submitted'` with
 * `summary`/`cost`, or `outcome: 'failed'` with `failureReason` and no `summary`/`cost`.
 */
export class SubmitTurnEndAdvisorRunDto {
  @IsString()
  sessionId: string;

  @IsISO8601({ strict: true })
  startedAt: string;

  @IsISO8601({ strict: true })
  finishedAt: string;

  @IsIn(['submitted', 'failed'])
  outcome: 'submitted' | 'failed';

  @IsOptional()
  @IsString()
  evalSessionId?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => TurnEndAdvisorSummaryDto)
  summary?: TurnEndAdvisorSummaryDto;

  @IsOptional()
  @IsString()
  failureReason?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => TurnEndAdvisorCostDto)
  cost?: TurnEndAdvisorCostDto;
}
