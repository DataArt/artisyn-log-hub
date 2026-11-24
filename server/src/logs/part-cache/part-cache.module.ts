import { Global, Module } from '@nestjs/common';
import { PartCacheService } from './part-cache.service';

/**
 * Global module of the session log part disk cache (impl-plan DD-3 of
 * 2026-11-24-session-parts-disk-cache): one `PartCacheService` per worker, injectable by the
 * parts reader, the delete paths and the system info service without importing this module.
 */
@Global()
@Module({
  providers: [PartCacheService],
  exports: [PartCacheService],
})
export class PartCacheModule {}
