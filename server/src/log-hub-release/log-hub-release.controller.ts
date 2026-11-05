import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { LogHubReleaseService } from './log-hub-release.service';
import type { LogHubReleaseState } from './log-hub-release.types';

/**
 * Admin-only read of the "new Log Hub release available" state. Read-only: the GitHub fetch
 * runs in the scheduler, never on this request.
 */
@Controller('api/v1/admin/log-hub-release')
@UseGuards(SessionAuthGuard, AdminGuard)
export class LogHubReleaseController {
  constructor(private readonly service: LogHubReleaseService) {}

  @Get()
  getState(): Promise<LogHubReleaseState> {
    return this.service.getState();
  }
}
