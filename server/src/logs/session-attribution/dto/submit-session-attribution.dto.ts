import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Nested `cost` block of `POST /api/v2/session-attribution`'s body (API
 * changes), same six fields the advisor's `TurnEndAdvisorCostDto` carries and the same six
 * columns `session_attribution_runs` persists (`session-attribution.service.ts`). All
 * optional: a `failed` outcome has no cost to report, and even a `submitted` one may have
 * spent nothing measurable.
 */
export class SessionAttributionCostDto {
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
 * `POST /api/v2/session-attribution` request body (API changes). The hook
 * POSTs exactly once per evaluation attempt, either `outcome: 'submitted'` with `values`/
 * `cost`, or `outcome: 'failed'` with `failureReason` and no `values`/`cost`.
 *
 * `values` is intentionally loosely typed here (`IsObject` only, no per-key shape check) —
 * per-attribute type validation against the resolved definitions is a server-side concern
 * that needs a DB round trip the DTO layer has no access to (`isOrphanedValue()`,
 * `attribute-filter.sql.ts`), not a request-shape concern.
 */
export class SubmitSessionAttributionDto {
  @IsString()
  sessionId: string;

  @IsInt()
  @Min(0)
  promptWatermark: number;

  @IsISO8601({ strict: true })
  startedAt: string;

  @IsISO8601({ strict: true })
  finishedAt: string;

  @IsString()
  invokingSessionId: string;

  @IsIn(['submitted', 'failed'])
  outcome: 'submitted' | 'failed';

  @IsOptional()
  @IsObject()
  values?: Record<string, string | string[] | boolean | number | null>;

  @IsOptional()
  @IsString()
  evalSessionId?: string | null;

  @IsOptional()
  @IsString()
  failureReason?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SessionAttributionCostDto)
  cost?: SessionAttributionCostDto;
}
