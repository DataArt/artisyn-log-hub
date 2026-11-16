import { LoggerService } from '@nestjs/common';
import { PoolClient } from 'pg';
import { validateModeStrictManaged } from '../auth/config/auth-startup-validation';
import { SET_PASSWORD_LINK_TTL_MS } from '../auth/password-link-ttl';
import { buildResetUrl } from '../auth/password-link-url';
import { generateResetToken } from '../auth/password-reset-tokens.service';
import { maskEmail } from '../common/mask-email';
import { getPublicBaseUrl } from '../common/public-base-url';
import { bootstrapAdminEmail } from '../mail/password-link-emails';
import { createSmtpTransport } from '../mail/smtp-transport';

const CONTEXT = 'StrictManagedBootstrap';

/**
 * First-start admin of auth mode `strict-managed` (no self sign-up, so the
 * first admin has to come from the environment). Runs inside
 * `initializeDatabase()`, under the migration advisory lock, on that lock's
 * connection — so with several cluster workers only the first one creates
 * the account and sends the email; the rest find it and do nothing.
 *
 * - `ADMIN_CONTACT_EMAIL` already has an account → it gets the admin role if
 *   it lacks it; no email.
 * - No account → a password-less admin plus a 24 h set-password token are
 *   inserted and the link is emailed, all in one transaction: if the email
 *   cannot be sent the insert is rolled back and startup aborts, so the next
 *   start tries again from scratch.
 *
 * `ALLOWED_EMAIL_DOMAINS` does not apply to this address. The token and the
 * link are never logged.
 */
export async function bootstrapStrictManagedAdmin(
  client: PoolClient,
  logger: LoggerService,
): Promise<void> {
  // 1. Env: runs before AppModule's own validation, so check here with the
  //    same messages (PUBLIC_BASE_URL, ADMIN_CONTACT_EMAIL, SMTP block).
  validateModeStrictManaged();
  const email = (process.env.ADMIN_CONTACT_EMAIL ?? '').trim().toLowerCase();
  const masked = maskEmail(email);

  // 2. Look the address up inside the transaction.
  await client.query('BEGIN');
  try {
    const found = await client.query<{ id: number; role: string }>(
      'SELECT id, role FROM users WHERE lower(email) = $1',
      [email],
    );

    // 3. Existing account: make sure it is an admin, never send an email.
    const existing = found.rows[0];
    if (existing) {
      if (existing.role !== 'admin') {
        await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [
          existing.id,
        ]);
        logger.log(
          `Strict-managed bootstrap: granted admin role to ${masked}`,
          CONTEXT,
        );
      }
      await client.query('COMMIT');
      return;
    }

    // 4. No account: password-less admin + 24 h set-password token.
    const inserted = await client.query<{ id: number }>(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, NULL, 'admin') RETURNING id",
      [email],
    );
    const userId = inserted.rows[0].id;
    const token = generateResetToken();
    await client.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))",
      [userId, token, SET_PASSWORD_LINK_TTL_MS],
    );

    const failure = await sendBootstrapEmail(email, token, logger);

    // 5. Sent → keep the account; not sent → undo it and refuse to start.
    if (failure !== null) {
      await client.query('ROLLBACK');
      throw new BootstrapSendError(
        `Strict-managed bootstrap: the set-password email to ${masked} could not be sent (${failure}); AUTH_MODE=strict-managed refuses to start. Fix SMTP and restart.`,
      );
    }
    await client.query('COMMIT');
    logger.log(
      `Strict-managed bootstrap: created admin ${masked}, set-password link emailed`,
      CONTEXT,
    );
  } catch (err) {
    if (!(err instanceof BootstrapSendError)) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is the one worth reporting.
      }
    }
    throw err;
  }
}

/** Thrown after the transaction is already rolled back. */
class BootstrapSendError extends Error {}

/** Sends the bootstrap email; returns `null` on success, else the reason. */
async function sendBootstrapEmail(
  email: string,
  token: string,
  logger: LoggerService,
): Promise<string | null> {
  const url = buildResetUrl(
    token,
    {
      warn: (message: string): void => {
        logger.warn(message, CONTEXT);
      },
    },
    'set',
  );
  const baseUrl = getPublicBaseUrl();
  if (url === null || baseUrl === null) return 'PUBLIC_BASE_URL is not set';

  const { subject, text } = bootstrapAdminEmail(url, baseUrl);
  const transporter = createSmtpTransport({
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
  });
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject,
      text,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    transporter.close();
  }
}
