// F14 — repositories: list, card, settings, hook state (docs/qaa-overview/scenarios/05 §F14).
//
// Access ("scope"): the repository's owner; a user whose logs are linked to it; with `?teamId=`
// a member of a team that links the URL. Anyone else gets 403; an unknown id 404. Values computed
// from the static `latest-hook-version.json` (latestVersion, outdated) depend on the checkout's
// build state and are not compared.
import type { ContractFamily } from '../types';

/** The team layer of R1's config in world-v1 (T1's team_repo_config row, link id 1). */
const R1_TEAM_CONFIG = {
  fileCategories: [{ name: 'Source', patterns: ['^src/'] }],
  highCacheCreationThreshold: 50000,
  turnEndCostAdvisor: { enabled: true, minSessionCostUsd: 1 },
  sessionAttribution: {
    enabled: true,
    attributes: [
      {
        key: 'ticket',
        label: 'Ticket',
        type: 'string',
        prompt: 'Which ticket is this session about?',
      },
    ],
  },
};

/**
 * Settings oracle: the team layer of team_repositories link $3 (team_repo_config) and the
 * caller's ($2) personal layer for the URL of repository $1 (repo_config, lowest repo_id).
 */
const F14_SETTINGS_SQL = `SELECT
    (SELECT config FROM team_repo_config WHERE team_repository_id = $3) AS team_config,
    (SELECT rc.config FROM repo_config rc
       JOIN repositories r ON r.id = rc.repo_id
      WHERE r.repo_url = (SELECT repo_url FROM repositories WHERE id = $1)
        AND rc.user_id = $2
      ORDER BY rc.repo_id
      LIMIT 1) AS user_config`;

export const f14Repositories: ContractFamily = {
  id: 'F14',
  name: 'repositories',
  cases: [
    {
      // Own rows plus rows the caller's logs are linked to; R2 has no logs and still shows.
      id: 'F14-list',
      route: 'GET /api/v1/repositories',
      actor: 'owner',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT r.id, r.repo_url FROM repositories r
               WHERE r.user_id = $1
                  OR EXISTS (SELECT 1 FROM log_repositories lr JOIN logs l ON l.id = lr.log_id
                              WHERE lr.repo_id = r.id AND l.user_id = $1)
               ORDER BY r.repo_url, r.id`,
        args: ['@owner.id'],
        shape: 'array',
        fields: { id: 'id', repoUrl: 'repo_url' },
        strict: true,
      },
    },
    {
      id: 'F14-list-author',
      route: 'GET /api/v1/repositories',
      actor: 'author',
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT r.id, r.repo_url FROM repositories r
               WHERE r.user_id = $1
                  OR EXISTS (SELECT 1 FROM log_repositories lr JOIN logs l ON l.id = lr.log_id
                              WHERE lr.repo_id = r.id AND l.user_id = $1)
               ORDER BY r.repo_url, r.id`,
        args: ['@author.id'],
        shape: 'array',
        fields: { id: 'id', repoUrl: 'repo_url' },
        strict: true,
      },
    },
    {
      // Repositories a hook has reported from. issueCount = recommendations + (outdated) +
      // (an error line in the log tail); R1 has one recommendation and a clean tail.
      id: 'F14-hooks',
      route: 'GET /api/v1/repositories/hooks',
      actor: 'owner',
      expect: { status: 200, minRows: 1 },
      read: {
        sql: `SELECT id, repo_url, hook_version,
                     jsonb_array_length(coalesce(hook_recommendations, '[]'::jsonb)) AS issue_count
                FROM repositories
               WHERE user_id = $1 AND hook_version IS NOT NULL
               ORDER BY repo_url`,
        args: ['@owner.id'],
        shape: 'array',
        fields: {
          id: 'id',
          repoUrl: 'repo_url',
          hookVersion: 'hook_version',
          issueCount: { col: 'issue_count', as: 'number' },
        },
        strict: true,
        ignore: ['outdated'],
      },
    },
    {
      // Without ?teamId the card carries the caller's own (user-layer) config.
      id: 'F14-get',
      route: 'GET /api/v1/repositories/:repoId',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT r.id, r.repo_url, c.config
                FROM repositories r
                LEFT JOIN repo_config c ON c.repo_id = r.id AND c.user_id = $2
               WHERE r.id = $1`,
        args: ['@R1.id', '@owner.id'],
        shape: 'object',
        fields: {
          id: 'id',
          repoUrl: 'repo_url',
          repoConfig: { col: 'config', as: 'json' },
        },
        strict: true,
      },
    },
    {
      id: 'F14-get-outsider',
      route: 'GET /api/v1/repositories/:repoId',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F14-get-unknown',
      route: 'GET /api/v1/repositories/:repoId',
      actor: 'owner',
      params: { repoId: 999 },
      expect: { status: 404 },
    },
    {
      id: 'F14-hook-state',
      route: 'GET /api/v1/repositories/:repoId/hook-state',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT repo_url, hook_version, hook_last_activity, hook_log_tail,
                     hook_non_uploadable_logs, hook_recommendations
                FROM repositories WHERE id = $1`,
        args: ['@R1.id'],
        shape: 'object',
        fields: {
          repoUrl: 'repo_url',
          hookVersion: 'hook_version',
          lastActivity: { col: 'hook_last_activity', as: 'iso?' },
          logTail: { col: 'hook_log_tail', as: 'json' },
          nonUploadableLogs: { col: 'hook_non_uploadable_logs', as: 'json' },
          recommendations: { col: 'hook_recommendations', as: 'json' },
        },
        strict: true,
        ignore: ['latestVersion', 'outdated', 'errors'],
      },
    },
    {
      id: 'F14-hook-state-outsider',
      route: 'GET /api/v1/repositories/:repoId/hook-state',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      // The team layer verbatim from team_repo_config, the user layer from repo_config. The
      // effective config is a golden value, as the merge rule resolves it in personal view:
      // fileCategories from the user layer, sessionAttribution from the team layer (the team's
      // advisor/threshold keys do not reach it).
      id: 'F14-settings',
      route: 'GET /api/v1/repositories/:repoId/settings',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: {
        status: 200,
        bodyMatches: {
          teamId: 1,
          canEditTeamConfig: true,
          effectiveConfig: {
            fileCategories: [{ name: 'Docs', patterns: ['^docs/'] }],
            sessionAttribution: R1_TEAM_CONFIG.sessionAttribution,
          },
        },
      },
      read: {
        sql: F14_SETTINGS_SQL,
        args: ['@R1.id', '@owner.id', 1],
        shape: 'object',
        fields: {
          teamConfig: { col: 'team_config', as: 'json' },
          userConfig: { col: 'user_config', as: 'json' },
        },
      },
    },
    {
      // Team view: a T1 member (not its owner) reads the owner's R1 row through the team. The
      // effective config is T1's alone; userConfig is the member's own (none in world-v1).
      id: 'F14-settings-team',
      route: 'GET /api/v1/repositories/:repoId/settings',
      actor: 'member',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: {
        status: 200,
        bodyMatches: {
          teamId: 1,
          canEditTeamConfig: false,
          effectiveConfig: R1_TEAM_CONFIG,
        },
      },
      read: {
        sql: F14_SETTINGS_SQL,
        args: ['@R1.id', '@member.id', 1],
        shape: 'object',
        fields: {
          teamConfig: { col: 'team_config', as: 'json' },
          userConfig: { col: 'user_config', as: 'json' },
        },
      },
    },
    {
      id: 'F14-settings-team-outsider',
      route: 'GET /api/v1/repositories/:repoId/settings',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F14-settings-team-zero',
      route: 'GET /api/v1/repositories/:repoId/settings',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { teamId: 0 },
      expect: { status: 400 },
    },
    {
      id: 'F14-settings-outsider',
      route: 'GET /api/v1/repositories/:repoId/settings',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F14-put-team-settings',
      route: 'PUT /api/v1/repositories/:repoId/settings/team',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      body: {
        config: { ...R1_TEAM_CONFIG, highCacheCreationThreshold: 80000 },
      },
      expect: { status: 200 },
      write: {
        watch: ['team_repo_config'],
        // A config change re-derives the per-session file categories and cache-creation causes.
        derived: ['session_file_stats', 'session_cause_stats'],
        delta: {
          updated: [
            {
              table: 'team_repo_config',
              where: 'team_repository_id = 1',
              changed: {
                config: {
                  ...R1_TEAM_CONFIG,
                  highCacheCreationThreshold: 80000,
                },
              },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      // Team view: T1's owner writes exactly T1's single config (link id 1).
      id: 'F14-put-team-settings-team',
      route: 'PUT /api/v1/repositories/:repoId/settings/team',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      body: {
        config: { ...R1_TEAM_CONFIG, highCacheCreationThreshold: 90000 },
      },
      expect: { status: 200 },
      write: {
        watch: ['team_repo_config'],
        // A config change re-derives the per-session file categories and cache-creation causes.
        derived: ['session_file_stats', 'session_cause_stats'],
        delta: {
          updated: [
            {
              table: 'team_repo_config',
              where: 'team_repository_id = 1',
              changed: {
                config: {
                  ...R1_TEAM_CONFIG,
                  highCacheCreationThreshold: 90000,
                },
              },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      // A T1 member who does not own T1 cannot write its config.
      id: 'F14-put-team-settings-team-member',
      route: 'PUT /api/v1/repositories/:repoId/settings/team',
      actor: 'member',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      body: { config: R1_TEAM_CONFIG },
      expect: { status: 403 },
    },
    {
      id: 'F14-put-user-settings',
      route: 'PUT /api/v1/repositories/:repoId/settings/user',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      body: {
        config: { fileCategories: [{ name: 'Tests', patterns: ['^test/'] }] },
      },
      expect: { status: 200 },
      write: {
        watch: ['repo_config'],
        keys: { repo_config: ['repo_id', 'user_id'] },
        // A config change re-derives the per-session file categories and cache-creation causes.
        derived: ['session_file_stats', 'session_cause_stats'],
        delta: {
          updated: [
            {
              table: 'repo_config',
              where: 'repo_id = @R1.id AND user_id = @owner.id',
              changed: {
                config: {
                  fileCategories: [{ name: 'Tests', patterns: ['^test/'] }],
                },
              },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      // `config: null` removes the user layer altogether; the team layer stays.
      id: 'F14-clear-user-settings',
      route: 'PUT /api/v1/repositories/:repoId/settings/user',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      body: { config: null },
      expect: { status: 200 },
      write: {
        watch: ['repo_config'],
        keys: { repo_config: ['repo_id', 'user_id'] },
        // A config change re-derives the per-session file categories and cache-creation causes.
        derived: ['session_file_stats', 'session_cause_stats'],
        delta: {
          deleted: [
            {
              table: 'repo_config',
              where: 'repo_id = @R1.id AND user_id = @owner.id',
            },
          ],
        },
      },
    },
    {
      id: 'F14-put-team-settings-outsider',
      route: 'PUT /api/v1/repositories/:repoId/settings/team',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      body: { config: {} },
      expect: { status: 403 },
    },
    {
      // Distinct sessions with an artisyn log in the repository. Soft-deleted sessions are not
      // filtered (current code, 05 §F14) — w1-s05 has no logs left, so it cannot show.
      id: 'F14-summary',
      route: 'GET /api/v1/repositories/:repoId/summary',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT count(DISTINCT l.session_id) AS session_count,
                     count(DISTINCT l.user_id) AS user_count
                FROM logs l JOIN log_repositories lr ON lr.log_id = l.id
               WHERE lr.repo_id = $1 AND l.log_type = 'artisyn'`,
        args: ['@R1.id'],
        shape: 'object',
        fields: {
          sessionCount: { col: 'session_count', as: 'number' },
          userCount: { col: 'user_count', as: 'number' },
        },
        strict: true,
      },
    },
    {
      // Team view (T1 is transparent): every T1 member's repository row of R1's URL, not
      // only the row the request names.
      id: 'F14-summary-team',
      route: 'GET /api/v1/repositories/:repoId/summary',
      actor: 'member',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT count(DISTINCT l.session_id) AS session_count,
                     count(DISTINCT l.user_id) AS user_count
                FROM logs l
                JOIN log_repositories lr ON lr.log_id = l.id
                JOIN repositories r ON r.id = lr.repo_id
                JOIN team_members tm ON tm.user_id = r.user_id AND tm.team_id = $2
               WHERE r.repo_url = (SELECT repo_url FROM repositories WHERE id = $1)
                 AND l.log_type = 'artisyn'`,
        args: ['@R1.id', '@T1.id'],
        shape: 'object',
        fields: {
          sessionCount: { col: 'session_count', as: 'number' },
          userCount: { col: 'user_count', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F14-summary-outsider',
      route: 'GET /api/v1/repositories/:repoId/summary',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F14-contexts',
      route: 'GET /api/v1/repositories/:repoId/contexts',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT DISTINCT c.context_key, c.context_value
                FROM contexts c
                JOIN log_contexts lc ON lc.context_id = c.id
                JOIN log_repositories lr ON lr.log_id = lc.log_id
               WHERE lr.repo_id = $1`,
        args: ['@R1.id'],
        shape: 'array',
        // The endpoint has no ORDER BY: compare as sets.
        sortBy: 'value',
        fields: { key: 'context_key', value: 'context_value' },
        strict: true,
      },
    },
    {
      id: 'F14-contexts-outsider',
      route: 'GET /api/v1/repositories/:repoId/contexts',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
  ],
};
