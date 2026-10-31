import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import { OTEL_REALTIME_MAX_LINES } from './otel-facts.constants';
import type { OtelRealtimeResponse } from './otel-facts.types';
import { OtelRealtimeService } from './otel-realtime.service';

/**
 * `POST /api/v2/otel-realtime` request body (API changes, DD-13). `lines` are the receiver's
 * chunk-line objects, kept as plain objects (no nested validation: an unknown field or record
 * never fails ingest, DD-10).
 */
export class OtelRealtimeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sessionId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  hookVersion: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  receiverId: string;

  @IsInt()
  @Min(0)
  batchSeq: number;

  @IsInt()
  @Min(0)
  droppedLines: number;

  @IsArray()
  @ArrayMaxSize(OTEL_REALTIME_MAX_LINES)
  @IsObject({ each: true })
  lines: Record<string, unknown>[];
}

/**
 * The hook's realtime OTEL channel (DD-17): one synchronous ingest per batch, `ApiKeyAuthGuard`,
 * the shared `HOOK_API_BODY_LIMIT` (`common/body-limits.ts`). A hook older than this server never
 * calls it; a hook ≥ 2.29.0 talking to an older server gets 404 and disables realtime for an
 * hour (DD-13).
 *
 * - 400: malformed body, or more than `OTEL_REALTIME_MAX_LINES` lines;
 * - 409: the session belongs to another user;
 * - 200 `{ ignored: 'deleted' }`: the session is soft-deleted, nothing written.
 */
@Controller('api/v2/otel-realtime')
@UseGuards(ApiKeyAuthGuard)
export class OtelRealtimeController {
  constructor(private readonly otelRealtimeService: OtelRealtimeService) {}

  @Post()
  @HttpCode(200)
  async ingest(
    @Body() body: OtelRealtimeDto,
    @Req() req: Request & { userId: number },
  ): Promise<OtelRealtimeResponse> {
    const result = await this.otelRealtimeService.ingest(req.userId, body);
    if (result.status === 'foreign-session') {
      throw new ConflictException('Session belongs to another user');
    }
    return result.response;
  }
}
