import { Module } from '@nestjs/common';
import { SystemInfoService } from './system-info.service';

@Module({
  // PG_POOL is provided by the @Global() DatabaseModule — no explicit import needed here.
  providers: [SystemInfoService],
  exports: [SystemInfoService],
})
export class SystemInfoModule {}
