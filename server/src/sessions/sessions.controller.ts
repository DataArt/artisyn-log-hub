import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { SessionRetentionService } from './session-retention.service';
import { SessionsService } from './sessions.service';

type AuthUser = { id: number; role: 'admin' | 'user' };

@Controller('api/v1/sessions')
@UseGuards(SessionAuthGuard)
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly sessionRetentionService: SessionRetentionService,
  ) {}

  /**
   * The effective session retention window, readable by any authenticated
   * user. The admin-only `GET /api/v1/admin/retention` serves the same number
   * alongside settings a regular user must not see.
   */
  @Get('retention-days')
  getRetentionDays(): { retentionDays: number } {
    return { retentionDays: this.sessionRetentionService.getRetentionDays() };
  }

  @Delete(':sessionId')
  @HttpCode(204)
  async deleteSession(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    const user = req.user as AuthUser;
    await this.sessionsService.deleteSession(user.id, user.role, sessionId);
  }
}
