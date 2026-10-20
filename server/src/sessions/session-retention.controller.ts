import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminOrTeamOwnerGuard } from '../common/guards/admin-or-team-owner.guard';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { SessionRetentionService } from './session-retention.service';
import { SessionsService } from './sessions.service';
import type { RetentionStats } from './sessions.service';

interface RetentionResponse extends RetentionStats {
  retentionDays: number;
}

@Controller('api/v1/admin/retention')
@UseGuards(SessionAuthGuard, AdminOrTeamOwnerGuard)
export class SessionRetentionController {
  constructor(
    private readonly sessionRetentionService: SessionRetentionService,
    private readonly sessionsService: SessionsService,
  ) {}

  @Get()
  async getRetention(): Promise<RetentionResponse> {
    return {
      retentionDays: this.sessionRetentionService.getRetentionDays(),
      ...(await this.sessionsService.getRetentionStats()),
    };
  }
}
