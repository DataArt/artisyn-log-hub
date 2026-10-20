import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthSessionsService } from './auth-sessions.service';
import { AzureAuthService } from './azure/azure-auth.service';
import { AzureCallbackController } from './azure/azure-callback.controller';
import { EmailConfirmationTokensService } from './email-confirmation-tokens.service';
import { AuthModeGuard } from './guards/auth-mode.guard';
import { AutoIdentifyGuard } from './guards/auto-identify.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { LocalStrategy } from './local.strategy';
import { LoginBackoffService } from './login-backoff.service';
import { PasswordResetTokensService } from './password-reset-tokens.service';
import { PingController } from './ping.controller';
import { SessionSerializer } from './session.serializer';

@Module({
  imports: [
    UsersModule,
    MailModule,
    PassportModule.register({ session: true }),
  ],
  controllers: [AuthController, AzureCallbackController, PingController],
  providers: [
    AuthService,
    AuthRateLimitService,
    AuthSessionsService,
    PasswordResetTokensService,
    EmailConfirmationTokensService,
    AuthModeGuard,
    AutoIdentifyGuard,
    AzureAuthService,
    LoginBackoffService,
    LocalStrategy,
    SessionSerializer,
    LocalAuthGuard,
    SessionAuthGuard,
  ],
  exports: [
    AuthService,
    AuthSessionsService,
    SessionAuthGuard,
    EmailConfirmationTokensService,
    PasswordResetTokensService,
  ],
})
export class AuthModule {}
