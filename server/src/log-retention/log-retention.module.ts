import { Module } from '@nestjs/common';
import { LogRetentionService } from './log-retention.service';

@Module({
  providers: [LogRetentionService],
})
export class LogRetentionModule {}
