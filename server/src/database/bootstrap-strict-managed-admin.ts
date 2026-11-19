import { LoggerService } from '@nestjs/common';
import { PoolClient } from 'pg';
import { validateModeStrictManaged } from '../auth/config/auth-startup-validation';
import { SET_PASSWORD_LINK_TTL_MS } from '../auth/password-link-ttl';
import { buildResetUrl } from '../auth/password-link-url';
import {
  generateResetToken,
  hashResetToken,
} from '../auth/password-reset-tokens.service';
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
 * - `ADMIN_CONTACT_EMAIL` is already an admin → nothing happens, no email.
 * - It is a non-admin account (e.g. a sign-up from an earlier auth mode,
 *   which anyone could have made with this address) → it becomes the admin
 *   only through the mailbox: password, confirmation, outstanding links and
 *   sessions are cleared, then the set-password link is emailed.
 * - No account → a password-less admin is inserted and the link is emailed.
 * Both of the last two run in one transaction with a 24 h set-password
 * token: if the email cannot be sent everything is rolled back and startup
 * aborts, so the next start tries again from scratch.
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

    // 3. Existing admin: nothing to do, no email.
    const existing = found.rows[0];
    if (existing?.role === 'admin') {
      await client.query('COMMIT');
      return;
    }

    // 4. Existing non-admin account (left over from an earlier auth mode,
    //    where anyone could have signed up with this address): it becomes
    //    the admin only through the mailbox. Its password, confirmation,
    //    outstanding links and sessions are cleared, then it gets the same
    //    set-password email as a new admin.
    //    No account: password-less admin. Either way a 24 h set token follows.
    let userId: number;
    if (existing) {
      userId = existing.id;
      await client.query(
        "UPDATE users SET role = 'admin', password_hash = NULL, email_confirmed_at = NULL WHERE id = $1",
        [userId],
      );
      await client.query(
        'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
        [userId],
      );
      // auth_sessions is created by connect-pg-simple on first use, so it
      // can be missing; sess->passport->user holds the id as text.
      const store = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('auth_sessions') IS NOT NULL AS exists",
      );
      if (store.rows[0]?.exists) {
        await client.query(
          "DELETE FROM auth_sessions WHERE (sess -> 'passport' ->> 'user') = $1",
          [String(userId)],
        );
      }
      // Its API keys too: whoever made them is not known to own the mailbox,
      // and a key acts as the account (now an admin) on the hook routes.
      // Runs before the app starts, so no worker holds a cached key yet.
      await client.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
      logger.warn(
        `Strict-managed bootstrap: the existing account ${masked} becomes the admin; its password, sessions and API keys were cleared and a set-password link is emailed`,
        CONTEXT,
      );
    } else {
      const inserted = await client.query<{ id: number }>(
        "INSERT INTO users (email, password_hash, role) VALUES ($1, NULL, 'admin') RETURNING id",
        [email],
      );
      userId = inserted.rows[0].id;
    }
    const token = generateResetToken();
    await client.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at, purpose) VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'), 'set')",
      [userId, hashResetToken(token), SET_PASSWORD_LINK_TTL_MS],
    );

    const failure = await sendBootstrapEmail(email, token, logger);

    // 5. Sent → keep the changes; not sent → undo them and refuse to start.
    if (failure !== null) {
      await client.query('ROLLBACK');
      throw new BootstrapSendError(
        `Strict-managed bootstrap: the set-password email to ${masked} could not be sent (${failure}); AUTH_MODE=strict-managed refuses to start. Fix SMTP and restart.`,
      );
    }
    await client.query('COMMIT');
    logger.log(
      `Strict-managed bootstrap: ${existing ? 'reset' : 'created'} admin ${masked}, set-password link emailed`,
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
