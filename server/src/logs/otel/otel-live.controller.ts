import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard';
import type { AuthUser } from '../repositories.service';
import { single, tzParam, type RawQuery } from './otel-facts.controller';
import { OtelLiveReader } from './otel-live.reader';
import type {
  OtelLiveResponse,
  OtelLiveStatusResponse,
} from './otel-live.types';

/** Upper bound on a node key (`agent:<root>:<255-char agent id>@<team>` fits well inside). */
const NODE_KEY_MAX_CHARS = 320;

/** An optional node-key parameter: empty = absent, too long = 400 (grammar is the reader's). */
function nodeKeyParam(raw: RawQuery, name: string): string | undefined {
  const value = single(raw, name);
  if (value === undefined || value === '') return undefined;
  if (value.length > NODE_KEY_MAX_CHARS) {
    throw new BadRequestException(`${name} is not a valid live node key`);
  }
  return value;
}

/**
 * OTEL Live view (2026-11-04 otel-live-view): the header status and the live tree. Both routes
 * are user-wide — the caller's own sessions plus every team they belong to, each filtered by its
 * team scope — so they take no repository or team id.
 */
@Controller('api/v1/otel/live')
@UseGuards(SessionAuthGuard)
export class OtelLiveController {
  constructor(private readonly reader: OtelLiveReader) {}

  // Declared before `@Get()` so the literal path is matched first.
  @Get('status')
  async getStatus(@Req() req: Request): Promise<OtelLiveStatusResponse> {
    return this.reader.getStatus(req.user as AuthUser);
  }

  @Get()
  async getLive(
    @Req() req: Request,
    @Query() raw: RawQuery,
  ): Promise<OtelLiveResponse> {
    const node = nodeKeyParam(raw, 'node') ?? 'home';
    const panel = nodeKeyParam(raw, 'panel');
    const tz = tzParam(raw);
    return this.reader.getLive(req.user as AuthUser, { node, panel, tz });
  }
}
