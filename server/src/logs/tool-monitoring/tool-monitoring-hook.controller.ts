import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import { normalizeRepoUrl } from '../repo-url-normalizer';
import { ToolMonitorConfigService } from './tool-monitor-config.service';
import type { HookToolMonitorConfigResponse } from './tool-monitoring.types';

/**
 * The hook-facing monitored-tools config (impl-plan DD-3, DD-16): the API key's user's merged
 * personal ∪ team list for `repoUrl` (DD-2, `resolveMonitoredTools`). Normalizes `repoUrl` first,
 * like every other `repoUrl`-taking hook route (`post-turn-analysis.controller.ts`). An unknown
 * repository answers with an empty list.
 *
 * Versioning (FR-6): the hook acts only on `schemaVersion === 1` fields and ignores unknown
 * ones, so later servers add fields without bumping the version and bump it only for a
 * breaking change. Old hooks never call this route; new hooks treat a non-200 or a timeout as
 * "no config".
 */
@Controller('api/v2/tool-monitoring')
@UseGuards(ApiKeyAuthGuard)
export class ToolMonitoringHookController {
  constructor(private readonly configService: ToolMonitorConfigService) {}

  @Get('config')
  async getConfig(
    @Query('repoUrl') repoUrl: string | undefined,
    @Req() req: Request & { userId: number },
  ): Promise<HookToolMonitorConfigResponse> {
    if (typeof repoUrl !== 'string' || repoUrl.length === 0) {
      throw new BadRequestException('Missing repoUrl query parameter');
    }
    const resolved = await this.configService.resolveMonitoredTools(
      req.userId,
      normalizeRepoUrl(repoUrl),
    );
    return {
      schemaVersion: 1,
      paused: resolved.paused,
      tools: resolved.tools.map((t) => ({ name: t.name, capture: t.capture })),
    };
  }
}
