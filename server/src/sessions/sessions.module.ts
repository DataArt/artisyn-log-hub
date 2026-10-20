import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminOrTeamOwnerGuard } from '../common/guards/admin-or-team-owner.guard';
import { DatabaseModule } from '../database/database.module';
import { LogsModule } from '../logs/logs.module';
import { SessionRetentionController } from './session-retention.controller';
import { SessionRetentionService } from './session-retention.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [DatabaseModule, LogsModule, ScheduleModule.forRoot()],
  controllers: [SessionsController, SessionRetentionController],
  providers: [SessionsService, SessionRetentionService, AdminOrTeamOwnerGuard],
  exports: [SessionsService],
})
export class SessionsModule {}
