import { Global, Module } from '@nestjs/common';
import { CpuLoadSampler } from './cpu-load-sampler';
import { RebuildGovernor } from './rebuild-governor';

/**
 * Global module of the background-rebuild governor (impl-plan DD-15 of
 * 2026-11-23-session-logs-streaming): one CPU sampler and one `RebuildGovernor` per worker,
 * injectable by every drain without importing this module.
 */
@Global()
@Module({
  providers: [CpuLoadSampler, RebuildGovernor],
  exports: [RebuildGovernor],
})
export class LoadGovernorModule {}
