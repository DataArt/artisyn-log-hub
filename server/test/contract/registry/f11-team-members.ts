// F11 — teams: members (docs/qaa-overview/scenarios/05 §F11). `disclosureAcknowledgedAt` is
// shown to the team owner and to admins only; everyone else gets null in every row — two rows on
// the same request with different actors prove it.
import type { ContractFamily } from '../types';

const MEMBER_FIELDS = {
  userId: 'user_id',
  canInvite: 'can_invite',
  isManager: 'is_manager',
  isAdlcTrainer: 'is_adlc_trainer',
  disclosureAcknowledgedAt: { col: 'disclosure_acknowledged_at', as: 'iso?' },
  joinedAt: { col: 'joined_at', as: 'iso' },
  email: 'email',
  isOwner: 'is_owner',
} as const;

export const f11TeamMembers: ContractFamily = {
  id: 'F11',
  name: 'team-members',
  cases: [
    {
      id: 'F11-list-owner',
      route: 'GET /api/v1/teams/:teamId/members',
      actor: 'owner',
      params: { teamId: '@T2.id' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT m.user_id, m.can_invite, m.is_manager, m.is_adlc_trainer,
                     m.disclosure_acknowledged_at, m.joined_at, u.email,
                     m.user_id = t.owner_id AS is_owner
                FROM team_members m
                JOIN users u ON u.id = m.user_id
                JOIN teams t ON t.id = m.team_id
               WHERE m.team_id = $1`,
        args: ['@T2.id'],
        shape: 'array',
        sortBy: 'userId',
        fields: MEMBER_FIELDS,
        strict: true,
      },
    },
    {
      id: 'F11-list-member-masked',
      route: 'GET /api/v1/teams/:teamId/members',
      actor: 'member',
      params: { teamId: '@T2.id' },
      expect: { status: 200, minRows: 3 },
      read: {
        sql: `SELECT m.user_id, m.can_invite, m.is_manager, m.is_adlc_trainer,
                     NULL::timestamptz AS disclosure_acknowledged_at, m.joined_at, u.email,
                     m.user_id = t.owner_id AS is_owner
                FROM team_members m
                JOIN users u ON u.id = m.user_id
                JOIN teams t ON t.id = m.team_id
               WHERE m.team_id = $1`,
        args: ['@T2.id'],
        shape: 'array',
        sortBy: 'userId',
        fields: MEMBER_FIELDS,
        strict: true,
      },
    },
    {
      id: 'F11-list-outsider',
      route: 'GET /api/v1/teams/:teamId/members',
      actor: 'outsider',
      params: { teamId: '@T2.id' },
      expect: { status: 403 },
    },
    {
      id: 'F11-update-flags',
      route: 'PATCH /api/v1/teams/:teamId/members/:userId',
      actor: 'owner',
      params: { teamId: '@T1.id', userId: '@member.id' },
      body: { isManager: true },
      expect: { status: 200 },
      write: {
        watch: ['team_members'],
        delta: {
          updated: [
            {
              table: 'team_members',
              where: 'team_id = @T1.id AND user_id = @member.id',
              changed: { is_manager: true },
            },
          ],
        },
      },
    },
    {
      id: 'F11-update-flags-empty',
      route: 'PATCH /api/v1/teams/:teamId/members/:userId',
      actor: 'owner',
      params: { teamId: '@T1.id', userId: '@member.id' },
      body: {},
      expect: { status: 400 },
    },
    {
      id: 'F11-update-flags-not-member',
      route: 'PATCH /api/v1/teams/:teamId/members/:userId',
      actor: 'owner',
      params: { teamId: '@T1.id', userId: '@outsider.id' },
      body: { canInvite: true },
      expect: { status: 404 },
    },
    {
      id: 'F11-update-flags-member',
      route: 'PATCH /api/v1/teams/:teamId/members/:userId',
      actor: 'member',
      params: { teamId: '@T1.id', userId: '@member.id' },
      body: { isManager: true },
      expect: { status: 403 },
    },
    {
      id: 'F11-remove',
      route: 'DELETE /api/v1/teams/:teamId/members/:userId',
      actor: 'owner',
      params: { teamId: '@T2.id', userId: '@manager.id' },
      expect: { status: 204 },
      write: {
        watch: ['team_members', 'invitations'],
        delta: {
          deleted: [
            {
              table: 'team_members',
              where: 'team_id = @T2.id AND user_id = @manager.id',
            },
          ],
        },
      },
    },
    {
      // TeamOwnerGuard: a non-owner admin cannot remove members (no admin bypass).
      id: 'F11-remove-admin',
      route: 'DELETE /api/v1/teams/:teamId/members/:userId',
      actor: 'admin',
      params: { teamId: '@T1.id', userId: '@member.id' },
      expect: { status: 403 },
    },
    {
      id: 'F11-remove-member',
      route: 'DELETE /api/v1/teams/:teamId/members/:userId',
      actor: 'member',
      params: { teamId: '@T2.id', userId: '@manager.id' },
      expect: { status: 403 },
    },
  ],
};
