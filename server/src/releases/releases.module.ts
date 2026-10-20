import { Module } from '@nestjs/common';
import { ReleaseDownloadController } from './release-download.controller';
import { ReleasesService } from './releases.service';

/**
 * Release zip inventory and downloads.
 *
 * `ReleasesService` is exported so `AdminModule` can inject it for the
 * admin-only inventory and link-mint endpoints; the public, unauthenticated
 * redeem controller lives in this module.
 */
@Module({
  controllers: [ReleaseDownloadController],
  providers: [ReleasesService],
  exports: [ReleasesService],
})
export class ReleasesModule {}
