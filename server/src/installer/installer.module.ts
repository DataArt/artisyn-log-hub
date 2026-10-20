import { Module } from '@nestjs/common';
import { InstallerController } from './installer.controller';

// Self-contained: no imports/providers/exports needed. Registered in AppModule's
// `imports`; its path is excluded from ServeStaticModule.
@Module({
  controllers: [InstallerController],
})
export class InstallerModule {}
