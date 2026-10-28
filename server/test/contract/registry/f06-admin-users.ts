// F06 — admin: users (docs/qaa-overview/scenarios/05 §F06). Two controllers change a role:
// `PATCH /api/v1/admin/users/:id/role` and the legacy `PATCH /api/v1/users/:userId/role`, which
// stays as is and gets its own
// rows. Every route also has a `member` row: AdminGuard answers 403 and nothing is written.
import type { ContractFamily, WriteSpec } from '../types';

/**
 * Deleting the outsider (05 §F02 delete-account, §F06 admin delete): their user row, the
 * invitation they received, their repository R3 (its URL is not shared), their logs and the
 * session w1-s08 that only those logs referenced, with its per-session rows.
 */
export const DELETE_OUTSIDER: WriteSpec = {
  watch: [
    'users',
    'invitations',
    'repositories',
    'logs',
    'log_repositories',
    'sessions',
    'session_stats',
    'session_costs',
    'session_request_ids',
    'session_tool_usage',
  ],
  delta: {
    deleted: [
      { table: 'users', where: 'id = @outsider.id' },
      { table: 'invitations', where: 'invitee_id = @outsider.id' },
      { table: 'repositories', where: 'user_id = @outsider.id' },
      { table: 'logs', where: 'user_id = @outsider.id', count: 'all' },
      {
        table: 'log_repositories',
        where: 'log_id IN (SELECT id FROM logs WHERE user_id = @outsider.id)',
        count: 'all',
      },
      { table: 'sessions', where: 'id = @s08.id' },
      { table: 'session_stats', where: 'session_id = @s08.id' },
      { table: 'session_costs', where: 'session_id = @s08.id' },
      {
        table: 'session_request_ids',
        where: 'session_id = @s08.id',
        count: 'all',
      },
      {
        table: 'session_tool_usage',
        where: 'session_id = @s08.id',
        count: 'all',
      },
    ],
  },
};

export const f06AdminUsers: ContractFamily = {
  id: 'F06',
  name: 'admin-users',
  cases: [
    {
      // teamCount / lastActivity come from separate sub-queries, not the endpoint's JOIN: the
      // member sits in two teams and owns three logs, so a JOIN product would show 6 (05 §F08).
      id: 'F06-list',
      route: 'GET /api/v1/admin/users',
      actor: 'admin',
      expect: { status: 200, minRows: 7 },
      read: {
        sql: `SELECT u.id, u.email, u.role::text AS role, u.created_at,
                     (SELECT count(*) FROM team_members tm WHERE tm.user_id = u.id) AS team_count,
                     (SELECT max(l.end_time) FROM logs l WHERE l.user_id = u.id) AS last_activity
                FROM users u
               ORDER BY u.email`,
        shape: 'array',
        fields: {
          id: 'id',
          email: 'email',
          role: 'role',
          createdAt: { col: 'created_at', as: 'iso' },
          teamCount: { col: 'team_count', as: 'number' },
          lastActivity: { col: 'last_activity', as: 'iso?' },
        },
        strict: true,
      },
    },
    {
      id: 'F06-list-member',
      route: 'GET /api/v1/admin/users',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F06-role',
      route: 'PATCH /api/v1/admin/users/:id/role',
      actor: 'admin',
      params: { id: '@owner.id' },
      body: { role: 'admin' },
      expect: { status: 200, bodyMatches: { id: 2, role: 'admin' } },
      write: {
        watch: ['users'],
        delta: {
          updated: [
            {
              table: 'users',
              where: 'id = @owner.id',
              changed: { role: 'admin' },
            },
          ],
        },
      },
    },
    {
      id: 'F06-role-self',
      route: 'PATCH /api/v1/admin/users/:id/role',
      actor: 'admin',
      params: { id: '@admin.id' },
      body: { role: 'user' },
      expect: { status: 400 },
    },
    {
      id: 'F06-role-unknown-user',
      route: 'PATCH /api/v1/admin/users/:id/role',
      actor: 'admin',
      params: { id: 999 },
      body: { role: 'admin' },
      expect: { status: 404 },
    },
    {
      id: 'F06-role-member',
      route: 'PATCH /api/v1/admin/users/:id/role',
      actor: 'member',
      params: { id: '@author.id' },
      body: { role: 'admin' },
      expect: { status: 403 },
    },
    {
      id: 'F06-legacy-role',
      route: 'PATCH /api/v1/users/:userId/role',
      actor: 'admin',
      params: { userId: '@member.id' },
      body: { role: 'admin' },
      expect: { status: 200 },
      write: {
        watch: ['users'],
        delta: {
          updated: [
            {
              table: 'users',
              where: 'id = @member.id',
              changed: { role: 'admin' },
            },
          ],
        },
      },
    },
    {
      // The last admin cannot be demoted — by anyone, through either controller.
      id: 'F06-legacy-role-self',
      route: 'PATCH /api/v1/users/:userId/role',
      actor: 'admin',
      params: { userId: '@admin.id' },
      body: { role: 'user' },
      expect: { status: 400 },
    },
    {
      id: 'F06-legacy-role-member',
      route: 'PATCH /api/v1/users/:userId/role',
      actor: 'member',
      params: { userId: '@member.id' },
      body: { role: 'admin' },
      expect: { status: 403 },
    },
    {
      id: 'F06-email',
      route: 'PATCH /api/v1/admin/users/:id/email',
      actor: 'admin',
      params: { id: '@author.id' },
      body: { email: 'Author.Renamed@Arrakis.test' },
      expect: { status: 200 },
      write: {
        watch: ['users'],
        delta: {
          updated: [
            {
              table: 'users',
              where: 'id = @author.id',
              changed: { email: 'author.renamed@arrakis.test' },
            },
          ],
        },
      },
    },
    {
      id: 'F06-email-taken',
      route: 'PATCH /api/v1/admin/users/:id/email',
      actor: 'admin',
      params: { id: '@author.id' },
      body: { email: '@member.email' },
      expect: { status: 409 },
    },
    {
      id: 'F06-email-member',
      route: 'PATCH /api/v1/admin/users/:id/email',
      actor: 'member',
      params: { id: '@author.id' },
      body: { email: 'x@arrakis.test' },
      expect: { status: 403 },
    },
    {
      id: 'F06-delete',
      route: 'POST /api/v1/admin/users/:id/delete',
      actor: 'admin',
      params: { id: '@outsider.id' },
      body: { confirmEmail: 'OUTSIDER@arrakis.test' },
      expect: { status: 204 },
      write: DELETE_OUTSIDER,
    },
    {
      id: 'F06-delete-wrong-confirmation',
      route: 'POST /api/v1/admin/users/:id/delete',
      actor: 'admin',
      params: { id: '@outsider.id' },
      body: { confirmEmail: '@author.email' },
      expect: { status: 400 },
    },
    {
      id: 'F06-delete-self',
      route: 'POST /api/v1/admin/users/:id/delete',
      actor: 'admin',
      params: { id: '@admin.id' },
      body: { confirmEmail: '@admin.email' },
      expect: { status: 400 },
    },
    {
      id: 'F06-delete-member',
      route: 'POST /api/v1/admin/users/:id/delete',
      actor: 'member',
      params: { id: '@outsider.id' },
      body: { confirmEmail: '@outsider.email' },
      expect: { status: 403 },
    },
    {
      // The link carries exactly the token that was stored.
      id: 'F06-reset-link',
      route: 'POST /api/v1/users/:userId/reset-password-link',
      actor: 'admin',
      params: { userId: '@owner.id' },
      expect: { status: 200 },
      write: {
        watch: ['password_reset_tokens'],
        delta: {
          inserted: [
            {
              table: 'password_reset_tokens',
              where: 'user_id = @owner.id',
              check: [
                'used_at IS NULL',
                'expires_at > now()',
                `$resetUrl LIKE '%/#/reset-password?token=' || token`,
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F06-reset-link-member',
      route: 'POST /api/v1/users/:userId/reset-password-link',
      actor: 'member',
      params: { userId: '@owner.id' },
      expect: { status: 403 },
    },
  ],
};
