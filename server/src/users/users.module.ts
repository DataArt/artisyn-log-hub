import { Module } from '@nestjs/common';
import { AuthSessionsService } from '../auth/auth-sessions.service';
import { AccountDeletionService } from './account-deletion.service';
import { UsersService } from './users.service';

@Module({
  // `AuthSessionsService` is declared here rather than imported from
  // `AuthModule`: `AuthModule` already imports `UsersModule`, so importing it
  // back would make the module graph circular. The service is stateless and
  // depends only on the globally provided `DRIZZLE` connection, so this second
  // instance behaves identically to the one `AuthModule` provides.
  providers: [UsersService, AuthSessionsService, AccountDeletionService],
  exports: [UsersService, AccountDeletionService],
})
export class UsersModule {}
