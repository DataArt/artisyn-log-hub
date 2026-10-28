// F08 — admin: repositories and teams (docs/qaa-overview/scenarios/05 §F08). Both aggregates
// are proven by one sub-query per metric, never by the endpoint's multi-LEFT-JOIN shape, so a
// row product (2 teams x 3 logs) would surface as a wrong count.
import type { ContractFamily } from '../types';

export const f08AdminReposTeams: ContractFamily = {
  id: 'F08',
  name: 'admin-repos-teams',
  cases: [
    {
      // sessionCount: sessions with an artisyn log that has a first prompt, a claude log, and
      // not soft-deleted. rawUploadCount: distinct sessions of any linked log.
      id: 'F08-repos',
      route: 'GET /api/v1/admin/repos',
      actor: 'admin',
      expect: { status: 200, minRows: 5 },
      read: {
        sql: `SELECT r.id, r.repo_url, u.email AS owner_email, r.max_upload_bytes,
                     (SELECT count(DISTINCT l.session_id) FROM logs l
                        JOIN log_repositories lr ON lr.log_id = l.id
                       WHERE lr.repo_id = r.id) AS raw_upload_count,
                     (SELECT count(*) FROM sessions s
                       WHERE NOT s.deleted
                         AND EXISTS (SELECT 1 FROM logs a JOIN log_repositories la ON la.log_id = a.id
                                      WHERE la.repo_id = r.id AND a.session_id = s.id
                                        AND a.log_type = 'artisyn' AND a.first_prompt IS NOT NULL)
                         AND EXISTS (SELECT 1 FROM logs c JOIN log_repositories lc ON lc.log_id = c.id
                                      WHERE lc.repo_id = r.id AND c.session_id = s.id
                                        AND c.log_type = 'claude')) AS session_count,
                     (SELECT coalesce(sum(pg_column_size(l.body)), 0) FROM logs l
                        JOIN log_repositories lr ON lr.log_id = l.id
                       WHERE lr.repo_id = r.id) AS log_size,
                     (SELECT max(l.end_time) FROM logs l
                        JOIN log_repositories lr ON lr.log_id = l.id
                       WHERE lr.repo_id = r.id) AS last_session,
                     (SELECT min(l.start_time) FROM logs l
                        JOIN log_repositories lr ON lr.log_id = l.id
                       WHERE lr.repo_id = r.id) AS first_seen,
                     (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM team_repositories tr
                        JOIN teams t ON t.id = tr.team_id
                       WHERE tr.repo_url = r.repo_url) AS team_name
                FROM repositories r JOIN users u ON u.id = r.user_id`,
        shape: 'array',
        sortBy: 'id',
        fields: {
          id: 'id',
          repoUrl: 'repo_url',
          ownerEmail: 'owner_email',
          rawUploadCount: { col: 'raw_upload_count', as: 'number' },
          sessionCount: { col: 'session_count', as: 'number' },
          logSize: { col: 'log_size', as: 'number' },
          maxUploadBytes: 'max_upload_bytes',
          lastSession: { col: 'last_session', as: 'iso?' },
          firstSeen: { col: 'first_seen', as: 'iso?' },
          // Every team linking the URL, by name; null when none (metadata only).
          teamName: 'team_name',
        },
        strict: true,
      },
    },
    {
      id: 'F08-repos-member',
      route: 'GET /api/v1/admin/repos',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F08-teams',
      route: 'GET /api/v1/admin/teams',
      actor: 'admin',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT t.id, t.name, t.created_at,
                     (SELECT email FROM users WHERE id = t.owner_id) AS owner_email,
                     (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
                     (SELECT count(*) FROM team_repositories tr WHERE tr.team_id = t.id) AS repo_count
                FROM teams t`,
        shape: 'array',
        sortBy: 'id',
        fields: {
          id: 'id',
          name: 'name',
          ownerEmail: 'owner_email',
          createdAt: { col: 'created_at', as: 'iso' },
          memberCount: { col: 'member_count', as: 'number' },
          repoCount: { col: 'repo_count', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F08-teams-member',
      route: 'GET /api/v1/admin/teams',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      // Member identity only (the "Set new owner" picker) — no session data.
      id: 'F08-team-members',
      route: 'GET /api/v1/admin/teams/:teamId/members',
      actor: 'admin',
      params: { teamId: '@T1.id' },
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT m.user_id, u.email, m.user_id = t.owner_id AS is_owner
                FROM team_members m
                JOIN users u ON u.id = m.user_id
                JOIN teams t ON t.id = m.team_id
               WHERE m.team_id = $1`,
        args: ['@T1.id'],
        shape: 'array',
        sortBy: 'userId',
        fields: { userId: 'user_id', email: 'email', isOwner: 'is_owner' },
        strict: true,
      },
    },
    {
      id: 'F08-team-members-unknown',
      route: 'GET /api/v1/admin/teams/:teamId/members',
      actor: 'admin',
      params: { teamId: 999 },
      expect: { status: 404 },
    },
    {
      id: 'F08-team-members-member',
      route: 'GET /api/v1/admin/teams/:teamId/members',
      actor: 'member',
      params: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      // FR-8: a non-member admin hands T1 to one of its members; the old owner stays a member.
      id: 'F08-set-team-owner',
      route: 'POST /api/v1/admin/teams/:teamId/owner',
      actor: 'admin',
      params: { teamId: '@T1.id' },
      body: { userId: '@member.id' },
      expect: { status: 200, bodyMatches: { id: 1, ownerId: 3 } },
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
      id: 'F08-set-team-owner-outsider',
      route: 'POST /api/v1/admin/teams/:teamId/owner',
      actor: 'admin',
      params: { teamId: '@T1.id' },
      body: { userId: '@outsider.id' },
      expect: { status: 400 },
    },
    {
      id: 'F08-set-team-owner-unknown',
      route: 'POST /api/v1/admin/teams/:teamId/owner',
      actor: 'admin',
      params: { teamId: 999 },
      body: { userId: '@member.id' },
      expect: { status: 404 },
    },
    {
      id: 'F08-set-team-owner-member',
      route: 'POST /api/v1/admin/teams/:teamId/owner',
      actor: 'member',
      params: { teamId: '@T1.id' },
      body: { userId: '@member.id' },
      expect: { status: 403 },
    },
    {
      // Link 1 carries R1's URL, which has a repositories row — not an orphan. (world-v1 has no
      // orphan link; the 204 path is covered by scenario S-ADM-01.)
      id: 'F08-remove-orphan-team-repo-not-orphan',
      route: 'DELETE /api/v1/admin/team-repos/:teamRepoId',
      actor: 'admin',
      params: { teamRepoId: 1 },
      expect: { status: 404 },
    },
    {
      id: 'F08-remove-orphan-team-repo-member',
      route: 'DELETE /api/v1/admin/team-repos/:teamRepoId',
      actor: 'member',
      params: { teamRepoId: 1 },
      expect: { status: 403 },
    },
    {
      // R3's URL belongs to the outsider alone: the repository, its log links, its logs and
      // the session w1-s08 go; the user and everything of other repositories stay.
      id: 'F08-remove-repo',
      route: 'DELETE /api/v1/admin/repos/:id',
      actor: 'admin',
      params: { id: '@R3.id' },
      expect: { status: 204 },
      write: {
        watch: [
          'repositories',
          'log_repositories',
          'logs',
          'sessions',
          'session_stats',
          'session_costs',
          'session_request_ids',
          'session_tool_usage',
        ],
        delta: {
          deleted: [
            { table: 'repositories', where: 'id = @R3.id' },
            {
              table: 'log_repositories',
              where: 'repo_id = @R3.id',
              count: 'all',
            },
            {
              table: 'logs',
              where: 'session_id = @s08.id',
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
      },
    },
    {
      id: 'F08-remove-repo-unknown',
      route: 'DELETE /api/v1/admin/repos/:id',
      actor: 'admin',
      params: { id: 999 },
      expect: { status: 404 },
    },
    {
      id: 'F08-remove-repo-member',
      route: 'DELETE /api/v1/admin/repos/:id',
      actor: 'member',
      params: { id: '@R3.id' },
      expect: { status: 403 },
    },
  ],
};
