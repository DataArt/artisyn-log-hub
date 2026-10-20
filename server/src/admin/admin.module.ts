import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../common/guards/admin.guard';
import { ErrorLogsModule } from '../error-logs/error-logs.module';
import { LogsModule } from '../logs/logs.module';
import { MailModule } from '../mail/mail.module';
import { ReleasesModule } from '../releases/releases.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SystemInfoModule } from '../system-info/system-info.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminPanelController } from './admin-panel.controller';
import { AdminService } from './admin.service';
import { UploadQueueAdminService } from './upload-queue-admin.service';
import { UploadQueueStatsService } from './upload-queue-stats.service';

@Module({
  imports: [
    UsersModule,
    SystemInfoModule,
    ErrorLogsModule,
    LogsModule,
    MailModule,
    AuthModule,
    ReleasesModule,
    SessionsModule,
  ],
  controllers: [AdminController, AdminPanelController],
  providers: [
    AdminGuard,
    AdminService,
    UploadQueueAdminService,
    UploadQueueStatsService,
  ],
})
export class AdminModule {}
