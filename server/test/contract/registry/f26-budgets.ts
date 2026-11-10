// F26 — budgets, spend, threshold notices (2026-11-05 budgets-threshold-alerts).
//
// World: `WORLD_V1.budgets` (a personal monthly budget on R1, T2's monthly team-repo budget on
// R1, T2's weekly team budget), one `created` event each, and one shown 75 % notice of the
// personal budget with an unread recipient row for the owner. The threshold job is switched off
// for the run (global-setup), so nothing but the request writes.
//
// Spend oracle (DD-3 / DD-4 / DD-5), written from the rules, not from the service's CTEs:
// the scope's root sessions — an artisyn log with a first prompt, linked to one of the scope's
// repository rows, not soft-deleted, by one of the scope's users — anchored at the artisyn
// log's start (or the first OTEL call of a root without a transcript) inside the period; each
// costs the larger of its tree cost (sub-agents included, FR-6) and its OTEL total. world-v1's
// sessions all live in January 2026, so the spend rows ask for that month by offset.
//
// Like the rest of registry/, nothing here imports from src/**.
import type { ContractCase, ContractFamily, ReadSpec } from '../types';
import { isoSql, treeCostWithOtelSubagentsSql } from './oracle-sql';

/**
 * Month offset of January 2026 from the current month (UTC), for `?period=month&offset=`. The
 * Europe/Berlin team-repo budget resolves "now" in Berlin: only a run in the last hour of a
 * month (UTC) would see a different month there.
 */
const NOW = new Date();
const JAN_2026_OFFSET =
  2026 * 12 - (NOW.getUTCFullYear() * 12 + NOW.getUTCMonth());

const JAN_UTC = {
  start: `timestamptz '2026-01-01 00:00:00+00'`,
  end: `timestamptz '2026-02-01 00:00:00+00'`,
};
const JAN_BERLIN = {
  start: `(timestamp '2026-01-01 00:00:00' AT TIME ZONE 'Europe/Berlin')`,
  end: `(timestamp '2026-02-01 00:00:00' AT TIME ZONE 'Europe/Berlin')`,
};

const SPEND_JAN_UTC = { period: 'month', offset: JAN_2026_OFFSET, tz: 'UTC' };

/**
 * The period's root trees of a scope as a derived table: `id`, `session_id`, `repo_id` (the
 * lowest linked scope repository), `user_email`, `branch`, `first_prompt`, `start_time`,
 * `anchor`, `micros` (budget cost) and `source` (`hook` / `otel` / `none`).
 * `repoIds` / `userIds` are SQL sub-selects; `userIds` null = no user filter.
 */
function rootsSql(
  repoIds: string,
  userIds: string | null,
  bounds: { start: string; end: string },
): string {
  const hookMicros = `coalesce(round(x.hook_usd * 1000000), 0)`;
  const otelMicros = `coalesce(x.otel_micros, 0)`;
  return `(SELECT x.*,
                  greatest(${hookMicros}, ${otelMicros}) AS micros,
                  CASE WHEN x.hook_usd IS NULL AND ${otelMicros} = 0 THEN 'none'
                       WHEN ${otelMicros} > ${hookMicros} THEN 'otel'
                       ELSE 'hook' END AS source
             FROM (SELECT DISTINCT ON (s.id)
                          s.id, s.session_id, lr.repo_id, u.email AS user_email,
                          a.git_branch AS branch, a.first_prompt, a.start_time,
                          ${treeCostWithOtelSubagentsSql('s.id')} AS hook_usd,
                          (SELECT ot.cost_usd_micros FROM otel_session_totals ot
                            WHERE ot.session_id = s.id) AS otel_micros,
                          CASE WHEN EXISTS (SELECT 1 FROM logs c
                                             WHERE c.session_id = s.id AND c.log_type = 'claude')
                               THEN a.start_time
                               ELSE coalesce((SELECT ot.first_call_at FROM otel_session_totals ot
                                               WHERE ot.session_id = s.id), a.start_time)
                          END AS anchor
                     FROM sessions s
                     JOIN logs a ON a.session_id = s.id AND a.log_type = 'artisyn'
                                AND a.first_prompt IS NOT NULL
                     JOIN log_repositories lr ON lr.log_id = a.id
                     JOIN users u ON u.id = a.user_id
                    WHERE NOT s.deleted
                      AND lr.repo_id IN (${repoIds})
                      ${userIds === null ? '' : `AND a.user_id IN (${userIds})`}
                    ORDER BY s.id, lr.repo_id) x
            WHERE x.anchor >= ${bounds.start} AND x.anchor < ${bounds.end})`;
}

// Scope rows (DD-3). Positional parameters: see each row's `args`.

/** `repo` scope: the owner's row of the URL ($1 = owner id, $2 = URL); users [$1]. */
const PERSONAL_R1_ROOTS = rootsSql(
  `SELECT r.id FROM repositories r WHERE r.user_id = $1 AND r.repo_url = $2`,
  `$1`,
  JAN_UTC,
);

/** Team members' rows of one URL ($1 = team id, $2 = URL). */
const TEAM_URL_REPOS = `SELECT r.id FROM repositories r
                         WHERE r.repo_url = $2
                           AND r.user_id IN (SELECT tm.user_id FROM team_members tm
                                              WHERE tm.team_id = $1)`;
/** Team members' rows of every URL the team links ($1 = team id). */
const TEAM_REPOS = `SELECT r.id FROM repositories r
                     WHERE r.repo_url IN (SELECT tr.repo_url FROM team_repositories tr
                                           WHERE tr.team_id = $1)
                       AND r.user_id IN (SELECT tm.user_id FROM team_members tm
                                          WHERE tm.team_id = $1)`;
/** A restricted team's visible users: the owner plus members who acknowledged ($1 = team id). */
const RESTRICTED_TEAM_USERS = `SELECT t.owner_id FROM teams t WHERE t.id = $1
                                UNION
                               SELECT tm.user_id FROM team_members tm
                                WHERE tm.team_id = $1 AND tm.disclosure_acknowledged_at IS NOT NULL`;

const SPEND_FIELDS: ReadSpec['fields'] = {
  spendMicros: { col: 'spend_micros', as: 'number' },
  sessions: { col: 'sessions', as: 'number' },
  unpricedTrees: { col: 'unpriced', as: 'number' },
};

function spendSql(roots: string): string {
  return `SELECT coalesce(sum(p.micros), 0) AS spend_micros, count(*) AS sessions,
                 count(*) FILTER (WHERE p.source = 'none') AS unpriced
            FROM ${roots} p`;
}

/** `spend/sessions` rows of the roots matching `where` (alias `p`), costliest first. */
function sessionsSql(roots: string, teamId: string, where: string): string {
  return `SELECT p.session_id, p.repo_id, ${teamId} AS team_id, p.start_time, p.user_email,
                 p.branch, p.micros, p.source, p.first_prompt
            FROM ${roots} p
           WHERE ${where}
           ORDER BY p.micros DESC, p.id`;
}

const SESSION_FIELDS: ReadSpec['fields'] = {
  sessionId: 'session_id',
  repoId: 'repo_id',
  teamId: 'team_id',
  startTime: { col: 'start_time', as: 'iso' },
  userEmail: 'user_email',
  branch: 'branch',
  micros: { col: 'micros', as: 'number' },
  source: 'source',
};

// Budgets (DD-21 BudgetDto).

const LABEL_SQL = `(CASE b.period WHEN 'day' THEN 'Daily' WHEN 'week' THEN 'Weekly' ELSE 'Monthly' END
                    || ' ' || chr(36) || to_char(b.amount_micros / 1000000.0, 'FM999,999,990.00'))`;
const CURRENT_START = `(date_trunc(b.period, now() AT TIME ZONE b.time_zone) AT TIME ZONE b.time_zone)`;
const CURRENT_END = `((date_trunc(b.period, now() AT TIME ZONE b.time_zone)
                       + ('1 ' || b.period)::interval) AT TIME ZONE b.time_zone)`;

function budgetsSql(where: string): string {
  return `SELECT b.id, b.scope_kind, b.period, b.amount_micros, to_jsonb(b.thresholds) AS thresholds,
                 b.time_zone, ${LABEL_SQL} AS label,
                 jsonb_build_object('start', ${isoSql(CURRENT_START)},
                                    'end', ${isoSql(CURRENT_END)}) AS current_period,
                 b.created_at, b.updated_at
            FROM budgets b WHERE ${where} ORDER BY b.id`;
}

const BUDGET_FIELDS: ReadSpec['fields'] = {
  id: 'id',
  scopeKind: 'scope_kind',
  period: 'period',
  amountMicros: { col: 'amount_micros', as: 'number' },
  thresholds: { col: 'thresholds', as: 'json' },
  timeZone: 'time_zone',
  label: 'label',
  currentPeriod: { col: 'current_period', as: 'json' },
  createdAt: { col: 'created_at', as: 'iso' },
  updatedAt: { col: 'updated_at', as: 'iso' },
};

const BUDGET_LIST = (where: string, args: ReadSpec['args']): ReadSpec => ({
  sql: budgetsSql(where),
  args,
  shape: 'array',
  path: 'budgets',
  fields: BUDGET_FIELDS,
  strict: true,
});

const BUDGET_OBJECT = (path: string, id: string): ReadSpec => ({
  sql: budgetsSql('b.id = $1'),
  args: [id],
  shape: 'object',
  path,
  fields: BUDGET_FIELDS,
  strict: true,
});

// Event log (DD-11).

function eventsSql(where: string): string {
  return `SELECT e.id, e.created_at, e.actor_email, e.budget_id, e.budget_label,
                 (e.budget_id IS NULL) AS budget_deleted, e.event_type, e.details
            FROM budget_events e WHERE ${where} ORDER BY e.id DESC`;
}

const EVENT_FIELDS: ReadSpec['fields'] = {
  id: { col: 'id', as: 'number' },
  createdAt: { col: 'created_at', as: 'iso' },
  actorEmail: 'actor_email',
  budgetId: 'budget_id',
  budgetLabel: 'budget_label',
  budgetDeleted: 'budget_deleted',
  eventType: 'event_type',
  details: { col: 'details', as: 'json' },
};

// Notices (DD-10 / DD-15). The world's only notice is a personal (`repo`) one, so the link
// oracle covers that kind: the recipient's own repository row of the URL, the period and its
// month offset from now in the notice's time zone.

const NOTICES_SQL = `
  SELECT n.id, n.created_at, (nr.read_at IS NOT NULL) AS read, n.threshold, n.spend_micros,
         n.amount_micros, n.budget_label,
         regexp_replace(n.repo_url, '^.*/([^/]+/[^/]+?)(\\.git)?/*$', '\\1') AS scope_label,
         n.period, n.period_start, n.period_end,
         jsonb_build_object(
           'repoId', (SELECT min(rp.id) FROM repositories rp
                       WHERE rp.user_id = nr.user_id AND rp.repo_url = n.repo_url),
           'period', n.period,
           'offset', greatest(-400, least(0,
             ((extract(year FROM n.period_start AT TIME ZONE n.time_zone) * 12
               + extract(month FROM n.period_start AT TIME ZONE n.time_zone))
              - (extract(year FROM now() AT TIME ZONE n.time_zone) * 12
                 + extract(month FROM now() AT TIME ZONE n.time_zone)))::int))) AS link
    FROM budget_notice_recipients nr
    JOIN budget_notices n ON n.id = nr.notice_id
   WHERE nr.user_id = $1 AND n.scope_kind = 'repo'
   ORDER BY n.id DESC`;

const NOTICE_FIELDS: ReadSpec['fields'] = {
  id: { col: 'id', as: 'number' },
  createdAt: { col: 'created_at', as: 'iso' },
  read: 'read',
  threshold: 'threshold',
  spendMicros: { col: 'spend_micros', as: 'number' },
  amountMicros: { col: 'amount_micros', as: 'number' },
  budgetLabel: 'budget_label',
  scopeLabel: 'scope_label',
  period: 'period',
  periodStart: { col: 'period_start', as: 'iso' },
  periodEnd: { col: 'period_end', as: 'iso' },
  link: { col: 'link', as: 'json' },
};

const BODY_WEEK = {
  period: 'week',
  amountUsd: 12.5,
  thresholds: [100, 50],
  timeZone: 'UTC',
};
const BODY_MONTH = {
  period: 'month',
  amountUsd: 30,
  thresholds: [75, 90, 100],
  timeZone: 'UTC',
};

// -------------------------------------------------------------------------------------------
// CRUD

const CRUD_ROWS: ContractCase[] = [
  {
    id: 'F26-list-repo',
    route: 'GET /api/v1/repositories/:repoId/budgets',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    expect: { status: 200, minRows: 1, bodyMatches: { canManage: true } },
    read: BUDGET_LIST(
      `b.scope_kind = 'repo' AND b.user_id = $1 AND b.repo_url = $2`,
      ['@owner.id', '@R1.url'],
    ),
  },
  {
    id: 'F26-list-team-repo-manager',
    route: 'GET /api/v1/repositories/:repoId/budgets',
    actor: 'manager',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id' },
    expect: { status: 200, minRows: 1, bodyMatches: { canManage: true } },
    read: BUDGET_LIST(
      `b.scope_kind = 'team-repo' AND b.team_id = $1 AND b.repo_url = $2`,
      ['@T2.id', '@R1.url'],
    ),
  },
  {
    // DD-9: a plain member of restricted T2 has no full view — no budgets list.
    id: 'F26-list-team-repo-member',
    route: 'GET /api/v1/repositories/:repoId/budgets',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id' },
    expect: { status: 403 },
  },
  {
    id: 'F26-list-repo-outsider',
    route: 'GET /api/v1/repositories/:repoId/budgets',
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    expect: { status: 403 },
  },
  {
    id: 'F26-list-team',
    route: 'GET /api/v1/teams/:teamId/budgets',
    actor: 'manager',
    params: { teamId: '@T2.id' },
    expect: { status: 200, minRows: 1, bodyMatches: { canManage: true } },
    read: BUDGET_LIST(`b.scope_kind = 'team' AND b.team_id = $1`, ['@T2.id']),
  },
  {
    id: 'F26-list-team-member',
    route: 'GET /api/v1/teams/:teamId/budgets',
    actor: 'member',
    params: { teamId: '@T2.id' },
    expect: { status: 403 },
  },
  {
    id: 'F26-list-team-outsider',
    route: 'GET /api/v1/teams/:teamId/budgets',
    actor: 'outsider',
    params: { teamId: '@T2.id' },
    expect: { status: 403 },
  },
  {
    // Thresholds come back distinct and sorted; the `created` event carries the actor and the
    // label snapshot.
    id: 'F26-create-repo',
    route: 'POST /api/v1/repositories/:repoId/budgets',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: BODY_WEEK,
    expect: {
      status: 201,
      bodyMatches: {
        scopeKind: 'repo',
        label: 'Weekly $12.50',
        thresholds: [50, 100],
        amountMicros: 12_500_000,
      },
    },
    write: {
      watch: ['budgets', 'budget_events'],
      delta: {
        inserted: [
          {
            table: 'budgets',
            where: 'id = $id',
            check: [
              `scope_kind = 'repo'`,
              'user_id = @owner.id',
              'team_id IS NULL',
              'repo_url = @R1.url',
              `period = 'week'`,
              'amount_micros = 12500000',
              `thresholds = '{50,100}'::smallint[]`,
              `time_zone = 'UTC'`,
              'created_by = @owner.id',
            ],
          },
          {
            table: 'budget_events',
            where: `budget_id = $id AND event_type = 'created'`,
            check: [
              `scope_kind = 'repo'`,
              'user_id = @owner.id',
              'repo_url = @R1.url',
              'actor_user_id = @owner.id',
              'actor_email = @owner.email',
              `budget_label = 'Weekly ' || chr(36) || '12.50'`,
              `details->'after'->>'amountMicros' = '12500000'`,
            ],
          },
        ],
      },
    },
  },
  {
    id: 'F26-create-repo-duplicate-period',
    route: 'POST /api/v1/repositories/:repoId/budgets',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: BODY_MONTH,
    expect: {
      status: 409,
      bodyMatches: { message: 'A month budget already exists for this scope' },
    },
  },
  {
    id: 'F26-create-repo-invalid-thresholds',
    route: 'POST /api/v1/repositories/:repoId/budgets',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: { ...BODY_WEEK, thresholds: [0, 300] },
    expect: { status: 400 },
  },
  {
    id: 'F26-create-repo-invalid-amount',
    route: 'POST /api/v1/repositories/:repoId/budgets',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    body: { ...BODY_WEEK, amountUsd: 1.234 },
    expect: { status: 400 },
  },
  {
    // A plain member of T2 may not manage the team's budgets (DD-2).
    id: 'F26-create-team-repo-member',
    route: 'POST /api/v1/repositories/:repoId/budgets',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id' },
    body: BODY_WEEK,
    expect: { status: 403 },
  },
  {
    id: 'F26-create-repo-outsider',
    route: 'POST /api/v1/repositories/:repoId/budgets',
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    body: BODY_WEEK,
    expect: { status: 403 },
  },
  {
    id: 'F26-create-team',
    route: 'POST /api/v1/teams/:teamId/budgets',
    actor: 'manager',
    params: { teamId: '@T2.id' },
    body: BODY_MONTH,
    expect: {
      status: 201,
      bodyMatches: { scopeKind: 'team', label: 'Monthly $30.00' },
    },
    write: {
      watch: ['budgets', 'budget_events'],
      delta: {
        inserted: [
          {
            table: 'budgets',
            where: 'id = $id',
            check: [
              `scope_kind = 'team'`,
              'team_id = @T2.id',
              'user_id IS NULL',
              'repo_url IS NULL',
              `period = 'month'`,
              'amount_micros = 30000000',
              'created_by = @manager.id',
            ],
          },
          {
            table: 'budget_events',
            where: `budget_id = $id AND event_type = 'created'`,
            check: [
              `scope_kind = 'team'`,
              'team_id = @T2.id',
              'actor_user_id = @manager.id',
              'actor_email = @manager.email',
            ],
          },
        ],
      },
    },
  },
  {
    id: 'F26-create-team-member',
    route: 'POST /api/v1/teams/:teamId/budgets',
    actor: 'member',
    params: { teamId: '@T2.id' },
    body: BODY_MONTH,
    expect: { status: 403 },
  },
  {
    id: 'F26-create-team-outsider',
    route: 'POST /api/v1/teams/:teamId/budgets',
    actor: 'outsider',
    params: { teamId: '@T2.id' },
    body: BODY_MONTH,
    expect: { status: 403 },
  },
  {
    // The `edited` event keeps both snapshots.
    id: 'F26-update-repo',
    route: 'PUT /api/v1/repositories/:repoId/budgets/:budgetId',
    actor: 'owner',
    params: { repoId: '@R1.id', budgetId: '@budgetOwnerR1.id' },
    body: {
      period: 'month',
      amountUsd: 8,
      thresholds: [100, 80],
      timeZone: 'Europe/Berlin',
    },
    expect: {
      status: 200,
      bodyMatches: { label: 'Monthly $8.00', thresholds: [80, 100] },
    },
    write: {
      watch: ['budgets', 'budget_events'],
      delta: {
        updated: [
          {
            table: 'budgets',
            where: 'id = @budgetOwnerR1.id',
            changed: {
              amount_micros: 8_000_000,
              thresholds: [80, 100],
              time_zone: 'Europe/Berlin',
            },
            anyChange: ['updated_at'],
          },
        ],
        inserted: [
          {
            table: 'budget_events',
            where: `budget_id = @budgetOwnerR1.id AND event_type = 'edited'`,
            check: [
              'actor_user_id = @owner.id',
              `budget_label = 'Monthly ' || chr(36) || '8.00'`,
              `details->'before'->>'amountMicros' = '5000000'`,
              `details->'before'->>'timeZone' = 'UTC'`,
              `details->'after'->>'amountMicros' = '8000000'`,
              `details->'after'->>'timeZone' = 'Europe/Berlin'`,
            ],
          },
        ],
      },
    },
  },
  {
    // The team-repo budget is not in the owner's personal scope: 404, never a cross-scope edit.
    id: 'F26-update-repo-foreign-scope',
    route: 'PUT /api/v1/repositories/:repoId/budgets/:budgetId',
    actor: 'owner',
    params: { repoId: '@R1.id', budgetId: '@budgetT2R1.id' },
    body: BODY_MONTH,
    expect: { status: 404 },
  },
  {
    id: 'F26-update-team-repo-member',
    route: 'PUT /api/v1/repositories/:repoId/budgets/:budgetId',
    actor: 'member',
    params: { repoId: '@R1.id', budgetId: '@budgetT2R1.id' },
    query: { teamId: '@T2.id' },
    body: BODY_MONTH,
    expect: { status: 403 },
  },
  {
    id: 'F26-update-team',
    route: 'PUT /api/v1/teams/:teamId/budgets/:budgetId',
    actor: 'manager',
    params: { teamId: '@T2.id', budgetId: '@budgetT2.id' },
    body: {
      period: 'week',
      amountUsd: 25,
      thresholds: [100],
      timeZone: 'Europe/Berlin',
    },
    expect: { status: 200, bodyMatches: { label: 'Weekly $25.00' } },
    write: {
      watch: ['budgets', 'budget_events'],
      delta: {
        updated: [
          {
            table: 'budgets',
            where: 'id = @budgetT2.id',
            changed: { amount_micros: 25_000_000, thresholds: [100] },
            anyChange: ['updated_at'],
          },
        ],
        inserted: [
          {
            table: 'budget_events',
            where: `budget_id = @budgetT2.id AND event_type = 'edited'`,
            check: ['actor_user_id = @manager.id', `scope_kind = 'team'`],
          },
        ],
      },
    },
  },
  {
    id: 'F26-update-team-member',
    route: 'PUT /api/v1/teams/:teamId/budgets/:budgetId',
    actor: 'member',
    params: { teamId: '@T2.id', budgetId: '@budgetT2.id' },
    body: BODY_MONTH,
    expect: { status: 403 },
  },
  {
    // The budget goes; its event and its notice survive with budget_id NULL (ON DELETE SET
    // NULL), plus the new `deleted` event (written before the row went, then nulled).
    id: 'F26-delete-repo',
    route: 'DELETE /api/v1/repositories/:repoId/budgets/:budgetId',
    actor: 'owner',
    params: { repoId: '@R1.id', budgetId: '@budgetOwnerR1.id' },
    expect: { status: 204 },
    write: {
      watch: [
        'budgets',
        'budget_events',
        'budget_notices',
        'budget_notice_recipients',
      ],
      delta: {
        deleted: [{ table: 'budgets', where: 'id = @budgetOwnerR1.id' }],
        updated: [
          {
            table: 'budget_events',
            where: 'budget_id = @budgetOwnerR1.id',
            changed: { budget_id: null },
          },
          {
            table: 'budget_notices',
            where: 'budget_id = @budgetOwnerR1.id',
            changed: { budget_id: null },
          },
        ],
        inserted: [
          {
            table: 'budget_events',
            where: `event_type = 'deleted' AND scope_kind = 'repo' AND user_id = @owner.id`,
            check: [
              'budget_id IS NULL',
              'actor_user_id = @owner.id',
              `budget_label = 'Monthly ' || chr(36) || '5.00'`,
              `details->'before'->>'amountMicros' = '5000000'`,
            ],
          },
        ],
      },
    },
  },
  {
    id: 'F26-delete-team-repo-manager',
    route: 'DELETE /api/v1/repositories/:repoId/budgets/:budgetId',
    actor: 'manager',
    params: { repoId: '@R1.id', budgetId: '@budgetT2R1.id' },
    query: { teamId: '@T2.id' },
    expect: { status: 204 },
    write: {
      watch: ['budgets', 'budget_events'],
      delta: {
        deleted: [{ table: 'budgets', where: 'id = @budgetT2R1.id' }],
        updated: [
          {
            table: 'budget_events',
            where: 'budget_id = @budgetT2R1.id',
            changed: { budget_id: null },
          },
        ],
        inserted: [
          {
            table: 'budget_events',
            where: `event_type = 'deleted' AND scope_kind = 'team-repo' AND team_id = @T2.id`,
            check: ['budget_id IS NULL', 'actor_user_id = @manager.id'],
          },
        ],
      },
    },
  },
  {
    id: 'F26-delete-repo-outsider',
    route: 'DELETE /api/v1/repositories/:repoId/budgets/:budgetId',
    actor: 'outsider',
    params: { repoId: '@R1.id', budgetId: '@budgetOwnerR1.id' },
    expect: { status: 403 },
  },
  {
    // The team owner manages the team's budgets.
    id: 'F26-delete-team',
    route: 'DELETE /api/v1/teams/:teamId/budgets/:budgetId',
    actor: 'owner',
    params: { teamId: '@T2.id', budgetId: '@budgetT2.id' },
    expect: { status: 204 },
    write: {
      watch: ['budgets', 'budget_events'],
      delta: {
        deleted: [{ table: 'budgets', where: 'id = @budgetT2.id' }],
        updated: [
          {
            table: 'budget_events',
            where: 'budget_id = @budgetT2.id',
            changed: { budget_id: null },
          },
        ],
        inserted: [
          {
            table: 'budget_events',
            where: `event_type = 'deleted' AND scope_kind = 'team' AND team_id = @T2.id`,
            check: ['budget_id IS NULL', 'actor_user_id = @owner.id'],
          },
        ],
      },
    },
  },
  {
    id: 'F26-delete-team-member',
    route: 'DELETE /api/v1/teams/:teamId/budgets/:budgetId',
    actor: 'member',
    params: { teamId: '@T2.id', budgetId: '@budgetT2.id' },
    expect: { status: 403 },
  },
];

// -------------------------------------------------------------------------------------------
// Event log

const EVENT_ROWS: ContractCase[] = [
  {
    id: 'F26-events-repo',
    route: 'GET /api/v1/repositories/:repoId/budgets/events',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    expect: { status: 200, minRows: 1, bodyMatches: { nextBefore: null } },
    read: {
      sql: eventsSql(
        `e.scope_kind = 'repo' AND e.user_id = $1 AND e.repo_url = $2`,
      ),
      args: ['@owner.id', '@R1.url'],
      shape: 'array',
      path: 'items',
      fields: EVENT_FIELDS,
      strict: true,
    },
  },
  {
    id: 'F26-events-team-repo-manager',
    route: 'GET /api/v1/repositories/:repoId/budgets/events',
    actor: 'manager',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id' },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: eventsSql(
        `e.scope_kind = 'team-repo' AND e.team_id = $1 AND e.repo_url = $2`,
      ),
      args: ['@T2.id', '@R1.url'],
      shape: 'array',
      path: 'items',
      fields: EVENT_FIELDS,
      strict: true,
    },
  },
  {
    id: 'F26-events-repo-outsider',
    route: 'GET /api/v1/repositories/:repoId/budgets/events',
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    expect: { status: 403 },
  },
  {
    // The event filter: only `created` events of the team scope.
    id: 'F26-events-team',
    route: 'GET /api/v1/teams/:teamId/budgets/events',
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: { event: 'created' },
    expect: { status: 200, minRows: 1 },
    read: {
      sql: eventsSql(
        `e.scope_kind = 'team' AND e.team_id = $1 AND e.event_type = 'created'`,
      ),
      args: ['@T2.id'],
      shape: 'array',
      path: 'items',
      fields: EVENT_FIELDS,
      strict: true,
    },
  },
  {
    id: 'F26-events-team-member',
    route: 'GET /api/v1/teams/:teamId/budgets/events',
    actor: 'member',
    params: { teamId: '@T2.id' },
    expect: { status: 403 },
  },
];

// -------------------------------------------------------------------------------------------
// Spend, spend/sessions, budget burn, budget report

const TEAM_REPO_R1_ROOTS = rootsSql(
  TEAM_URL_REPOS,
  RESTRICTED_TEAM_USERS,
  JAN_BERLIN,
);
const TEAM_REPO_R1_MEMBER_ROOTS = rootsSql(TEAM_URL_REPOS, `$3`, JAN_BERLIN);
const TEAM_T2_ROOTS = rootsSql(TEAM_REPOS, RESTRICTED_TEAM_USERS, JAN_UTC);
const TEAM_T2_MEMBER_ROOTS = rootsSql(TEAM_REPOS, `$2`, JAN_UTC);

/** DD-9: the restricted view carries no budget below the caller's own spend and no breakdown. */
const RESTRICTED_BODY = {
  restricted: true,
  canManage: false,
  budget: null,
  forecast: null,
  previous: null,
  daily: [],
  slices: [],
  costlySessions: { mean: 0, sigma: 0, items: [] },
  crossedThresholds: [],
};

const SPEND_ROWS: ContractCase[] = [
  {
    // January 2026 on R1 for its owner: s01 (1.725) + the s02 -> s03 tree (1.8) + s04 (0.4)
    // = 3.925 USD, 78.5 % of the 5.00 USD budget, so 75 is crossed.
    id: 'F26-spend-repo',
    route: 'GET /api/v1/repositories/:repoId/spend',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: SPEND_JAN_UTC,
    expect: {
      status: 200,
      bodyMatches: {
        restricted: false,
        isCurrent: false,
        canManage: true,
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-02-01T00:00:00.000Z',
        crossedThresholds: [75],
      },
    },
    read: {
      sql: spendSql(PERSONAL_R1_ROOTS),
      args: ['@owner.id', '@R1.url'],
      shape: 'object',
      fields: SPEND_FIELDS,
    },
  },
  {
    // The month's budget card is the scope's monthly budget.
    id: 'F26-spend-repo-budget',
    route: 'GET /api/v1/repositories/:repoId/spend',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: SPEND_JAN_UTC,
    expect: { status: 200 },
    read: BUDGET_OBJECT('budget', '@budgetOwnerR1.id'),
  },
  {
    // T2 on R1: the rows of every T2 member, the owner plus acknowledged members only
    // (restricted team), the January of the budget's Europe/Berlin time zone.
    id: 'F26-spend-team-repo-manager',
    route: 'GET /api/v1/repositories/:repoId/spend',
    actor: 'manager',
    params: { repoId: '@R1.id' },
    query: { ...SPEND_JAN_UTC, teamId: '@T2.id' },
    expect: {
      status: 200,
      bodyMatches: { restricted: false, timeZone: 'Europe/Berlin' },
    },
    read: {
      sql: spendSql(TEAM_REPO_R1_ROOTS),
      args: ['@T2.id', '@R1.url'],
      shape: 'object',
      fields: SPEND_FIELDS,
    },
  },
  {
    // DD-9: the plain member sees their own spend only (s06, unpriced), no slices.
    id: 'F26-spend-team-repo-member',
    route: 'GET /api/v1/repositories/:repoId/spend',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { ...SPEND_JAN_UTC, teamId: '@T2.id' },
    expect: { status: 200, bodyMatches: RESTRICTED_BODY },
    read: {
      sql: spendSql(TEAM_REPO_R1_MEMBER_ROOTS),
      args: ['@T2.id', '@R1.url', '@member.id'],
      shape: 'object',
      fields: SPEND_FIELDS,
    },
  },
  {
    id: 'F26-spend-repo-outsider',
    route: 'GET /api/v1/repositories/:repoId/spend',
    actor: 'outsider',
    params: { repoId: '@R1.id' },
    query: SPEND_JAN_UTC,
    expect: { status: 403 },
  },
  {
    id: 'F26-spend-repo-bad-period',
    route: 'GET /api/v1/repositories/:repoId/spend',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { period: 'year', offset: 0, tz: 'UTC' },
    expect: { status: 400 },
  },
  {
    // The whole team: R1 and Rdesert (s04 is linked to both and counts once, s11 is
    // Rdesert's). No monthly team budget, so the period is the query's UTC month.
    id: 'F26-spend-team-manager',
    route: 'GET /api/v1/teams/:teamId/spend',
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: SPEND_JAN_UTC,
    expect: {
      status: 200,
      bodyMatches: { restricted: false, budget: null, timeZone: 'UTC' },
    },
    read: {
      sql: spendSql(TEAM_T2_ROOTS),
      args: ['@T2.id'],
      shape: 'object',
      fields: SPEND_FIELDS,
    },
  },
  {
    id: 'F26-spend-team-member',
    route: 'GET /api/v1/teams/:teamId/spend',
    actor: 'member',
    params: { teamId: '@T2.id' },
    query: SPEND_JAN_UTC,
    expect: { status: 200, bodyMatches: RESTRICTED_BODY },
    read: {
      sql: spendSql(TEAM_T2_MEMBER_ROOTS),
      args: ['@T2.id', '@member.id'],
      shape: 'object',
      fields: SPEND_FIELDS,
    },
  },
  {
    id: 'F26-spend-team-outsider',
    route: 'GET /api/v1/teams/:teamId/spend',
    actor: 'outsider',
    params: { teamId: '@T2.id' },
    query: SPEND_JAN_UTC,
    expect: { status: 403 },
  },
  {
    // The owner's slice row opens every root of the owner, costliest first.
    id: 'F26-spend-sessions-repo',
    route: 'GET /api/v1/repositories/:repoId/spend/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...SPEND_JAN_UTC, slice: 'user', key: 'owner@arrakis.test' },
    expect: { status: 200, minRows: 3, bodyMatches: { truncated: false } },
    read: {
      sql: sessionsSql(PERSONAL_R1_ROOTS, 'NULL::int', `p.user_email = $3`),
      args: ['@owner.id', '@R1.url', '@owner.email'],
      shape: 'array',
      path: 'sessions',
      fields: { ...SESSION_FIELDS, firstPrompt: 'first_prompt' },
      strict: true,
    },
  },
  {
    id: 'F26-spend-sessions-team-repo-member',
    route: 'GET /api/v1/repositories/:repoId/spend/sessions',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: {
      ...SPEND_JAN_UTC,
      teamId: '@T2.id',
      slice: 'user',
      key: 'member@arrakis.test',
    },
    expect: { status: 403 },
  },
  {
    id: 'F26-spend-sessions-bad-slice',
    route: 'GET /api/v1/repositories/:repoId/spend/sessions',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { ...SPEND_JAN_UTC, slice: 'planet', key: 'all' },
    expect: { status: 400 },
  },
  {
    // A branch row of the team view: s04 (linked to R1 and Rdesert) under the lower repo id.
    id: 'F26-spend-sessions-team-manager',
    route: 'GET /api/v1/teams/:teamId/spend/sessions',
    actor: 'manager',
    params: { teamId: '@T2.id' },
    query: { ...SPEND_JAN_UTC, slice: 'branch', key: 'feature/sandworm' },
    expect: { status: 200, minRows: 1, bodyMatches: { truncated: false } },
    read: {
      sql: sessionsSql(
        TEAM_T2_ROOTS,
        '$1::int',
        `p.branch = 'feature/sandworm'`,
      ),
      args: ['@T2.id'],
      shape: 'array',
      path: 'sessions',
      fields: SESSION_FIELDS,
    },
  },
  {
    id: 'F26-spend-sessions-team-member',
    route: 'GET /api/v1/teams/:teamId/spend/sessions',
    actor: 'member',
    params: { teamId: '@T2.id' },
    query: { ...SPEND_JAN_UTC, slice: 'user', key: 'member@arrakis.test' },
    expect: { status: 403 },
  },
  {
    // The current period of the scope's monthly budget (world data is all in January 2026,
    // so nothing is spent in it); the budget is the scope's month budget.
    id: 'F26-budget-burn',
    route: 'GET /api/v1/repositories/:repoId/analytics/budget-burn',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { tz: 'UTC' },
    expect: {
      status: 200,
      bodyMatches: { filtered: false, spendMicros: 0, anomalyKeys: [] },
    },
    read: BUDGET_OBJECT('budget', '@budgetOwnerR1.id'),
  },
  {
    id: 'F26-budget-burn-team-repo-manager',
    route: 'GET /api/v1/repositories/:repoId/analytics/budget-burn',
    actor: 'manager',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id', tz: 'UTC' },
    expect: { status: 200 },
    read: BUDGET_OBJECT('budget', '@budgetT2R1.id'),
  },
  {
    id: 'F26-budget-burn-team-repo-member',
    route: 'GET /api/v1/repositories/:repoId/analytics/budget-burn',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: { teamId: '@T2.id', tz: 'UTC' },
    expect: { status: 403 },
  },
  {
    // January 2026 is one past period of the monthly budget: spend, percent and crossed
    // thresholds, no forecast; days at least twice the period's daily average are anomalies.
    id: 'F26-report-budget',
    route: 'GET /api/v1/repositories/:repoId/reports/budget',
    actor: 'owner',
    params: { repoId: '@R1.id' },
    query: { startDate: '2026-01-01', endDate: '2026-01-31', tz: 'UTC' },
    expect: { status: 200, minRows: 1, bodyMatches: { noBudgetPeriods: null } },
    read: {
      sql: `WITH p AS ${PERSONAL_R1_ROOTS},
                 sp AS (SELECT coalesce(sum(p.micros), 0) AS spend FROM p)
            SELECT '2026-01-01T00:00:00.000Z' AS start, '2026-02-01T00:00:00.000Z' AS period_end,
                   false AS is_current, sp.spend AS spend_micros,
                   sp.spend * 100.0 / b.amount_micros AS percent_used, NULL::jsonb AS forecast,
                   to_jsonb(ARRAY(SELECT t FROM unnest(b.thresholds) t
                                   WHERE sp.spend * 100 >= t * b.amount_micros ORDER BY t)) AS crossed,
                   to_jsonb(ARRAY(SELECT d.k FROM (SELECT to_char(p.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS k,
                                                          sum(p.micros) AS m
                                                     FROM p GROUP BY 1) d
                                   WHERE sp.spend > 0 AND d.m >= 2.0 * sp.spend / 31
                                   ORDER BY d.k)) AS anomaly_days
              FROM budgets b CROSS JOIN sp
             WHERE b.id = $3`,
      args: ['@owner.id', '@R1.url', '@budgetOwnerR1.id'],
      shape: 'array',
      path: 'budgets.0.periods',
      fields: {
        start: 'start',
        end: 'period_end',
        isCurrent: 'is_current',
        spendMicros: { col: 'spend_micros', as: 'number' },
        percentUsed: { col: 'percent_used', as: 'numeric' },
        forecast: 'forecast',
        crossedThresholds: { col: 'crossed', as: 'json' },
        anomalyDays: { col: 'anomaly_days', as: 'json' },
      },
      strict: true,
    },
  },
  {
    id: 'F26-report-budget-team-repo-member',
    route: 'GET /api/v1/repositories/:repoId/reports/budget',
    actor: 'member',
    params: { repoId: '@R1.id' },
    query: {
      teamId: '@T2.id',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      tz: 'UTC',
    },
    expect: { status: 403 },
  },
];

// -------------------------------------------------------------------------------------------
// Notices

const NOTICE_ROWS: ContractCase[] = [
  {
    id: 'F26-notices',
    route: 'GET /api/v1/budget-notices',
    actor: 'owner',
    expect: {
      status: 200,
      minRows: 1,
      bodyMatches: { unreadCount: 1, nextBefore: null },
    },
    read: {
      sql: NOTICES_SQL,
      args: ['@owner.id'],
      shape: 'array',
      path: 'items',
      fields: NOTICE_FIELDS,
      strict: true,
    },
  },
  {
    // Own rows only: the member is no recipient of anything.
    id: 'F26-notices-member',
    route: 'GET /api/v1/budget-notices',
    actor: 'member',
    expect: { status: 200, bodyMatches: { unreadCount: 0, nextBefore: null } },
    read: {
      sql: NOTICES_SQL,
      args: ['@member.id'],
      shape: 'array',
      path: 'items',
      fields: NOTICE_FIELDS,
    },
  },
  {
    id: 'F26-notices-read',
    route: 'POST /api/v1/budget-notices/read',
    actor: 'owner',
    body: { ids: ['@noticeOwner75.id'] },
    expect: { status: 200, bodyMatches: { unreadCount: 0 } },
    write: {
      watch: ['budget_notice_recipients', 'budget_notices'],
      delta: {
        updated: [
          {
            table: 'budget_notice_recipients',
            where: 'notice_id = @noticeOwner75.id AND user_id = @owner.id',
            changed: {},
            anyChange: ['read_at'],
          },
        ],
      },
      after: [
        `(SELECT read_at IS NOT NULL FROM budget_notice_recipients
           WHERE notice_id = @noticeOwner75.id AND user_id = @owner.id)`,
      ],
    },
  },
  {
    // A foreign id matches none of the caller's rows: the owner's row stays unread.
    id: 'F26-notices-read-foreign',
    route: 'POST /api/v1/budget-notices/read',
    actor: 'member',
    body: { ids: ['@noticeOwner75.id'] },
    expect: { status: 200, bodyMatches: { unreadCount: 0 } },
    write: {
      watch: ['budget_notice_recipients', 'budget_notices'],
      delta: {},
      after: [
        `(SELECT read_at IS NULL FROM budget_notice_recipients
           WHERE notice_id = @noticeOwner75.id AND user_id = @owner.id)`,
      ],
    },
  },
  {
    id: 'F26-notices-read-all',
    route: 'POST /api/v1/budget-notices/read',
    actor: 'owner',
    body: { all: true },
    expect: { status: 200, bodyMatches: { unreadCount: 0 } },
    write: {
      watch: ['budget_notice_recipients'],
      delta: {
        updated: [
          {
            table: 'budget_notice_recipients',
            where: 'user_id = @owner.id AND read_at IS NULL',
            changed: {},
            anyChange: ['read_at'],
          },
        ],
      },
    },
  },
  {
    id: 'F26-notices-read-bad-body',
    route: 'POST /api/v1/budget-notices/read',
    actor: 'owner',
    body: { ids: ['one'] },
    expect: { status: 400 },
  },
  {
    id: 'F26-notices-anon',
    route: 'GET /api/v1/budget-notices',
    actor: 'anon',
    expect: { status: 401 },
  },
];

export const f26Budgets: ContractFamily = {
  id: 'F26',
  name: 'budgets',
  cases: [...CRUD_ROWS, ...EVENT_ROWS, ...SPEND_ROWS, ...NOTICE_ROWS],
};
