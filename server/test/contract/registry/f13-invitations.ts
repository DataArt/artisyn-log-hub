// F13 — invitations (docs/qaa-overview/scenarios/05 §F13). World: #1 T1 -> outsider (pending),
// #2 T2 -> author (declined); both sent by `owner`.
import type { ContractFamily } from '../types';

const INVITATION_LIST_SQL = `
  SELECT i.id, i.team_id, t.name AS team_name, t.access_mode::text AS access_mode,
         EXISTS (SELECT 1 FROM team_members x WHERE x.team_id = t.id AND x.is_adlc_trainer)
           AS has_trainer,
         i.inviter_id, i.invitee_id, u.email AS invitee_email, i.status::text AS status,
         i.created_at
    FROM invitations i
    JOIN teams t ON t.id = i.team_id
    JOIN users u ON u.id = i.invitee_id
   WHERE i.invitee_id = $1 OR i.inviter_id = $1`;

const INVITATION_FIELDS = {
  id: 'id',
  teamId: 'team_id',
  teamName: 'team_name',
  accessMode: 'access_mode',
  hasTrainer: 'has_trainer',
  inviterId: 'inviter_id',
  inviteeId: 'invitee_id',
  inviteeEmail: 'invitee_email',
  status: 'status',
  createdAt: { col: 'created_at', as: 'iso' },
} as const;

export const f13Invitations: ContractFamily = {
  id: 'F13',
  name: 'invitations',
  cases: [
    {
      id: 'F13-invite',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { email: '@author.email' },
      expect: { status: 201 },
      write: {
        watch: ['invitations', 'team_members', 'users'],
        delta: {
          inserted: [
            {
              table: 'invitations',
              where: 'team_id = @T1.id AND invitee_id = @author.id',
              check: [
                `status = 'pending'`,
                'inviter_id = @owner.id',
                'id = $id',
              ],
            },
          ],
        },
      },
    },
    {
      // A member with can_invite may invite too.
      id: 'F13-invite-by-member',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'member',
      params: { teamId: '@T1.id' },
      body: { email: '@manager.email' },
      expect: { status: 201 },
      write: {
        watch: ['invitations', 'team_members', 'users'],
        delta: {
          inserted: [
            {
              table: 'invitations',
              where: 'team_id = @T1.id AND invitee_id = @manager.id',
              check: [`status = 'pending'`, 'inviter_id = @member.id'],
            },
          ],
        },
      },
    },
    {
      // T2's member has can_invite = false.
      id: 'F13-invite-no-permission',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'member',
      params: { teamId: '@T2.id' },
      body: { email: '@author.email' },
      expect: { status: 403 },
    },
    {
      id: 'F13-invite-unregistered',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { email: 'stranger@arrakis.test' },
      expect: { status: 404, bodyMatches: { error: 'user_not_registered' } },
    },
    {
      // force: the user is auto-provisioned and granted membership at once; the invitation still
      // reads `pending` until their first login.
      id: 'F13-invite-force',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { email: 'stranger@arrakis.test', force: true },
      expect: { status: 201 },
      write: {
        watch: ['invitations', 'team_members', 'users'],
        delta: {
          inserted: [
            {
              table: 'users',
              where: `email = 'stranger@arrakis.test'`,
              check: [`role = 'user'`],
            },
            {
              table: 'team_members',
              where: `team_id = @T1.id AND user_id = (SELECT id FROM users WHERE email = 'stranger@arrakis.test')`,
              check: ['NOT can_invite', 'disclosure_acknowledged_at IS NULL'],
            },
            {
              table: 'invitations',
              where: `team_id = @T1.id AND invitee_id = (SELECT id FROM users WHERE email = 'stranger@arrakis.test')`,
              check: [`status = 'pending'`],
            },
          ],
        },
      },
    },
    {
      id: 'F13-invite-already-member',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { email: '@member.email' },
      expect: { status: 409 },
    },
    {
      id: 'F13-invite-duplicate-pending',
      route: 'POST /api/v1/teams/:teamId/invitations',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { email: '@outsider.email' },
      expect: { status: 409 },
    },
    {
      id: 'F13-cancel',
      route: 'DELETE /api/v1/teams/:teamId/invitations/:invId',
      actor: 'owner',
      params: { teamId: '@T1.id', invId: 1 },
      expect: { status: 204 },
      write: {
        watch: ['invitations'],
        delta: {
          updated: [
            {
              table: 'invitations',
              where: 'id = 1',
              changed: { status: 'cancelled' },
            },
          ],
        },
      },
    },
    {
      id: 'F13-cancel-not-owner',
      route: 'DELETE /api/v1/teams/:teamId/invitations/:invId',
      actor: 'member',
      params: { teamId: '@T1.id', invId: 1 },
      expect: { status: 403 },
    },
    {
      id: 'F13-cancel-unknown',
      route: 'DELETE /api/v1/teams/:teamId/invitations/:invId',
      actor: 'owner',
      params: { teamId: '@T1.id', invId: 999 },
      expect: { status: 404 },
    },
    {
      // Received and sent, both directions.
      id: 'F13-list-inviter',
      route: 'GET /api/v1/invitations',
      actor: 'owner',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: INVITATION_LIST_SQL,
        args: ['@owner.id'],
        shape: 'array',
        sortBy: 'id',
        fields: INVITATION_FIELDS,
        strict: true,
      },
    },
    {
      id: 'F13-list-invitee',
      route: 'GET /api/v1/invitations',
      actor: 'outsider',
      expect: { status: 200, minRows: 1 },
      read: {
        sql: INVITATION_LIST_SQL,
        args: ['@outsider.id'],
        shape: 'array',
        sortBy: 'id',
        fields: INVITATION_FIELDS,
        strict: true,
      },
    },
    {
      id: 'F13-accept',
      route: 'PATCH /api/v1/invitations/:invId',
      actor: 'outsider',
      params: { invId: 1 },
      body: { action: 'accept', acknowledgedAccessMode: 'transparent' },
      expect: { status: 200 },
      write: {
        watch: ['invitations', 'team_members'],
        delta: {
          updated: [
            {
              table: 'invitations',
              where: 'id = 1',
              changed: { status: 'accepted' },
            },
          ],
          inserted: [
            {
              table: 'team_members',
              where: 'team_id = @T1.id AND user_id = @outsider.id',
              check: ['disclosure_acknowledged_at IS NOT NULL'],
            },
          ],
        },
      },
    },
    {
      id: 'F13-accept-without-acknowledgement',
      route: 'PATCH /api/v1/invitations/:invId',
      actor: 'outsider',
      params: { invId: 1 },
      body: { action: 'accept' },
      expect: { status: 400 },
    },
    {
      id: 'F13-accept-stale-mode',
      route: 'PATCH /api/v1/invitations/:invId',
      actor: 'outsider',
      params: { invId: 1 },
      body: { action: 'accept', acknowledgedAccessMode: 'restricted' },
      expect: { status: 400 },
    },
    {
      id: 'F13-decline',
      route: 'PATCH /api/v1/invitations/:invId',
      actor: 'outsider',
      params: { invId: 1 },
      body: { action: 'decline' },
      expect: { status: 200 },
      write: {
        watch: ['invitations', 'team_members'],
        delta: {
          updated: [
            {
              table: 'invitations',
              where: 'id = 1',
              changed: { status: 'declined' },
            },
          ],
        },
      },
    },
    {
      id: 'F13-respond-not-invitee',
      route: 'PATCH /api/v1/invitations/:invId',
      actor: 'member',
      params: { invId: 1 },
      body: { action: 'decline' },
      expect: { status: 403 },
    },
    {
      id: 'F13-respond-not-pending',
      route: 'PATCH /api/v1/invitations/:invId',
      actor: 'author',
      params: { invId: 2 },
      body: { action: 'decline' },
      expect: { status: 400 },
    },
  ],
};
