// F07 — admin: unfinished registrations (docs/qaa-overview/scenarios/05 §F07). The world has
// exactly one: `pending` (id 6), with one open confirmation token.
import type { ContractFamily } from '../types';

export const f07AdminRegistrations: ContractFamily = {
  id: 'F07',
  name: 'admin-registrations',
  cases: [
    {
      id: 'F07-list',
      route: 'GET /api/v1/admin/auth/pending-registrations',
      actor: 'admin',
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT u.id, u.email, u.created_at,
                     (SELECT max(t.expires_at) FROM email_confirmation_tokens t
                       WHERE t.user_id = u.id AND t.consumed_at IS NULL) AS token_expires_at
                FROM users u
               WHERE u.email_confirmed_at IS NULL
               ORDER BY u.created_at`,
        shape: 'array',
        fields: {
          id: 'id',
          email: 'email',
          registeredAt: { col: 'created_at', as: 'iso' },
          tokenExpiresAt: { col: 'token_expires_at', as: 'iso?' },
        },
        strict: true,
      },
    },
    {
      id: 'F07-list-member',
      route: 'GET /api/v1/admin/auth/pending-registrations',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F07-resend',
      route: 'POST /api/v1/admin/auth/pending-registrations/:id/resend',
      actor: 'admin',
      params: { id: '@pending.id' },
      expect: { status: 200 },
      write: {
        watch: ['email_confirmation_tokens'],
        delta: {
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
      id: 'F07-resend-confirmed',
      route: 'POST /api/v1/admin/auth/pending-registrations/:id/resend',
      actor: 'admin',
      params: { id: '@owner.id' },
      expect: { status: 409 },
    },
    {
      id: 'F07-resend-unknown',
      route: 'POST /api/v1/admin/auth/pending-registrations/:id/resend',
      actor: 'admin',
      params: { id: 999 },
      expect: { status: 404 },
    },
    {
      id: 'F07-revoke',
      route: 'DELETE /api/v1/admin/auth/pending-registrations/:id',
      actor: 'admin',
      params: { id: '@pending.id' },
      expect: { status: 204 },
      write: {
        watch: ['users', 'email_confirmation_tokens'],
        delta: {
          deleted: [
            { table: 'users', where: 'id = @pending.id' },
            {
              table: 'email_confirmation_tokens',
              where: 'user_id = @pending.id',
              count: 'all',
            },
          ],
        },
      },
    },
    {
      id: 'F07-revoke-confirmed',
      route: 'DELETE /api/v1/admin/auth/pending-registrations/:id',
      actor: 'admin',
      params: { id: '@author.id' },
      expect: { status: 409 },
    },
    {
      id: 'F07-revoke-member',
      route: 'DELETE /api/v1/admin/auth/pending-registrations/:id',
      actor: 'member',
      params: { id: '@pending.id' },
      expect: { status: 403 },
    },
  ],
};
