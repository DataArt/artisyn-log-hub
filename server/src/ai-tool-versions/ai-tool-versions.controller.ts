import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AI_TOOLS } from './ai-tool-versions.constants';
import { AiToolVersionsService } from './ai-tool-versions.service';
import type { AiToolVersionsResponse } from './ai-tool-versions.types';

/** Release-version history of known AI tools (e.g. `claude-code`). */
@Controller('api/v1/ai-tool-versions')
@UseGuards(SessionAuthGuard)
export class AiToolVersionsController {
  constructor(private readonly aiToolVersionsService: AiToolVersionsService) {}

  @Get(':toolName')
  getHistory(
    @Param('toolName') toolName: string,
  ): Promise<AiToolVersionsResponse> {
    if (!Object.prototype.hasOwnProperty.call(AI_TOOLS, toolName)) {
      throw new NotFoundException(`Unknown AI tool "${toolName}"`);
    }
    return this.aiToolVersionsService.getHistory(toolName);
  }
}
