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
                       WHERE lr.repo_id = r.id) AS first_seen
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
          'session_request_ids',
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
            {
              table: 'session_request_ids',
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
