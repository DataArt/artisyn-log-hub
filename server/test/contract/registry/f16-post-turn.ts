// F16 — post-turn analysis: the hook's gate read and its two result submissions
// (docs/qaa-overview/scenarios/05 §F16). Auth: API key.
//
// World: w1-s01 (owner) has attribution values at watermark 2, two attribution runs and one
// submitted advisor run; T1's team_repo_config (link 1) enables both branches at the team layer.
import type { ContractFamily } from '../types';

const R1_URL = 'https://github.com/arrakis/spice-harvester';

const ATTRIBUTE_TICKET = {
  key: 'ticket',
  type: 'string',
  label: 'Ticket',
  prompt: 'Which ticket is this session about?',
};

const ATTRIBUTION_RUN = {
  startedAt: '2026-01-10T11:00:00.000Z',
  finishedAt: '2026-01-10T11:00:30.000Z',
  invokingSessionId: 'w1-s01-plain',
  evalSessionId: 'w1-eval-attr-new',
  cost: {
    model: 'world-model-a',
    costUsd: 0.004,
    inputTokens: 4000,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
};

export const f16PostTurn: ContractFamily = {
  id: 'F16',
  name: 'post-turn',
  cases: [
    {
      // Golden: without a team the gate resolves the caller's own (user) layer — no advisor
      // settings there, so the advisor stays at its defaults; attribution is enabled and already
      // evaluated up to the session's current watermark (2).
      id: 'F16-config',
      route: 'GET /api/v2/post-turn-analysis/config',
      actor: 'ownerKey',
      query: { repoUrl: R1_URL, sessionId: '@s01.sessionId' },
      expect: {
        status: 200,
        bodyMatches: {
          advisor: {
            enabled: false,
            thresholdMet: false,
            minSessionCostUsd: 0.1,
            aggregate: null,
            fileCategories: [{ name: 'Docs', patterns: ['^docs/'] }],
          },
          attribution: {
            enabled: true,
            attributes: [ATTRIBUTE_TICKET],
            evaluatedWatermark: 2,
            evaluationRequired: false,
          },
        },
      },
      // The gate read's documented side effect: it records the hook's prompt watermark
      // monotonically (GREATEST). An absent watermark counts as 0, so only the timestamp moves.
      write: {
        watch: ['session_prompt_watermark'],
        delta: {
          updated: [
            {
              table: 'session_prompt_watermark',
              where: 'session_id = @s01.id',
              changed: { prompt_watermark: 2 },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      // A higher watermark is recorded, and the stored evaluation (2) is now behind it.
      id: 'F16-config-new-prompt',
      route: 'GET /api/v2/post-turn-analysis/config',
      actor: 'ownerKey',
      query: {
        repoUrl: R1_URL,
        sessionId: '@s01.sessionId',
        promptWatermark: 4,
      },
      expect: { status: 200 },
      write: {
        watch: ['session_prompt_watermark'],
        delta: {
          updated: [
            {
              table: 'session_prompt_watermark',
              where: 'session_id = @s01.id',
              changed: { prompt_watermark: 4 },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      // Never regresses: a smaller watermark leaves the stored one.
      id: 'F16-config-old-prompt',
      route: 'GET /api/v2/post-turn-analysis/config',
      actor: 'ownerKey',
      query: {
        repoUrl: R1_URL,
        sessionId: '@s01.sessionId',
        promptWatermark: 1,
      },
      expect: { status: 200 },
      write: {
        watch: ['session_prompt_watermark'],
        delta: {
          updated: [
            {
              table: 'session_prompt_watermark',
              where: 'session_id = @s01.id',
              changed: { prompt_watermark: 2 },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      // A session the server has not seen yet: nothing to record.
      id: 'F16-config-unknown-session',
      route: 'GET /api/v2/post-turn-analysis/config',
      actor: 'ownerKey',
      query: { repoUrl: R1_URL, sessionId: 'w1-not-ingested-yet' },
      expect: { status: 200 },
      noDb: true,
    },
    {
      id: 'F16-config-no-repo-url',
      route: 'GET /api/v2/post-turn-analysis/config',
      actor: 'ownerKey',
      expect: { status: 400 },
    },
    {
      id: 'F16-config-no-key',
      route: 'GET /api/v2/post-turn-analysis/config',
      actor: 'anon',
      query: { repoUrl: R1_URL, sessionId: '@s01.sessionId' },
      expect: { status: 401 },
    },
    {
      id: 'F16-advisor-submit',
      route: 'POST /api/v2/turn-end-cost-advisor',
      actor: 'ownerKey',
      body: {
        sessionId: '@s02.sessionId',
        evalSessionId: 'w1-eval-adv-new',
        startedAt: '2026-01-11T09:46:00.000Z',
        finishedAt: '2026-01-11T09:46:30.000Z',
        outcome: 'submitted',
        summary: {
          general: 'One long refactor turn.',
          costFactors: ['cache writes'],
          harnessAdvice: ['split the turn'],
        },
        cost: {
          model: 'world-model-a',
          costUsd: 0.03,
          inputTokens: 30000,
          outputTokens: 3000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      expect: { status: 200, bodyMatches: { applied: true } },
      write: {
        watch: ['turn_end_advisor_runs'],
        delta: {
          inserted: [
            {
              table: 'turn_end_advisor_runs',
              where: `session_id = 'w1-s02-parent'`,
              check: [
                `outcome = 'submitted'`,
                'user_id = @owner.id',
                `eval_session_id = 'w1-eval-adv-new'`,
                `summary_general = 'One long refactor turn.'`,
                `cost_factors = '["cache writes"]'::jsonb`,
                `harness_advice = '["split the turn"]'::jsonb`,
                `model = 'world-model-a'`,
                'cost_usd = 0.03',
                'input_tokens = 30000',
                'output_tokens = 3000',
                'failure_reason IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      // Append-only: a second run for w1-s01 does not replace the first.
      id: 'F16-advisor-failed-run',
      route: 'POST /api/v2/turn-end-cost-advisor',
      actor: 'ownerKey',
      body: {
        sessionId: '@s01.sessionId',
        startedAt: '2026-01-10T10:40:00.000Z',
        finishedAt: '2026-01-10T10:40:30.000Z',
        outcome: 'failed',
        failureReason: 'timeout',
      },
      expect: { status: 200 },
      write: {
        watch: ['turn_end_advisor_runs'],
        delta: {
          inserted: [
            {
              table: 'turn_end_advisor_runs',
              where: `session_id = 'w1-s01-plain' AND id > 1000`,
              check: [
                `outcome = 'failed'`,
                `failure_reason = 'timeout'`,
                'summary_general IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      // Not ingested yet: still recorded, keyed by the raw session id (no FK to wait for).
      id: 'F16-advisor-unknown-session',
      route: 'POST /api/v2/turn-end-cost-advisor',
      actor: 'ownerKey',
      body: {
        sessionId: 'w1-not-ingested-yet',
        startedAt: '2026-01-10T10:40:00.000Z',
        finishedAt: '2026-01-10T10:40:30.000Z',
        outcome: 'failed',
        failureReason: 'timeout',
      },
      expect: { status: 200 },
      write: {
        watch: ['turn_end_advisor_runs'],
        delta: {
          inserted: [
            {
              table: 'turn_end_advisor_runs',
              where: `session_id = 'w1-not-ingested-yet'`,
              check: ['user_id = @owner.id'],
            },
          ],
        },
      },
    },
    {
      id: 'F16-advisor-foreign-session',
      route: 'POST /api/v2/turn-end-cost-advisor',
      actor: 'memberKey',
      body: {
        sessionId: '@s01.sessionId',
        startedAt: '2026-01-10T10:40:00.000Z',
        finishedAt: '2026-01-10T10:40:30.000Z',
        outcome: 'failed',
      },
      expect: { status: 404 },
    },
    {
      // A newer watermark wins: the values are replaced and an `applied` run is recorded.
      id: 'F16-attribution-applied',
      route: 'POST /api/v2/session-attribution',
      actor: 'ownerKey',
      body: {
        ...ATTRIBUTION_RUN,
        sessionId: '@s01.sessionId',
        promptWatermark: 3,
        outcome: 'submitted',
        values: { ticket: 'ARR-9' },
      },
      expect: { status: 200, bodyMatches: { applied: true } },
      write: {
        watch: ['session_attribution', 'session_attribution_runs'],
        delta: {
          updated: [
            {
              table: 'session_attribution',
              where: 'session_id = @s01.id',
              changed: { prompt_watermark: 3, values: { ticket: 'ARR-9' } },
              anyChange: ['updated_at'],
            },
          ],
          inserted: [
            {
              table: 'session_attribution_runs',
              where: 'session_id = @s01.id AND id > 1000',
              check: [
                `outcome = 'applied'`,
                'prompt_watermark = 3',
                `eval_session_id = 'w1-eval-attr-new'`,
                `invoking_session_id = 'w1-s01-plain'`,
                'cost_usd = 0.004',
                'input_tokens = 4000',
              ],
            },
          ],
        },
      },
    },
    {
      // A watermark at or below the stored one loses: values untouched, the run is still logged.
      id: 'F16-attribution-stale',
      route: 'POST /api/v2/session-attribution',
      actor: 'ownerKey',
      body: {
        ...ATTRIBUTION_RUN,
        sessionId: '@s01.sessionId',
        promptWatermark: 1,
        outcome: 'submitted',
        values: { ticket: 'ARR-0' },
      },
      expect: { status: 200, bodyMatches: { applied: false } },
      write: {
        watch: ['session_attribution', 'session_attribution_runs'],
        delta: {
          inserted: [
            {
              table: 'session_attribution_runs',
              where: 'session_id = @s01.id AND id > 1000',
              check: [`outcome = 'ignored_stale'`, 'prompt_watermark = 1'],
            },
          ],
        },
      },
    },
    {
      // A failed evaluation never touches the values.
      id: 'F16-attribution-failed',
      route: 'POST /api/v2/session-attribution',
      actor: 'ownerKey',
      body: {
        ...ATTRIBUTION_RUN,
        sessionId: '@s04.sessionId',
        promptWatermark: 2,
        outcome: 'failed',
        failureReason: 'model refused',
      },
      expect: { status: 200, bodyMatches: { applied: false } },
      write: {
        watch: ['session_attribution', 'session_attribution_runs'],
        delta: {
          inserted: [
            {
              table: 'session_attribution_runs',
              where: 'session_id = @s04.id',
              check: [`outcome = 'failed'`, `failure_reason = 'model refused'`],
            },
          ],
        },
      },
    },
    {
      // Not ingested yet: success-shaped `{applied:false}` and nothing written.
      id: 'F16-attribution-not-ingested',
      route: 'POST /api/v2/session-attribution',
      actor: 'ownerKey',
      body: {
        ...ATTRIBUTION_RUN,
        sessionId: 'w1-not-ingested-yet',
        promptWatermark: 1,
        outcome: 'submitted',
        values: { ticket: 'ARR-0' },
      },
      expect: { status: 200, bodyMatches: { applied: false } },
      noDb: true,
    },
    {
      id: 'F16-attribution-foreign-session',
      route: 'POST /api/v2/session-attribution',
      actor: 'memberKey',
      body: {
        ...ATTRIBUTION_RUN,
        sessionId: '@s01.sessionId',
        promptWatermark: 5,
        outcome: 'submitted',
        values: { ticket: 'ARR-X' },
      },
      expect: { status: 404 },
    },
    {
      // OKF facts (FR-20, DD-34): the caller's own session tree, rebuilt from the stored claude
      // bodies — the root (main agent) first, then its sub-agent. The world's bodies carry no
      // tool calls, so every read/change list is empty; the prompts are the root's own.
      id: 'F16-okf-facts',
      route: 'GET /api/v2/okf-usage/facts',
      actor: 'ownerKey',
      query: { sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        minRows: 2,
        bodyMatches: {
          sessionId: '@s02.sessionId',
          startedAt: '2026-01-11T09:00:00.000Z',
          prompts: ['Refactor the harvester scheduler'],
          tree: { changes: [], reads: [], runs: [] },
        },
      },
      read: {
        sql: `WITH RECURSIVE tree AS (
                SELECT id, session_id, parent_session_id FROM sessions WHERE id = $1
                UNION ALL
                SELECT c.id, c.session_id, c.parent_session_id
                  FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id)
              SELECT session_id, parent_session_id FROM tree
               ORDER BY (parent_session_id IS NOT NULL), id`,
        args: ['@s02.id'],
        shape: 'array',
        path: 'agents',
        fields: { id: 'session_id', parentId: 'parent_session_id' },
      },
    },
    {
      // DD-33: a session of another user is the same 404 as a missing one.
      id: 'F16-okf-facts-foreign-session',
      route: 'GET /api/v2/okf-usage/facts',
      actor: 'memberKey',
      query: { sessionId: '@s02.sessionId' },
      expect: { status: 404 },
    },
    {
      id: 'F16-okf-facts-unknown-session',
      route: 'GET /api/v2/okf-usage/facts',
      actor: 'ownerKey',
      query: { sessionId: 'w1-no-such-session' },
      expect: { status: 404 },
    },
    {
      id: 'F16-okf-facts-no-session-id',
      route: 'GET /api/v2/okf-usage/facts',
      actor: 'ownerKey',
      expect: { status: 400 },
    },
    {
      id: 'F16-okf-facts-no-key',
      route: 'GET /api/v2/okf-usage/facts',
      actor: 'anon',
      query: { sessionId: '@s02.sessionId' },
      expect: { status: 401 },
    },
  ],
};
