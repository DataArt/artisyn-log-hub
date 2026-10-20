import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { maskEmail } from '../common/mask-email';

export type EmailDelivery = 'sent' | 'failed';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string | undefined;

  constructor(private readonly configService: ConfigService) {
    // No fallback defaults here: auth-startup-validation.ts guarantees
    // SMTP_HOST/SMTP_PORT/SMTP_FROM are set whenever Mode 3 (password-confirm)
    // is active — a code-level default would only mask a validator bug. Mode 2
    // (password) does not require these to be set: its only email-dependent
    // feature is "forgot password", which is best-effort (see send() below),
    // so an unconfigured transport there just means every reset email fails
    // gracefully. Modes 1/4 never call a send method at all, so an
    // unconfigured transport is harmless for them too.
    const user = this.configService.get<string>('SMTP_USER');
    const password = this.configService.get<string>('SMTP_PASSWORD');
    this.from = this.configService.get<string>('SMTP_FROM');

    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: Number(this.configService.get<string>('SMTP_PORT')),
      secure: this.configService.get<string>('SMTP_SECURE', 'false') === 'true',
      auth: user && password ? { user, pass: password } : undefined,
      // Fail fast rather than hanging the request when the relay is
      // unreachable — email delivery is best-effort (see AuthService.forgotPassword).
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
    });
  }

  /**
   * Pre-warms the SMTP connection at app bootstrap instead of on the first
   * real send — observed in practice: the first outbound connection attempt
   * from this process takes ~20s (looks like a one-time OS-level DNS/route
   * resolution cost, not something nodemailer's own connection pooling can
   * help with since sendMail() opens a fresh connection per call anyway),
   * which blew past jest's default 5s hook timeout on whichever test
   * happened to be first to trigger a send. Awaited (not fire-and-forget) so
   * that cost lands once, deterministically, during startup rather than
   * racing an early real request — a fire-and-forget version of this same
   * warm-up was tried first and did not reliably win that race. A failure
   * here is logged, not thrown — email sending is best-effort everywhere
   * else in this module too.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (err) {
      this.logger.warn(
        `SMTP connection warm-up failed (will retry lazily on first send): ${String(err)}`,
      );
    }
  }

  /**
   * Whether an SMTP transport is actually configured for this deployment.
   * Mirrors the check in auth-startup-validation.ts: a non-empty SMTP_HOST is
   * the single signal that outbound mail is set up. Callers use this to skip a
   * best-effort notification entirely (reporting 'skipped') instead of firing
   * a send that is guaranteed to fail and log an error.
   */
  isConfigured(): boolean {
    return (this.configService.get<string>('SMTP_HOST') ?? '').trim() !== '';
  }

  async sendPasswordChangedEmail(email: string): Promise<EmailDelivery> {
    return this.send(
      email,
      'Your password was changed',
      `The password for your account (${email}) was just changed. All other signed-in sessions have been signed out.\n\nIf you did not do this, reset your password immediately and contact your administrator.`,
    );
  }

  async sendPasswordResetEmail(
    email: string,
    resetUrl: string,
  ): Promise<EmailDelivery> {
    return this.send(
      email,
      'Reset your password',
      `You requested a password reset. Use the link below to set a new password (valid for 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    );
  }

  async sendConfirmationEmail(
    email: string,
    confirmUrl: string,
  ): Promise<EmailDelivery> {
    return this.send(
      email,
      'Confirm your email address',
      `Confirm your email address to finish creating your account (valid for 24 hours):\n\n${confirmUrl}\n\nIf you did not request this, you can ignore this email.`,
    );
  }

  private async send(
    to: string,
    subject: string,
    text: string,
  ): Promise<EmailDelivery> {
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text });
      return 'sent';
    } catch (err) {
      this.logger.error(
        `Failed to send email to ${maskEmail(to)}`,
        err as Error,
      );
      return 'failed';
    }
  }
}
