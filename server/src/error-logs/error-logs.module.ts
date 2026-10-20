import { Module } from '@nestjs/common';
import { ErrorLogsService } from './error-logs.service';

@Module({
  providers: [ErrorLogsService],
  exports: [ErrorLogsService],
})
export class ErrorLogsModule {}
