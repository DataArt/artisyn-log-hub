import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AiToolVersionsController } from './ai-tool-versions.controller';
import { AiToolVersionsScheduler } from './ai-tool-versions.scheduler';
import { AiToolVersionsService } from './ai-tool-versions.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AiToolVersionsController],
  providers: [AiToolVersionsService, AiToolVersionsScheduler],
  exports: [AiToolVersionsService],
})
export class AiToolVersionsModule {}
