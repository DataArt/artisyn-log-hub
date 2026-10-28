// F12 — teams: repositories (docs/qaa-overview/scenarios/05 §F12). A team repository is a URL
// (`team_repositories.repo_url`); per-user `repositories` rows carry the data.
import type { ContractFamily } from '../types';

export const f12TeamRepos: ContractFamily = {
  id: 'F12',
  name: 'team-repos',
  cases: [
    {
      // repositoryId: the lowest id among the members' own rows for that URL.
      // sessionCount: KNOWN DISCREPANCY, pinned as the code behaves today — it is
      // countDistinct(log_repositories.log_id), i.e. the number of LOGS of the members in that
      // repository, not of sessions (R1 for T1: 6 sessions, 10 logs). Reported with chunk 23.
      id: 'F12-list',
      route: 'GET /api/v1/teams/:teamId/repositories',
      actor: 'member',
      params: { teamId: '@T1.id' },
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT tr.id, tr.team_id, tr.repo_url, tr.added_at,
                     (SELECT min(r.id) FROM repositories r
                       WHERE r.repo_url = tr.repo_url
                         AND r.user_id IN (SELECT user_id FROM team_members WHERE team_id = tr.team_id))
                       AS repository_id,
                     (SELECT count(*) FROM log_repositories lr
                       WHERE lr.repo_id IN (SELECT r.id FROM repositories r
                                             WHERE r.repo_url = tr.repo_url
                                               AND r.user_id IN (SELECT user_id FROM team_members
                                                                  WHERE team_id = tr.team_id)))
                       AS log_count
                FROM team_repositories tr
               WHERE tr.team_id = $1
               ORDER BY tr.repo_url`,
        args: ['@T1.id'],
        shape: 'array',
        fields: {
          id: 'id',
          teamId: 'team_id',
          repoUrl: 'repo_url',
          addedAt: { col: 'added_at', as: 'iso' },
          repositoryId: 'repository_id',
          sessionCount: { col: 'log_count', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F12-list-outsider',
      route: 'GET /api/v1/teams/:teamId/repositories',
      actor: 'outsider',
      params: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      // The URL is normalised (`.git` dropped) before it is stored, and the new link gets its
      // single team_repo_config seeded (the owner has no personal config there → the default).
      id: 'F12-add',
      route: 'POST /api/v1/teams/:teamId/repositories',
      actor: 'owner',
      params: { teamId: '@T2.id' },
      body: { repoUrl: 'https://github.com/arrakis/empty-sietch.git' },
      expect: { status: 201 },
      write: {
        watch: [
          'team_repositories',
          'repositories',
          'repo_config',
          'team_repo_config',
        ],
        delta: {
          inserted: [
            {
              table: 'team_repositories',
              where: 'team_id = @T2.id AND id > 1000',
              check: [`repo_url = 'https://github.com/arrakis/empty-sietch'`],
            },
            {
              table: 'team_repo_config',
              where: 'team_repository_id > 1000',
              check: [`config -> 'fileCategories' -> 0 ->> 'name' = 'docs'`],
            },
          ],
        },
      },
    },
    {
      id: 'F12-add-member',
      route: 'POST /api/v1/teams/:teamId/repositories',
      actor: 'member',
      params: { teamId: '@T2.id' },
      body: { repoUrl: 'https://github.com/arrakis/empty-sietch' },
      expect: { status: 403 },
    },
    {
      // Only the link goes; the repository rows and their data stay.
      id: 'F12-unlink',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId/link',
      actor: 'owner',
      params: { teamId: '@T1.id', repoId: 3 },
      expect: { status: 204 },
      write: {
        watch: ['team_repositories', 'repositories', 'logs'],
        delta: {
          deleted: [{ table: 'team_repositories', where: 'id = 3' }],
        },
      },
    },
    {
      id: 'F12-unlink-member',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId/link',
      actor: 'member',
      params: { teamId: '@T1.id', repoId: 3 },
      expect: { status: 403 },
    },
    {
      // Wider than /link: when no other team links the URL, every repository row of that URL
      // (here R2, which has no logs) and its data go too (05 §F12).
      id: 'F12-remove',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId',
      actor: 'owner',
      params: { teamId: '@T1.id', repoId: 3 },
      expect: { status: 204 },
      write: {
        watch: [
          'team_repositories',
          'repositories',
          'logs',
          'log_repositories',
        ],
        delta: {
          deleted: [
            { table: 'team_repositories', where: 'id = 3' },
            { table: 'repositories', where: 'id = @R2.id' },
          ],
        },
      },
    },
    {
      // Another team still links R1's URL (T2), so removing it from T1 keeps the data.
      id: 'F12-remove-still-linked',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId',
      actor: 'owner',
      params: { teamId: '@T1.id', repoId: 1 },
      expect: { status: 204 },
      write: {
        watch: [
          'team_repositories',
          'repositories',
          'logs',
          'log_repositories',
          'team_repo_config',
          'team_repo_tool_monitor_config',
        ],
        delta: {
          deleted: [
            { table: 'team_repositories', where: 'id = 1' },
            // T1's config of R1 goes with its link by FK cascade.
            { table: 'team_repo_config', where: 'team_repository_id = 1' },
            // ...and so does T1's monitored-tools list of R1 (T-26).
            {
              table: 'team_repo_tool_monitor_config',
              where: 'team_repository_id = 1',
            },
          ],
        },
      },
    },
    {
      // Wider still (DD-11, 05 §F12 chunk 13): Rorphan's only log belongs to w1-s09-orphan, so
      // removing T1's only link to it also orphans that session, and the sweep that follows
      // (`deleteOrphanHarnessSnapshots`) deletes the harness_snapshots row s09 was bound to —
      // s04's own snapshot (a different id, still referenced by s04) is untouched.
      id: 'F12-remove-orphaned-sessions',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId',
      actor: 'owner',
      params: { teamId: '@T1.id', repoId: 4 },
      expect: { status: 204 },
      write: {
        watch: [
          'team_repositories',
          'repositories',
          'logs',
          'log_repositories',
          'sessions',
          'harness_snapshots',
        ],
        delta: {
          deleted: [
            { table: 'team_repositories', where: 'id = 4' },
            { table: 'repositories', where: 'id = @Rorphan.id' },
            { table: 'logs', where: 'session_id = @s09.id', count: 'all' },
            {
              table: 'log_repositories',
              where: 'repo_id = @Rorphan.id',
              count: 'all',
            },
            { table: 'sessions', where: 'id = @s09.id' },
            {
              table: 'harness_snapshots',
              where: 'snapshot_id = @harnessSnapshotIdOrphan',
            },
          ],
        },
      },
    },
    {
      id: 'F12-remove-outsider',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId',
      actor: 'outsider',
      params: { teamId: '@T1.id', repoId: 3 },
      expect: { status: 403 },
    },
    {
      // The admin role grants no data access (2026-10-21-private-repo-visibility). A non-member admin cannot read or change a team's links.
      id: 'F12-list-admin',
      route: 'GET /api/v1/teams/:teamId/repositories',
      actor: 'admin',
      params: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F12-unlink-admin',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId/link',
      actor: 'admin',
      params: { teamId: '@T1.id', repoId: 3 },
      expect: { status: 403 },
    },
    {
      id: 'F12-remove-admin',
      route: 'DELETE /api/v1/teams/:teamId/repositories/:repoId',
      actor: 'admin',
      params: { teamId: '@T1.id', repoId: 3 },
      expect: { status: 403 },
    },
  ],
};
