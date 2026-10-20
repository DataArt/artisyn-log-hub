// F02 — account and session routes in mode 3 `password-confirm` (docs/qaa-overview/scenarios/05
// §F02). Emails are never asserted (`email_delivery` is 'sent' or 'failed' depending on whether
// an SMTP sink runs); only the DB effect is.
//
// Rows that open or end a session (`login`, `logout`, `delete-account`) use `freshSession`, so
// the shared agents of later rows keep working.
import type { ContractFamily } from '../types';
import { DELETE_OUTSIDER } from './f06-admin-users';

/** Satisfies PASSWORD_POLICY=long (14+ chars, digit, punctuation, both cases). */
const NEW_PASSWORD = 'Contract-World-v1-New-Pass!9';
const NEW_EMAIL = 'new-user@arrakis.test';

export const f02Account: ContractFamily = {
  id: 'F02',
  name: 'account',
  cases: [
    {
      id: 'F02-signup',
      route: 'POST /api/v1/auth/signup',
      actor: 'anon',
      body: {
        email: NEW_EMAIL,
        password: NEW_PASSWORD,
        passwordConfirm: NEW_PASSWORD,
      },
      expect: {
        status: 201,
        bodyMatches: { email: NEW_EMAIL, role: 'user' },
      },
      write: {
        watch: ['users', 'email_confirmation_tokens'],
        delta: {
          inserted: [
            {
              table: 'users',
              where: `email = '${NEW_EMAIL}'`,
              check: [
                `role = 'user'`,
                'email_confirmed_at IS NULL',
                `password_hash LIKE '_argon2id_%'`,
                'id = $id',
              ],
            },
            {
              table: 'email_confirmation_tokens',
              where: `user_id = (SELECT id FROM users WHERE email = '${NEW_EMAIL}')`,
              check: ['consumed_at IS NULL', 'expires_at > now()'],
            },
          ],
        },
      },
    },
    {
      id: 'F02-signup-duplicate',
      route: 'POST /api/v1/auth/signup',
      actor: 'anon',
      body: {
        email: '@member.email',
        password: NEW_PASSWORD,
        passwordConfirm: NEW_PASSWORD,
      },
      expect: { status: 409 },
    },
    {
      id: 'F02-confirm-email',
      route: 'POST /api/v1/auth/confirm-email',
      actor: 'anon',
      body: { token: '@pendingConfirmationToken' },
      expect: {
        status: 200,
        bodyMatches: { id: 6, email: 'pending@arrakis.test' },
      },
      write: {
        watch: ['users', 'email_confirmation_tokens'],
        delta: {
          updated: [
            {
              table: 'users',
              where: 'id = @pending.id',
              changed: {},
              anyChange: ['email_confirmed_at'],
            },
            {
              table: 'email_confirmation_tokens',
              where: 'token = @pendingConfirmationToken',
              changed: {},
              anyChange: ['consumed_at'],
            },
          ],
        },
        after: [
          '(SELECT email_confirmed_at IS NOT NULL FROM users WHERE id = @pending.id)',
          `(SELECT consumed_at IS NOT NULL FROM email_confirmation_tokens WHERE token = @pendingConfirmationToken)`,
        ],
      },
    },
    {
      id: 'F02-confirm-email-unknown-token',
      route: 'POST /api/v1/auth/confirm-email',
      actor: 'anon',
      body: { token: 'no-such-token' },
      expect: { status: 400 },
    },
    {
      id: 'F02-resend-confirmation',
      route: 'POST /api/v1/auth/resend-confirmation',
      actor: 'anon',
      body: { email: '@pending.email' },
      expect: { status: 200 },
      write: {
        watch: ['email_confirmation_tokens'],
        delta: {
          // The still-open token is consumed, a new one issued.
          updated: [
            {
              table: 'email_confirmation_tokens',
              where: 'token = @pendingConfirmationToken',
              changed: {},
              anyChange: ['consumed_at'],
            },
          ],
          inserted: [
            {
              table: 'email_confirmation_tokens',
              where: 'user_id = @pending.id',
              check: ['consumed_at IS NULL', 'expires_at > now()'],
            },
          ],
        },
        after: [
          '(SELECT consumed_at IS NOT NULL FROM email_confirmation_tokens WHERE token = @pendingConfirmationToken)',
        ],
      },
    },
    {
      // Enumeration-safe: a confirmed account answers like a pending one and writes nothing.
      id: 'F02-resend-confirmation-confirmed',
      route: 'POST /api/v1/auth/resend-confirmation',
      actor: 'anon',
      body: { email: '@owner.email' },
      expect: { status: 200, bodyMatches: { email_delivery: 'sent' } },
      noDb: true,
    },
    {
      id: 'F02-login',
      route: 'POST /api/v1/auth/login',
      actor: 'anon',
      freshSession: true,
      body: { email: '@author.email', password: 'contract-world-v1-password' },
      expect: { status: 200 },
      read: {
        sql: `SELECT id, email, role::text AS role, created_at
                FROM users WHERE id = $1`,
        args: ['@author.id'],
        shape: 'object',
        fields: {
          id: 'id',
          email: 'email',
          role: 'role',
          created_at: { col: 'created_at', as: 'iso' },
        },
        strict: true,
        ignore: ['env_name'],
      },
    },
    {
      id: 'F02-login-wrong-password',
      route: 'POST /api/v1/auth/login',
      actor: 'anon',
      freshSession: true,
      body: { email: '@author.email', password: 'not-the-password' },
      expect: { status: 401 },
    },
    {
      id: 'F02-logout',
      route: 'POST /api/v1/auth/logout',
      actor: 'author',
      freshSession: true,
      expect: { status: 204 },
      noDb: true,
    },
    {
      id: 'F02-me',
      route: 'GET /api/v1/auth/me',
      actor: 'owner',
      expect: { status: 200 },
      read: {
        sql: `SELECT id, email, role::text AS role, created_at
                FROM users WHERE id = $1`,
        args: ['@owner.id'],
        shape: 'object',
        fields: {
          id: 'id',
          email: 'email',
          role: 'role',
          created_at: { col: 'created_at', as: 'iso' },
        },
        strict: true,
        ignore: ['env_name'],
      },
    },
    {
      id: 'F02-me-anon',
      route: 'GET /api/v1/auth/me',
      actor: 'anon',
      expect: { status: 401 },
    },
    {
      id: 'F02-forgot-password',
      route: 'POST /api/v1/auth/forgot-password',
      actor: 'anon',
      body: { email: '@owner.email' },
      expect: { status: 200 },
      write: {
        watch: ['password_reset_tokens'],
        delta: {
          inserted: [
            {
              table: 'password_reset_tokens',
              where: 'user_id = @owner.id',
              check: ['used_at IS NULL', 'expires_at > now()'],
            },
          ],
        },
      },
    },
    {
      // Enumeration-safe: an unknown email gets the same answer and writes nothing.
      id: 'F02-forgot-password-unknown',
      route: 'POST /api/v1/auth/forgot-password',
      actor: 'anon',
      body: { email: 'nobody@arrakis.test' },
      expect: { status: 200, bodyMatches: { email_delivery: 'sent' } },
      noDb: true,
    },
    {
      id: 'F02-reset-password',
      route: 'POST /api/v1/auth/reset-password',
      actor: 'anon',
      body: {
        token: '@authorResetToken',
        password: NEW_PASSWORD,
        passwordConfirm: NEW_PASSWORD,
      },
      expect: { status: 200 },
      write: {
        watch: ['users', 'password_reset_tokens'],
        delta: {
          updated: [
            {
              table: 'users',
              where: 'id = @author.id',
              changed: {},
              anyChange: ['password_hash'],
            },
            {
              table: 'password_reset_tokens',
              where: 'token = @authorResetToken',
              changed: {},
              anyChange: ['used_at'],
            },
          ],
        },
        after: [
          `(SELECT password_hash <> @worldPasswordHash AND password_hash LIKE '_argon2id_%' FROM users WHERE id = @author.id)`,
          '(SELECT used_at IS NOT NULL FROM password_reset_tokens WHERE token = @authorResetToken)',
        ],
      },
    },
    {
      id: 'F02-reset-password-unknown-token',
      route: 'POST /api/v1/auth/reset-password',
      actor: 'anon',
      body: {
        token: 'no-such-token',
        password: NEW_PASSWORD,
        passwordConfirm: NEW_PASSWORD,
      },
      expect: { status: 400 },
    },
    {
      id: 'F02-change-password',
      route: 'POST /api/v1/auth/change-password',
      actor: 'manager',
      body: {
        currentPassword: 'contract-world-v1-password',
        password: NEW_PASSWORD,
        passwordConfirm: NEW_PASSWORD,
      },
      expect: { status: 200, bodyMatches: { id: 7 } },
      write: {
        watch: ['users'],
        delta: {
          updated: [
            {
              table: 'users',
              where: 'id = @manager.id',
              changed: {},
              anyChange: ['password_hash'],
            },
          ],
        },
        after: [
          `(SELECT password_hash <> @worldPasswordHash AND password_hash LIKE '_argon2id_%' FROM users WHERE id = @manager.id)`,
        ],
      },
    },
    {
      id: 'F02-change-password-wrong-current',
      route: 'POST /api/v1/auth/change-password',
      actor: 'manager',
      body: {
        currentPassword: 'not-the-password',
        password: NEW_PASSWORD,
        passwordConfirm: NEW_PASSWORD,
      },
      expect: { status: 403 },
    },
    {
      // The outsider owns R3 (url not shared), session w1-s08 and invitation #1 as invitee.
      id: 'F02-delete-account',
      route: 'POST /api/v1/auth/delete-account',
      actor: 'outsider',
      freshSession: true,
      body: { confirm: 'delete' },
      expect: { status: 204 },
      write: DELETE_OUTSIDER,
    },
    {
      id: 'F02-delete-account-unconfirmed',
      route: 'POST /api/v1/auth/delete-account',
      actor: 'outsider',
      body: { confirm: 'yes' },
      expect: { status: 400 },
    },
  ],
};
