import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashPassword, comparePassword } from '../utils/password-hash';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { AuthSessionsService } from './auth-sessions.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  ConsumeResult,
  PasswordResetTokensService,
} from './password-reset-tokens.service';
import { RESET_LINK_TTL_MS } from './password-link-ttl';
import { PLACEHOLDER_IMPORT_USER_PASSWORD_HASH } from '../logs/logs.service';
import { EmailConfirmationTokensService } from './email-confirmation-tokens.service';
import { applyPasswordPolicy } from './utils/password-policy';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';
import { parseAllowedEmailDomains } from './config/allowed-email-domains';
import { getEmailLinkBaseUrl } from '../common/public-base-url';
import { maskEmail } from '../common/mask-email';
import { buildResetUrl } from './password-link-url';

/** 'skipped' = SMTP not configured for this mode (MailService.isConfigured() is false). */
export type NotificationDelivery = 'sent' | 'failed' | 'skipped';

@Injectable()
export class AuthService {
  /**
   * Security event log. Every line below carries masked emails
   * (`maskEmail`) and user ids only — never a password, a password hash, or a reset/confirmation token,
   * any of which would turn the log file into a credential store.
   */
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly passwordResetTokensService: PasswordResetTokensService,
    private readonly emailConfirmationTokensService: EmailConfirmationTokensService,
    private readonly mailService: MailService,
    private readonly authSessionsService: AuthSessionsService,
  ) {}

  async signup(email: string, password: string, passwordConfirm: string) {
    if (password !== passwordConfirm) {
      throw new BadRequestException({
        error: 'password_mismatch',
        message: 'Passwords do not match',
      });
    }

    this.assertEmailDomainAllowed(email, 'signup');

    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    applyPasswordPolicy(password);

    const totalUsers = await this.usersService.countAll();
    const role = totalUsers === 0 ? 'admin' : 'user';

    const passwordHash = await hashPassword(password);
    const user = await this.usersService.create(email, passwordHash, role);
    const profile = this.generatePublicProfile(user);
    this.logger.log(
      `Signup: email=${maskEmail(user.email)} userId=${user.id} role=${role}`,
    );

    if (this.configService.get<string>('AUTH_MODE') === 'password-confirm') {
      const tokenRow = await this.emailConfirmationTokensService.create(
        user.id,
      );
      const confirmUrl = this.buildConfirmUrl(tokenRow.token);
      const email_delivery =
        confirmUrl === null
          ? 'failed'
          : await this.mailService.sendConfirmationEmail(
              user.email,
              confirmUrl,
            );
      return { ...profile, email_delivery };
    }

    return profile;
  }

  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) return null;
    // Accounts provisioned without a local password (Mode 1/4) have
    // passwordHash === null — comparePassword expects a plain string, so this
    // must short-circuit before calling it.
    if (!user.passwordHash) return null;
    const match = await comparePassword(password, user.passwordHash);
    if (!match) return null;
    return user;
  }

  /** Mode 1 — no password, ever. Auto-provisions on first visit. */
  async identify(email: string) {
    const user = await this.usersService.findOrCreateAutoProvisioned(email);
    await this.usersService.acceptGrantedInvitations(user.id);
    return user;
  }

  /**
   * Mode 1 auto-login: called instead of the manual identify step whenever an
   * unauthenticated localhost request comes in with no session (see
   * AutoIdentifyGuard). A single existing user is assumed to be "you"; with
   * more than one (e.g. e2e test leftovers), user id 1 is assumed to be the
   * real dev account. Returns null for zero users (nothing to auto-select) or
   * a missing id 1, so the caller falls back to the manual identify form.
   */
  async autoIdentifyMode1() {
    const total = await this.usersService.countAll();
    if (total === 0) return null;
    const user =
      total === 1
        ? ((await this.usersService.findAll())[0] ?? null)
        : await this.usersService.findById(1);
    if (user) await this.usersService.acceptGrantedInvitations(user.id);
    return user;
  }

  async confirmEmail(token: string) {
    const result = await this.emailConfirmationTokensService.consume(token);
    if (result.status !== 'ok') {
      this.logger.warn(`Email confirmation failed: reason=${result.status}`);
    }
    if (result.status === 'unknown') {
      throw new BadRequestException('Invalid or unknown token');
    }
    if (result.status === 'expired') {
      throw new GoneException('Token has expired');
    }
    if (result.status === 'already_used') {
      throw new ConflictException('Email already confirmed');
    }

    const user = await this.usersService.markEmailConfirmed(result.userId);
    this.logger.log(
      `Email confirmed: email=${maskEmail(user.email)} userId=${user.id}`,
    );
    return this.generatePublicProfile(user);
  }

  async resendConfirmation(
    email: string,
  ): Promise<{ email_delivery: 'sent' | 'failed' }> {
    const user = await this.usersService.findByEmail(email);
    // Enumeration-safe: no account, or already confirmed, both report success
    // with no email actually sent.
    if (!user || user.emailConfirmedAt) {
      return { email_delivery: 'sent' };
    }

    const result = await this.emailConfirmationTokensService.issueWithCooldown(
      user.id,
    );
    if (result.status === 'cooldown') {
      throw new TooManyRequestsException(result.retryAfterSeconds);
    }

    const confirmUrl = this.buildConfirmUrl(result.token);
    if (confirmUrl === null) return { email_delivery: 'failed' };
    const email_delivery = await this.mailService.sendConfirmationEmail(
      user.email,
      confirmUrl,
    );
    return { email_delivery };
  }

  async forgotPassword(
    email: string,
  ): Promise<{ email_delivery: 'sent' | 'failed' }> {
    // Mode 2 without SMTP: no reset is possible, so issue no token. Answered
    // before the user lookup to stay enumeration-safe.
    if (!this.mailService.isConfigured()) return { email_delivery: 'failed' };
    const user = await this.usersService.findByEmail(email);
    // Enumeration-safe; not gated on passwordHash being non-null (works for
    // OAuth-only accounts too — needed for the Mode 4 → Mode 2/3 switch-back).
    if (!user) {
      this.logger.warn(
        `Password reset requested for an unknown email: email=${maskEmail(email)}`,
      );
      return { email_delivery: 'sent' };
    }

    // strict-managed: an import placeholder is not an account anyone was
    // given — its mailbox owner must not be able to claim it.
    if (
      this.configService.get<string>('AUTH_MODE') === 'strict-managed' &&
      user.passwordHash === PLACEHOLDER_IMPORT_USER_PASSWORD_HASH
    ) {
      this.logger.warn(
        `Password reset refused for an import placeholder: email=${maskEmail(user.email)} userId=${user.id}`,
      );
      return { email_delivery: 'sent' };
    }

    // From here on every answer is the same 200 'sent' as for an unknown
    // email, and the email goes out without being awaited: a status code or
    // an SMTP round-trip must not tell a caller that the account exists.
    const result = await this.passwordResetTokensService.issueWithCooldown(
      user.id,
      'reset',
      RESET_LINK_TTL_MS,
      user.email,
    );
    if (result.status === 'stale') {
      this.logger.warn(
        `Password reset skipped, the account's email changed meanwhile: email=${maskEmail(user.email)} userId=${user.id}`,
      );
      return { email_delivery: 'sent' };
    }
    if (result.status === 'cooldown') {
      this.logger.warn(
        `Password reset blocked by cooldown: email=${maskEmail(user.email)} userId=${user.id} retryAfterSeconds=${result.retryAfterSeconds}`,
      );
      return { email_delivery: 'sent' };
    }
    this.logger.log(
      `Password reset token issued: email=${maskEmail(user.email)} userId=${user.id}`,
    );

    // A password-less account (admin-created, never set) gets "set" wording.
    const noPassword = user.passwordHash === null;
    const resetUrl = buildResetUrl(
      result.token,
      this.logger,
      noPassword ? 'set' : undefined,
    );
    if (resetUrl === null) return { email_delivery: 'sent' };
    void (noPassword
      ? this.mailService.sendSetPasswordOnRequestEmail(user.email, resetUrl)
      : this.mailService.sendPasswordResetEmail(user.email, resetUrl));
    return { email_delivery: 'sent' };
  }

  async adminGenerateResetLink(
    baseUrl: string,
    userId: number,
  ): Promise<string> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const resetToken = await this.passwordResetTokensService.create(user.id);
    // Returned in the response body to an authenticated admin, not emailed —
    // so it keeps the request-derived base URL.
    return `${baseUrl}/#/reset-password?token=${resetToken.token}`;
  }

  async resetPassword(
    token: string,
    password: string,
    passwordConfirm: string,
  ) {
    // Check the link, validate the new password, and only then use the link
    // up: a typo or a too-weak password must not burn a one-time link.
    const checked = this.assertTokenUsable(
      await this.passwordResetTokensService.check(token),
    );

    if (password !== passwordConfirm) {
      this.logger.warn(
        `Password reset failed: reason=password_mismatch userId=${checked.userId}`,
      );
      throw new BadRequestException({
        error: 'password_mismatch',
        message: 'Passwords do not match',
      });
    }
    try {
      applyPasswordPolicy(password);
    } catch (err) {
      this.logger.warn(
        `Password reset failed: reason=weak_password userId=${checked.userId}`,
      );
      throw err;
    }

    const result = this.assertTokenUsable(
      await this.passwordResetTokensService.consume(token),
    );
    const passwordHash = await hashPassword(password);
    const user = await this.usersService.updatePassword(
      result.userId,
      passwordHash,
    );
    // strict-managed: admin-created and bootstrap accounts start unconfirmed;
    // the emailed link proves the mailbox, so a later switch to
    // password-confirm does not lock them out.
    if (this.configService.get<string>('AUTH_MODE') === 'strict-managed') {
      const full = await this.usersService.findById(user.id);
      if (full && full.emailConfirmedAt === null) {
        await this.usersService.markEmailConfirmed(user.id);
      }
    }
    // Whoever held a session for this account (a stolen one, or one from an
    // earlier auth mode) is signed out by the reset, as by a password change.
    await this.authSessionsService.deleteAllSessionsForUser(user.id);
    this.logger.log(
      `Password reset succeeded: email=${maskEmail(user.email)} userId=${user.id}`,
    );
    return this.generatePublicProfile(user);
  }

  /** Maps a non-`ok` token status to its HTTP error (400 / 410 / 409). */
  private assertTokenUsable(result: ConsumeResult): { userId: number } {
    if (result.status === 'ok') return result;
    this.logger.warn(`Password reset failed: reason=${result.status}`);
    if (result.status === 'unknown') {
      throw new BadRequestException('Invalid or unknown token');
    }
    if (result.status === 'expired') {
      throw new GoneException('Token has expired');
    }
    throw new ConflictException('Token already used');
  }

  /**
   * Self-service password change for an already-authenticated user.
   * `currentSid` is the requesting session's `req.sessionID` — it is the one
   * session kept alive; every other device is signed out.
   */
  async changePassword(
    userId: number,
    currentSid: string,
    dto: ChangePasswordDto,
  ) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    // Accounts provisioned without a local password (Mode 1/4) have nothing to
    // compare against — there is no "current password" for them to prove.
    if (!user.passwordHash) {
      this.logChangePasswordFailure(user, 'no_local_password');
      throw new BadRequestException({
        error: 'no_local_password',
        message: 'This account has no password set',
      });
    }

    const matches = await comparePassword(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!matches) {
      this.logChangePasswordFailure(user, 'invalid_current_password');
      // 403, not 401: the client's apiFetch() force-logs
      // out on any 401, which would kick the user out of the dialog.
      throw new ForbiddenException({
        error: 'invalid_current_password',
        message: 'Current password is incorrect',
      });
    }

    if (dto.password !== dto.passwordConfirm) {
      this.logChangePasswordFailure(user, 'password_mismatch');
      throw new BadRequestException({
        error: 'password_mismatch',
        message: 'Passwords do not match',
      });
    }
    try {
      applyPasswordPolicy(dto.password);
    } catch (err) {
      this.logChangePasswordFailure(user, 'weak_password');
      throw err;
    }

    const passwordHash = await hashPassword(dto.password);
    const updated = await this.usersService.updatePassword(
      user.id,
      passwordHash,
    );

    await this.authSessionsService.deleteOtherSessionsForUser(
      user.id,
      currentSid,
    );

    // Best-effort notification: never fails the change itself.
    const email_delivery: NotificationDelivery = this.mailService.isConfigured()
      ? await this.mailService.sendPasswordChangedEmail(user.email)
      : 'skipped';

    this.logger.log(
      `Password changed: email=${maskEmail(user.email)} userId=${user.id} otherSessionsRevoked=true emailDelivery=${email_delivery}`,
    );

    return { ...this.generatePublicProfile(updated), email_delivery };
  }

  private logChangePasswordFailure(
    user: { id: number; email: string },
    reason: string,
  ): void {
    this.logger.warn(
      `Password change failed: email=${maskEmail(user.email)} userId=${user.id} reason=${reason}`,
    );
  }

  /**
   * Email domain allow-list for `password-confirm` sign-up and
   * `strict-managed` admin-created accounts. Exact match on the part after
   * the last `@`; an unset or empty `ALLOWED_EMAIL_DOMAINS` allows every
   * domain. Other modes ignore the setting.
   */
  assertEmailDomainAllowed(
    email: string,
    context: 'signup' | 'admin-create',
  ): void {
    const mode = this.configService.get<string>('AUTH_MODE');
    if (mode !== 'password-confirm' && mode !== 'strict-managed') {
      return;
    }
    const allowed = parseAllowedEmailDomains(
      this.configService.get<string>('ALLOWED_EMAIL_DOMAINS'),
    );
    if (allowed.length === 0) return;
    const domain = email
      .slice(email.lastIndexOf('@') + 1)
      .trim()
      .toLowerCase();
    if (!allowed.includes(domain)) {
      throw new BadRequestException({
        error: 'email_domain_not_allowed',
        message:
          context === 'admin-create'
            ? `This server only accepts these email domains: ${allowed.join(', ')}`
            : `Sign-up is limited to these email domains: ${allowed.join(', ')}`,
      });
    }
  }

  /** Emailed link; `null` when `PUBLIC_BASE_URL` is missing (email skipped). */
  private buildConfirmUrl(token: string): string | null {
    const base = getEmailLinkBaseUrl(this.logger);
    return base === null ? null : `${base}/#/confirm-email?token=${token}`;
  }

  generatePublicProfile(user: {
    id: number;
    email: string;
    role: 'admin' | 'user';
    createdAt: Date;
  }) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      created_at: user.createdAt,
      env_name: this.configService.get<string>('ENV_NAME') ?? 'local',
    };
  }
}
