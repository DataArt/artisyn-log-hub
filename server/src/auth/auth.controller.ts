import { randomBytes } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { MailService } from '../mail/mail.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import {
  AUTH_RATE_LIMIT_ROUTES,
  AuthRateLimitService,
} from './auth-rate-limit.service';
import { AuthService } from './auth.service';
import { resolveAzureAuthority } from './azure/azure-authority';
import { AzureAuthService } from './azure/azure-auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ConfirmEmailDto } from './dto/confirm-email.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { IdentifyDto } from './dto/identify.dto';
import { LoginDto } from './dto/login.dto';
import { ResendConfirmationDto } from './dto/resend-confirmation.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { AllowedAuthModes, AuthModeGuard } from './guards/auth-mode.guard';
import { AutoIdentifyGuard } from './guards/auto-identify.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';
import { isLocalhostRequest } from './utils/localhost.util';

/**
 * Source IP for the auth rate limits. `req.ip` honours TRUST_PROXY (see
 * common/trust-proxy.ts); without it Express reports the socket peer.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly azureAuthService: AzureAuthService,
    private readonly accountDeletionService: AccountDeletionService,
    private readonly authRateLimit: AuthRateLimitService,
    private readonly mailService: MailService,
  ) {}

  @Get('config')
  config() {
    const mode = this.configService.get<string>('AUTH_MODE');
    const response: {
      mode: string | undefined;
      azure?: { authority: string; clientId: string; redirectUri: string };
      adminContactEmail?: string;
      passwordResetAvailable?: boolean;
    } = { mode };

    if (mode === 'azure-oauth') {
      response.azure = {
        authority: resolveAzureAuthority(this.configService),
        clientId: this.configService.get<string>('AZURE_CLIENT_ID', ''),
        redirectUri: this.configService.get<string>('AZURE_REDIRECT_URI', ''),
      };
    }
    if (mode === 'password' || mode === 'password-confirm') {
      response.adminContactEmail = this.configService.get<string>(
        'ADMIN_CONTACT_EMAIL',
      );
      // false in Mode 2 without SMTP_HOST: the client disables "Forgot password?".
      response.passwordResetAvailable = this.mailService.isConfigured();
    }
    return response;
  }

  @Post('identify')
  @HttpCode(200)
  @AllowedAuthModes('none')
  @UseGuards(AuthModeGuard)
  async identify(@Req() req: Request, @Body() dto: IdentifyDto) {
    if (!isLocalhostRequest(req)) {
      throw new ForbiddenException();
    }
    const user = await this.authService.identify(dto.email);
    await new Promise<void>((resolve, reject) =>
      req.logIn(user, (err) => (err ? reject(err as Error) : resolve())),
    );
    return this.authService.generatePublicProfile(user);
  }

  @Post('signup')
  @HttpCode(201)
  @AllowedAuthModes('password', 'password-confirm')
  @UseGuards(AuthModeGuard)
  async signup(@Req() req: Request, @Body() dto: SignupDto) {
    if (req.isAuthenticated()) {
      throw new BadRequestException('Already authenticated');
    }
    // Going over either the IP or the email limit is a 429.
    const route = AUTH_RATE_LIMIT_ROUTES.signup;
    await this.authRateLimit.consumeIp(route, clientIp(req));
    if (!(await this.authRateLimit.consumeEmail(route, dto.email))) {
      throw new TooManyRequestsException(
        await this.authRateLimit.emailRetryAfterSeconds(route, dto.email),
      );
    }
    const profile = await this.authService.signup(
      dto.email,
      dto.password,
      dto.passwordConfirm,
    );
    // password-confirm: the account is unconfirmed, so signup must not open
    // a session — the user confirms the email and then logs in.
    if (this.configService.get<string>('AUTH_MODE') === 'password-confirm') {
      return profile;
    }
    // Need the full user row for req.logIn; validateUser won't return null since we just created the user
    const fullUser = await this.authService.validateUser(
      dto.email,
      dto.password,
    );
    if (!fullUser) {
      throw new Error('User not found after signup');
    }
    await new Promise<void>((resolve, reject) =>
      req.logIn(fullUser, (err) => (err ? reject(err as Error) : resolve())),
    );
    return profile;
  }

  @Post('login')
  @HttpCode(200)
  @AllowedAuthModes('password', 'password-confirm')
  @UseGuards(AuthModeGuard, LocalAuthGuard)
  async login(@Req() req: Request, @Body() _dto: LoginDto) {
    const user = req.user as {
      id: number;
      email: string;
      role: 'admin' | 'user';
      createdAt: Date;
    };
    await new Promise<void>((resolve, reject) =>
      req.logIn(user, (err) => (err ? reject(err as Error) : resolve())),
    );
    return this.authService.generatePublicProfile(user);
  }

  @Get('azure')
  @AllowedAuthModes('azure-oauth')
  @UseGuards(AuthModeGuard)
  async azure(@Req() req: Request, @Res() res: Response) {
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const session = req.session as unknown as Record<string, unknown>;
    session['oauthState'] = state;
    session['oauthNonce'] = nonce;
    const url = await this.azureAuthService.getAuthCodeUrl(state, nonce);
    res.redirect(url);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard)
  logout(@Req() req: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      req.session.destroy((err) => {
        if (err) {
          reject(err as Error);
          return;
        }
        req.res?.clearCookie('connect.sid');
        resolve();
      });
    });
  }

  @Post('confirm-email')
  @HttpCode(200)
  @AllowedAuthModes('password-confirm')
  @UseGuards(AuthModeGuard)
  async confirmEmail(@Body() dto: ConfirmEmailDto) {
    return this.authService.confirmEmail(dto.token);
  }

  @Post('resend-confirmation')
  @HttpCode(200)
  @AllowedAuthModes('password-confirm')
  @UseGuards(AuthModeGuard)
  async resendConfirmation(
    @Req() req: Request,
    @Body() dto: ResendConfirmationDto,
  ) {
    // The IP limit is a 429; the email limit answers with
    // the normal (enumeration-safe) success response and sends nothing.
    const route = AUTH_RATE_LIMIT_ROUTES.resend;
    await this.authRateLimit.consumeIp(route, clientIp(req));
    if (!(await this.authRateLimit.consumeEmail(route, dto.email))) {
      return { email_delivery: 'sent' as const };
    }
    return this.authService.resendConfirmation(dto.email);
  }

  @Post('forgot-password')
  @HttpCode(200)
  @AllowedAuthModes('password', 'password-confirm')
  @UseGuards(AuthModeGuard)
  async forgotPassword(@Req() req: Request, @Body() dto: ForgotPasswordDto) {
    // Same split as resend-confirmation.
    const route = AUTH_RATE_LIMIT_ROUTES.forgot;
    await this.authRateLimit.consumeIp(route, clientIp(req));
    if (!(await this.authRateLimit.consumeEmail(route, dto.email))) {
      return { email_delivery: 'sent' as const };
    }
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  @AllowedAuthModes('password', 'password-confirm')
  @UseGuards(AuthModeGuard)
  async resetPassword(@Req() req: Request, @Body() dto: ResetPasswordDto) {
    // IP limit only — the request carries a token, not an email.
    await this.authRateLimit.consumeIp(
      AUTH_RATE_LIMIT_ROUTES.reset,
      clientIp(req),
    );
    return this.authService.resetPassword(
      dto.token,
      dto.password,
      dto.passwordConfirm,
    );
  }

  @Post('change-password')
  @HttpCode(200)
  @AllowedAuthModes('password', 'password-confirm')
  @UseGuards(AuthModeGuard, SessionAuthGuard)
  async changePassword(@Req() req: Request, @Body() dto: ChangePasswordDto) {
    const user = req.user as { id: number };
    // req.sessionID identifies the caller's own auth_sessions row, which is
    // the one session that survives the change — every other device is signed
    // out.
    return this.authService.changePassword(user.id, req.sessionID, dto);
  }

  @Post('delete-account')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard)
  async deleteAccount(
    @Req() req: Request,
    @Body() _dto: DeleteAccountDto,
  ): Promise<void> {
    const user = req.user as { id: number };
    await this.accountDeletionService.hardDeleteUser(user.id, {
      actingUserId: user.id,
      via: 'self-service',
    });

    // Unlike logout(), a failure of session.destroy() must NOT reject here.
    // hardDeleteUser has already pruned every auth_sessions row for this user,
    // including the caller's own, so connect-pg-simple's destroy() runs against
    // a row that is already gone. Rejecting would turn a fully successful
    // account deletion into a 500 for the client. The cookie is cleared either
    // way — it can no longer resolve to a session.
    await new Promise<void>((resolve) => {
      req.session.destroy(() => {
        req.res?.clearCookie('connect.sid');
        resolve();
      });
    });
  }

  @Get('me')
  @UseGuards(AutoIdentifyGuard, SessionAuthGuard)
  me(@Req() req: Request) {
    const user = req.user as {
      id: number;
      email: string;
      role: 'admin' | 'user';
      createdAt: Date;
    };
    return this.authService.generatePublicProfile(user);
  }
}
