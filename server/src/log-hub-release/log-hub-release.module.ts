import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LogHubReleaseController } from './log-hub-release.controller';
import { LogHubReleaseScheduler } from './log-hub-release.scheduler';
import { LogHubReleaseService } from './log-hub-release.service';

@Module({
  imports: [DatabaseModule],
  controllers: [LogHubReleaseController],
  providers: [LogHubReleaseService, LogHubReleaseScheduler],
  exports: [LogHubReleaseService],
})
export class LogHubReleaseModule {}
