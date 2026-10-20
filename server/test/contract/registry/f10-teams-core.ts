// F10 — teams: core (docs/qaa-overview/scenarios/05 §F10). World: T1 (transparent; owner +
// member, member is an ADLC trainer) and T2 (restricted; owner + member + manager; the member has
// not acknowledged T2's disclosure yet). Both teams are owned by `owner`.
//
// Guards: TeamAccessGuard (member of the team, or admin) answers 403 to an outsider and 404 for
// an unknown team; TeamOwnerGuard admits the owner only — no admin bypass.
import type { ContractFamily, ReadSpec } from '../types';

/** One team as its members see it: the caller's own flags come from their membership row. */
const TEAM_FOR_MEMBER: Omit<ReadSpec, 'args'> = {
  sql: `SELECT t.id, t.name, t.owner_id, t.created_at, t.access_mode::text AS access_mode,
               m.is_manager, m.is_adlc_trainer
          FROM teams t JOIN team_members m ON m.team_id = t.id AND m.user_id = $2
         WHERE t.id = $1`,
  shape: 'object',
  fields: {
    id: 'id',
    name: 'name',
    ownerId: 'owner_id',
    createdAt: { col: 'created_at', as: 'iso' },
    accessMode: 'access_mode',
    myIsManager: 'is_manager',
    myIsAdlcTrainer: 'is_adlc_trainer',
  },
  strict: true,
};

export const f10TeamsCore: ContractFamily = {
  id: 'F10',
  name: 'teams-core',
  cases: [
    {
      id: 'F10-create',
      route: 'POST /api/v1/teams',
      actor: 'author',
      body: { name: 'T3 Corrino' },
      expect: { status: 201, bodyMatches: { name: 'T3 Corrino', ownerId: 5 } },
      write: {
        watch: ['teams', 'team_members'],
        delta: {
          inserted: [
            {
              table: 'teams',
              where: `name = 'T3 Corrino'`,
              // A new team starts restricted (column default).
              check: [
                'owner_id = @author.id',
                'id = $id',
                `access_mode = 'restricted'`,
              ],
            },
            {
              // The creator joins as an already-acknowledged member.
              table: 'team_members',
              where: `team_id = (SELECT id FROM teams WHERE name = 'T3 Corrino')`,
              check: [
                'user_id = @author.id',
                'disclosure_acknowledged_at IS NOT NULL',
                'NOT is_manager',
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F10-create-duplicate-name',
      route: 'POST /api/v1/teams',
      actor: 'author',
      body: { name: 'T1 Fremen' },
      expect: { status: 409 },
    },
    {
      id: 'F10-list',
      route: 'GET /api/v1/teams',
      actor: 'member',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT t.id, t.name, t.owner_id, t.created_at, t.access_mode::text AS access_mode,
                     m.is_manager, m.is_adlc_trainer, true AS is_member
                FROM teams t JOIN team_members m ON m.team_id = t.id
               WHERE m.user_id = $1`,
        args: ['@member.id'],
        shape: 'array',
        sortBy: 'id',
        fields: {
          id: 'id',
          name: 'name',
          ownerId: 'owner_id',
          createdAt: { col: 'created_at', as: 'iso' },
          accessMode: 'access_mode',
          myIsManager: 'is_manager',
          myIsAdlcTrainer: 'is_adlc_trainer',
          isMember: 'is_member',
        },
        strict: true,
      },
    },
    {
      // An admin sees every team, flagged by whether they are a member.
      id: 'F10-list-admin',
      route: 'GET /api/v1/teams',
      actor: 'admin',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT t.id, t.name, t.owner_id, t.created_at, t.access_mode::text AS access_mode,
                     coalesce(m.is_manager, false) AS is_manager,
                     coalesce(m.is_adlc_trainer, false) AS is_adlc_trainer,
                     m.user_id IS NOT NULL AS is_member
                FROM teams t LEFT JOIN team_members m ON m.team_id = t.id AND m.user_id = $1`,
        args: ['@admin.id'],
        shape: 'array',
        sortBy: 'id',
        fields: {
          id: 'id',
          name: 'name',
          ownerId: 'owner_id',
          createdAt: { col: 'created_at', as: 'iso' },
          accessMode: 'access_mode',
          myIsManager: 'is_manager',
          myIsAdlcTrainer: 'is_adlc_trainer',
          isMember: 'is_member',
        },
        strict: true,
      },
    },
    {
      id: 'F10-pending-disclosures',
      route: 'GET /api/v1/teams/pending-disclosures',
      actor: 'member',
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT t.id, t.name, t.access_mode::text AS access_mode,
                     EXISTS (SELECT 1 FROM team_members x
                              WHERE x.team_id = t.id AND x.is_adlc_trainer) AS has_trainer
                FROM teams t JOIN team_members m ON m.team_id = t.id
               WHERE m.user_id = $1 AND m.disclosure_acknowledged_at IS NULL`,
        args: ['@member.id'],
        shape: 'array',
        sortBy: 'teamId',
        fields: {
          teamId: 'id',
          teamName: 'name',
          accessMode: 'access_mode',
          hasTrainer: 'has_trainer',
        },
        strict: true,
      },
    },
    {
      id: 'F10-get',
      route: 'GET /api/v1/teams/:teamId',
      actor: 'member',
      params: { teamId: '@T1.id' },
      expect: { status: 200 },
      read: { ...TEAM_FOR_MEMBER, args: ['@T1.id', '@member.id'] },
    },
    {
      id: 'F10-get-admin',
      route: 'GET /api/v1/teams/:teamId',
      actor: 'admin',
      params: { teamId: '@T2.id' },
      expect: { status: 200, bodyMatches: { id: 2, name: 'T2 Atreides' } },
      noDb: true,
    },
    {
      id: 'F10-get-outsider',
      route: 'GET /api/v1/teams/:teamId',
      actor: 'outsider',
      params: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F10-get-unknown',
      route: 'GET /api/v1/teams/:teamId',
      actor: 'member',
      params: { teamId: 999 },
      expect: { status: 404 },
    },
    {
      id: 'F10-rename',
      route: 'PATCH /api/v1/teams/:teamId',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { name: 'T1 Fremen Renamed' },
      expect: { status: 200 },
      write: {
        watch: ['teams'],
        delta: {
          updated: [
            {
              table: 'teams',
              where: 'id = @T1.id',
              changed: { name: 'T1 Fremen Renamed' },
            },
          ],
        },
      },
    },
    {
      id: 'F10-make-restricted',
      route: 'PATCH /api/v1/teams/:teamId',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { accessMode: 'restricted' },
      expect: { status: 200 },
      write: {
        watch: ['teams'],
        delta: {
          updated: [
            {
              table: 'teams',
              where: 'id = @T1.id',
              changed: { access_mode: 'restricted' },
            },
          ],
        },
      },
    },
    {
      // A team with members besides the owner cannot become transparent.
      id: 'F10-make-transparent-with-members',
      route: 'PATCH /api/v1/teams/:teamId',
      actor: 'owner',
      params: { teamId: '@T2.id' },
      body: { accessMode: 'transparent' },
      expect: { status: 409 },
    },
    {
      id: 'F10-update-empty',
      route: 'PATCH /api/v1/teams/:teamId',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: {},
      expect: { status: 400 },
    },
    {
      id: 'F10-update-member',
      route: 'PATCH /api/v1/teams/:teamId',
      actor: 'member',
      params: { teamId: '@T1.id' },
      body: { name: 'hijacked' },
      expect: { status: 403 },
    },
    {
      id: 'F10-update-admin',
      route: 'PATCH /api/v1/teams/:teamId',
      actor: 'admin',
      params: { teamId: '@T1.id' },
      body: { name: 'by-admin' },
      expect: { status: 403 },
    },
    {
      // T2's memberships, its repository link and its (declined) invitation go with it.
      id: 'F10-delete',
      route: 'DELETE /api/v1/teams/:teamId',
      actor: 'owner',
      params: { teamId: '@T2.id' },
      expect: { status: 204 },
      write: {
        watch: ['teams', 'team_members', 'team_repositories', 'invitations'],
        delta: {
          deleted: [
            { table: 'teams', where: 'id = @T2.id' },
            { table: 'team_members', where: 'team_id = @T2.id', count: 3 },
            { table: 'team_repositories', where: 'team_id = @T2.id', count: 1 },
            { table: 'invitations', where: 'team_id = @T2.id', count: 1 },
          ],
        },
      },
    },
    {
      id: 'F10-delete-member',
      route: 'DELETE /api/v1/teams/:teamId',
      actor: 'member',
      params: { teamId: '@T2.id' },
      expect: { status: 403 },
    },
    {
      id: 'F10-acknowledge',
      route: 'POST /api/v1/teams/:teamId/acknowledge-disclosure',
      actor: 'member',
      params: { teamId: '@T2.id' },
      body: { acknowledgedAccessMode: 'restricted' },
      expect: { status: 200 },
      write: {
        watch: ['team_members'],
        delta: {
          updated: [
            {
              table: 'team_members',
              where: 'team_id = @T2.id AND user_id = @member.id',
              changed: {},
              anyChange: ['disclosure_acknowledged_at'],
            },
          ],
        },
        after: [
          `(SELECT disclosure_acknowledged_at IS NOT NULL FROM team_members
             WHERE team_id = @T2.id AND user_id = @member.id)`,
        ],
      },
    },
    {
      // A stale modal (it showed another access mode) cannot acknowledge.
      id: 'F10-acknowledge-stale-mode',
      route: 'POST /api/v1/teams/:teamId/acknowledge-disclosure',
      actor: 'member',
      params: { teamId: '@T2.id' },
      body: { acknowledgedAccessMode: 'transparent' },
      expect: { status: 400 },
    },
    {
      id: 'F10-acknowledge-outsider',
      route: 'POST /api/v1/teams/:teamId/acknowledge-disclosure',
      actor: 'outsider',
      params: { teamId: '@T2.id' },
      body: { acknowledgedAccessMode: 'restricted' },
      expect: { status: 403 },
    },
    {
      id: 'F10-leave',
      route: 'POST /api/v1/teams/:teamId/leave',
      actor: 'member',
      params: { teamId: '@T2.id' },
      expect: { status: 204 },
      write: {
        watch: ['team_members'],
        delta: {
          deleted: [
            {
              table: 'team_members',
              where: 'team_id = @T2.id AND user_id = @member.id',
            },
          ],
        },
      },
    },
    {
      id: 'F10-leave-owner',
      route: 'POST /api/v1/teams/:teamId/leave',
      actor: 'owner',
      params: { teamId: '@T2.id' },
      expect: { status: 400 },
    },
    {
      id: 'F10-leave-not-member',
      route: 'POST /api/v1/teams/:teamId/leave',
      actor: 'outsider',
      params: { teamId: '@T2.id' },
      expect: { status: 404 },
    },
    {
      id: 'F10-transfer',
      route: 'POST /api/v1/teams/:teamId/transfer',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { userId: '@member.id' },
      expect: { status: 201 },
      write: {
        watch: ['teams', 'team_members'],
        delta: {
          updated: [
            { table: 'teams', where: 'id = @T1.id', changed: { owner_id: 3 } },
          ],
        },
      },
    },
    {
      id: 'F10-transfer-to-non-member',
      route: 'POST /api/v1/teams/:teamId/transfer',
      actor: 'owner',
      params: { teamId: '@T1.id' },
      body: { userId: '@outsider.id' },
      expect: { status: 400 },
    },
    {
      id: 'F10-transfer-member',
      route: 'POST /api/v1/teams/:teamId/transfer',
      actor: 'member',
      params: { teamId: '@T1.id' },
      body: { userId: '@member.id' },
      expect: { status: 403 },
    },
  ],
};
