import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminOrTeamOwnerGuard } from '../common/guards/admin-or-team-owner.guard';
import { DatabaseModule } from '../database/database.module';
import { LogsModule } from '../logs/logs.module';
import { DeletedSessionCleanupService } from './deleted-session-cleanup.service';
import { SessionRetentionController } from './session-retention.controller';
import { SessionRetentionService } from './session-retention.service';
import { SessionTombstoneService } from './session-tombstone.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * `forwardRef(() => LogsModule)`: `LogsModule` imports this module back for
 * `SessionTombstoneService` (DD-27 of 2026-11-23-session-logs-streaming), so both sides break
 * the cycle with `forwardRef()`.
 */
@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => LogsModule),
    ScheduleModule.forRoot(),
  ],
  controllers: [SessionsController, SessionRetentionController],
  providers: [
    SessionsService,
    SessionRetentionService,
    SessionTombstoneService,
    DeletedSessionCleanupService,
    AdminOrTeamOwnerGuard,
  ],
  exports: [SessionsService, SessionTombstoneService],
})
export class SessionsModule {}
