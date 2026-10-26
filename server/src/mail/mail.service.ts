import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { maskEmail } from '../common/mask-email';

export type EmailDelivery = 'sent' | 'failed';

/** Auth modes that send email at all (Mode 2 optionally, Mode 3 always). */
const SMTP_AUTH_MODES = ['password', 'password-confirm'];

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string | undefined;

  constructor(private readonly configService: ConfigService) {
    // A transporter exists only when SMTP applies to the active auth mode and
    // SMTP_HOST is set (see isConfigured()). Building one from unset values
    // would silently fall back to nodemailer's localhost:587 default, so in
    // every other case the field stays null and no SMTP connection is ever
    // attempted. No fallback defaults for the values themselves:
    // auth-startup-validation.ts requires SMTP_HOST/SMTP_PORT/SMTP_FROM in
    // Mode 3 (password-confirm), and SMTP_PORT/SMTP_FROM in Mode 2 (password)
    // whenever SMTP_HOST is set — a code-level default would only mask a
    // validator bug. Modes 1/4 never use SMTP.
    this.from = this.configService.get<string>('SMTP_FROM');

    if (!this.isConfigured()) {
      this.transporter = null;
      return;
    }

    const user = this.configService.get<string>('SMTP_USER');
    const password = this.configService.get<string>('SMTP_PASSWORD');
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: Number(this.configService.get<string>('SMTP_PORT')),
      secure: this.configService.get<string>('SMTP_SECURE', 'false') === 'true',
      auth: user && password ? { user, pass: password } : undefined,
      // Fail fast rather than hanging startup or a request when the relay is
      // unreachable: send() then reports 'failed' to its caller.
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
   * racing an early real request.
   *
   * - No transporter (SMTP does not apply to this mode, or is not set up in
   *   Mode 2): returns without touching the network or logging anything.
   * - Mode 3 (password-confirm) outside NODE_ENV=test: an unreachable relay
   *   throws, so startup aborts — the mode cannot work without email.
   * - Mode 2, or Mode 3 under NODE_ENV=test (the contract suite runs Mode 3
   *   without a relay): a failure is logged as a warning and the next send
   *   retries the connection.
   */
  async onModuleInit(): Promise<void> {
    if (!this.transporter) return;
    try {
      await this.transporter.verify();
    } catch (err) {
      if (
        this.configService.get<string>('AUTH_MODE') === 'password-confirm' &&
        process.env.NODE_ENV !== 'test'
      ) {
        const host = this.configService.get<string>('SMTP_HOST');
        const port = this.configService.get<string>('SMTP_PORT');
        throw new Error(
          `SMTP relay ${host}:${port} is unreachable; AUTH_MODE=password-confirm requires a working relay: ${String(err)}`,
        );
      }
      this.logger.warn(
        `SMTP connection warm-up failed (will retry lazily on first send): ${String(err)}`,
      );
    }
  }

  /**
   * Whether outbound mail is set up for the active auth mode: true iff
   * AUTH_MODE is `password` or `password-confirm` and SMTP_HOST is non-empty.
   * Modes 1/4 never use SMTP, so this is always false there. In Mode 3 the
   * startup validator requires SMTP_HOST, so outside NODE_ENV=test it is always
   * true. This is the single gate for every send path and for the warm-up:
   * callers skip a notification entirely (reporting 'skipped') instead of
   * firing a send that cannot be delivered.
   */
  isConfigured(): boolean {
    const mode = this.configService.get<string>('AUTH_MODE') ?? '';
    if (!SMTP_AUTH_MODES.includes(mode)) return false;
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
    // Defensive: every caller gates on isConfigured() first, so this is not a
    // delivery failure worth logging — there is simply no relay to send to.
    if (!this.transporter) return 'failed';
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
