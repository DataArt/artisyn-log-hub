import { randomUUID } from 'crypto';
import { loadConfig } from './config';
import { makeArtisynNdjson, makeClaudeNdjson } from './data';
import { AuthClient } from './auth-client';
import { IdCollector, Scenario, SeedData } from './types';

const config = loadConfig();
const BASE = config.baseUrl;

// Pre-generate bodies once so data-gen cost is excluded from timings
const BODY_SMALL = makeClaudeNdjson(5);
const BODY_MEDIUM = makeArtisynNdjson(100);
const BODY_LARGE = makeArtisynNdjson(500);

/**
 * One realtime OTEL batch body (`POST /api/v2/otel-realtime`): `count` synthetic
 * `claude_code.api_request` log lines in the receiver's chunk-line shape. Synthetic data only.
 */
function makeOtelRealtimeBody(
  sessionId: string,
  count: number,
  batchSeq: number,
): string {
  const base = Date.now() - count * 1000;
  const lines = Array.from({ length: count }, (_, i) => {
    const nanos = String(BigInt(base + i * 1000) * 1_000_000n);
    return {
      signal: 'logs',
      receivedAt: new Date(base + i * 1000).toISOString(),
      hookVersion: '2.29.0',
      resource: { 'service.name': 'claude-code', 'service.version': '2.1.0' },
      scope: { name: 'com.anthropic.claude_code.events' },
      record: {
        timeUnixNano: nanos,
        body: { stringValue: 'claude_code.api_request' },
        attributes: [
          { key: 'session.id', value: { stringValue: sessionId } },
          {
            key: 'request_id',
            value: { stringValue: `req_perf_${sessionId}_${batchSeq}_${i}` },
          },
          {
            key: 'model',
            value: {
              stringValue:
                i % 3 === 0 ? 'claude-haiku-4-5' : 'claude-sonnet-4-6',
            },
          },
          {
            key: 'query_source',
            value: {
              stringValue: i % 5 === 0 ? 'compact' : 'repl_main_thread',
            },
          },
          { key: 'input_tokens', value: { intValue: String(100 + i) } },
          { key: 'output_tokens', value: { intValue: String(50 + i) } },
          { key: 'cache_read_tokens', value: { intValue: '2000' } },
          { key: 'cache_creation_tokens', value: { intValue: '300' } },
          { key: 'cost_usd', value: { doubleValue: 0.0012 + i * 0.0001 } },
        ],
      },
    };
  });
  return JSON.stringify({
    sessionId,
    hookVersion: '2.29.0',
    receiverId: 'perf-receiver',
    batchSeq,
    droppedLines: 0,
    lines,
  });
}

/** Run shape of the *-heavy scenarios: few serial calls, each one is a heavy page load. */
type RunOverrides = Pick<
  Scenario,
  'iterations' | 'warmupIterations' | 'parallel'
>;

const HEAVY_RUN: RunOverrides = {
  iterations: 20,
  warmupIterations: 2,
  parallel: 1,
};

/** A GET scenario that passes when the response is 2xx. */
function getScenario(
  name: string,
  description: string,
  path: string,
  run: RunOverrides,
): Scenario {
  return {
    name,
    description,
    ...run,
    fn: async (auth: unknown) => {
      const res = await (auth as AuthClient).fetch(path);
      return { ok: res.ok };
    },
  };
}

/**
 * Every read endpoint of one repository. `suffix` names the variant (`''` for the regular seed
 * repo, `'-heavy'` for the heavy one), so the regular names stay stable against old baselines.
 */
function repoReadScenarios(
  repoId: string,
  suffix: string,
  run: RunOverrides,
  range: { startDate: string; endDate: string },
): Scenario[] {
  const r = `/api/v1/repositories/${repoId}`;
  const dates = `startDate=${encodeURIComponent(range.startDate)}&endDate=${encodeURIComponent(range.endDate)}`;
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const week = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  const note = suffix ? ' — heavy repo, 12 × ~5 MB transcripts' : '';
  const list: Array<[string, string, string]> = [
    [
      'repos:sessions',
      'GET /api/v1/repositories/:id/sessions',
      `${r}/sessions`,
    ],
    [
      'repos:sessions-ids',
      'GET /api/v1/repositories/:id/sessions/ids',
      `${r}/sessions/ids`,
    ],
    ['repos:summary', 'GET /api/v1/repositories/:id/summary', `${r}/summary`],
    ['repos:get', 'GET /api/v1/repositories/:repoId — single repo fetch', r],
    [
      'repos:branches',
      'GET /api/v1/repositories/:repoId/sessions/branches',
      `${r}/sessions/branches`,
    ],
    [
      'repos:contexts',
      'GET /api/v1/repositories/:repoId/contexts',
      `${r}/contexts`,
    ],
    [
      'repos:attribution-values',
      'GET /api/v1/repositories/:repoId/session-attribution/values — 90-day range',
      `${r}/session-attribution/values?${dates}`,
    ],
    [
      'repos:export-scope',
      'GET /api/v1/repositories/:repoId/sessions/export-scope — 90-day range',
      `${r}/sessions/export-scope?from=${encodeURIComponent(range.startDate)}&to=${encodeURIComponent(range.endDate)}`,
    ],
    [
      'repos:analytics-timeline',
      'GET /api/v1/repositories/:repoId/analytics/timeline — 90-day range',
      `${r}/analytics/timeline?${dates}`,
    ],
    [
      'repos:analytics-work-time',
      'GET /api/v1/repositories/:repoId/analytics/work-time — 90-day range',
      `${r}/analytics/work-time?${dates}`,
    ],
    [
      'repos:analytics-change-surface',
      'GET /api/v1/repositories/:repoId/analytics/change-surface — 90-day range',
      `${r}/analytics/change-surface?${dates}`,
    ],
    [
      'otel:repo-facts-week',
      'GET /api/v1/repositories/:repoId/otel/facts — 1-week OTEL snapshot',
      `${r}/otel/facts?${week}`,
    ],
    [
      'repos:spend',
      'GET /api/v1/repositories/:repoId/spend — current month (budgets Spend tab)',
      `${r}/spend?period=month&offset=0&tz=UTC`,
    ],
  ];
  // The heavy repo is seeded from transcripts only and has no hook state (404).
  if (!suffix) {
    list.push([
      'repos:hook-state',
      'GET /api/v1/repositories/:repoId/hook-state',
      `${r}/hook-state`,
    ]);
  }
  return list.map(([name, description, path]) =>
    getScenario(name + suffix, description + note, path, run),
  );
}

/** Every read endpoint of one session (the session detail page), named like repoReadScenarios. */
function sessionReadScenarios(
  repoId: string,
  sessionId: string,
  suffix: string,
  run: RunOverrides,
): Scenario[] {
  const p = `/api/v1/repositories/${repoId}/sessions/${sessionId}`;
  const note = suffix ? ' — heavy session, ~5 MB transcript + sub-agent' : '';
  const list: Array<[string, string, string]> = [
    [
      'repos:session-logs',
      'GET /api/v1/repositories/:repoId/sessions/:sid/logs',
      `${p}/logs`,
    ],
    [
      'repos:session-contexts',
      'GET /api/v1/repositories/:repoId/sessions/:sid/contexts',
      `${p}/contexts`,
    ],
    [
      'repos:session-change-surface',
      'GET /api/v1/repositories/:repoId/sessions/:sid/change-surface',
      `${p}/change-surface`,
    ],
    [
      'repos:session-change-surface-files',
      'GET /api/v1/repositories/:repoId/sessions/:sid/change-surface/files',
      `${p}/change-surface/files`,
    ],
    [
      'repos:session-okf-usage',
      'GET /api/v1/repositories/:repoId/sessions/:sid/okf-usage',
      `${p}/okf-usage`,
    ],
  ];
  return list.map(([name, description, path]) =>
    getScenario(name + suffix, description + note, path, run),
  );
}

/** Scenarios whose endpoint only exists under a password-based auth mode. */
const PASSWORD_ONLY_SCENARIOS = new Set(['auth:login']);

export function buildScenarios(
  seedData: SeedData,
  idCollector: IdCollector,
  /**
   * The server's active auth mode (`AuthClient.authMode`, resolved during setup). When `none`,
   * the password-only scenarios are dropped rather than left to 404 — a scenario that cannot
   * succeed contributes only phantom errors and a meaningless timing.
   */
  authMode?: string | null,
): Scenario[] {
  const { repoId, sessionId, heavyRepoId, heavySessionId } = seedData;

  const now = new Date();
  const startDate = new Date(
    now.getTime() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const endDate = now.toISOString();
  const dateRange = { startDate, endDate };

  const all: Scenario[] = [
    {
      name: 'auth:login',
      description: 'POST /api/v1/auth/login — session cookie auth',
      // Skipped entirely under AUTH_MODE=none (see the filter at the end of this function):
      // `login`/`signup` are gated by `AllowedAuthModes` and 404 there, which made this
      // scenario report 500 errors out of 500 iterations while timing nothing but the 404 —
      // and then read as a 77 % speed-up against a baseline captured under password auth.
      //
      // Do NOT "fix" it by pointing at `/auth/identify` instead. That was tried: identify
      // calls Passport's `req.logIn`, which regenerates the session, and 500 iterations of it
      // corrupted the shared AuthClient session for every later scenario in the run
      // (auth:me 500/500 errors, logs:small 500/500, logs:subagent 427/500, and a partial
      // seed). A login scenario has to establish a session; hammering one that mutates the
      // harness's own session is not measurable in a single-session run.
      fn: async (_auth) => {
        const res = await fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: config.testUser.email,
            password: config.testUser.password,
          }),
        });
        return { ok: res.ok };
      },
    },
    {
      name: 'auth:me',
      description: 'GET /api/v1/auth/me — session read',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/auth/me');
        return { ok: res.ok };
      },
    },
    {
      name: 'logs:v2-small',
      writes: true,
      description:
        'POST /api/v2/logs — 5 lines claude (stage-then-queue async path)',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const sid = randomUUID();
        const res = await fetch(
          `${BASE}/api/v2/logs?sessionId=${sid}&type=claude`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain',
              ...authClient.apiKeyHeader,
            },
            body: BODY_SMALL,
          },
        );
        if (res.ok) idCollector.sessionUuids.add(sid);
        return { ok: res.ok };
      },
    },
    {
      name: 'logs:subagent',
      writes: true,
      description:
        'POST /api/v2/logs — 5 lines claude-subagent + parentSessionId (Task-tool subagent path, staged + queued)',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const agentId = `agent-${randomUUID()}`;
        const parentId = sessionId ?? randomUUID();
        const res = await fetch(
          `${BASE}/api/v2/logs?sessionId=${agentId}&type=claude-subagent&parentSessionId=${encodeURIComponent(parentId)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain',
              ...authClient.apiKeyHeader,
            },
            body: BODY_SMALL,
          },
        );
        if (res.ok) idCollector.sessionUuids.add(agentId);
        return { ok: res.ok };
      },
    },
    {
      name: 'logs:medium',
      writes: true,
      description: 'POST /api/v2/logs — 100 lines artisyn (staged + queued)',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const sid = randomUUID();
        const res = await fetch(
          `${BASE}/api/v2/logs?sessionId=${sid}&type=artisyn`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain',
              ...authClient.apiKeyHeader,
            },
            body: BODY_MEDIUM,
          },
        );
        if (res.ok) idCollector.sessionUuids.add(sid);
        return { ok: res.ok };
      },
    },
    {
      name: 'logs:large',
      writes: true,
      description: 'POST /api/v2/logs — 500 lines artisyn (staged + queued)',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const sid = randomUUID();
        const res = await fetch(
          `${BASE}/api/v2/logs?sessionId=${sid}&type=artisyn`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain',
              ...authClient.apiKeyHeader,
            },
            body: BODY_LARGE,
          },
        );
        if (res.ok) idCollector.sessionUuids.add(sid);
        return { ok: res.ok };
      },
    },
    {
      name: 'logs:upsert',
      writes: true,
      description:
        'POST /api/v2/logs — re-upload the same sessionId (staged + queued update path)',
      fn: (() => {
        const fixedSid = randomUUID();
        idCollector.sessionUuids.add(fixedSid);
        return async (auth) => {
          const authClient = auth as AuthClient;
          const res = await fetch(
            `${BASE}/api/v2/logs?sessionId=${fixedSid}&type=artisyn`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'text/plain',
                ...authClient.apiKeyHeader,
              },
              body: BODY_MEDIUM,
            },
          );
          return { ok: res.ok };
        };
      })(),
    },
    {
      name: 'otel:realtime-50',
      writes: true,
      description:
        'POST /api/v2/otel-realtime — one realtime batch of 50 api_request lines (synchronous ingest)',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const sid = randomUUID();
        const res = await fetch(`${BASE}/api/v2/otel-realtime`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authClient.apiKeyHeader,
          },
          body: makeOtelRealtimeBody(sid, 50, 1),
        });
        if (res.ok) idCollector.sessionUuids.add(sid);
        return { ok: res.ok };
      },
    },
    {
      name: 'repos:list',
      description: 'GET /api/v1/repositories',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/repositories');
        return { ok: res.ok };
      },
    },
    {
      name: 'repos:hooks',
      description: 'GET /api/v1/repositories/hooks — list hook-reporting repos',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/repositories/hooks');
        return { ok: res.ok };
      },
    },
    // Heavy repo (seedHeavyData in run.ts): 12 sessions with ~5 MB transcripts each. Every read
    // endpoint of the repo and of one session runs against it, so a query that scans the stored
    // transcripts shows up here (and fails its budgets.json entry) before it reaches a real
    // instance. Few serial calls: each one is heavy, and a budget is about one user's page load.
    ...(heavyRepoId
      ? repoReadScenarios(heavyRepoId, '-heavy', HEAVY_RUN, dateRange)
      : []),
    ...(heavyRepoId && heavySessionId
      ? sessionReadScenarios(heavyRepoId, heavySessionId, '-heavy', HEAVY_RUN)
      : []),
    ...(repoId ? repoReadScenarios(repoId, '', {}, dateRange) : []),
    ...(repoId && sessionId
      ? sessionReadScenarios(repoId, sessionId, '', {})
      : []),
    ...(repoId && sessionId
      ? [
          {
            name: 'repos:session-favorite',
            writes: true,
            description:
              'POST /api/v1/repositories/:repoId/sessions/:sid/favorite — toggle',
            fn: (() => {
              let fav = true;
              return async (auth: unknown) => {
                const authClient = auth as AuthClient;
                const res = await authClient.fetchJson(
                  `/api/v1/repositories/${repoId}/sessions/${sessionId}/favorite`,
                  'POST',
                  { favorite: fav },
                );
                fav = !fav;
                return { ok: res.ok };
              };
            })(),
          },
          {
            name: 'otel:session-snapshot',
            writes: true,
            description:
              'GET /api/v1/repositories/:repoId/sessions/:sid/otel — session OTEL snapshot (seeded once with 50 realtime calls)',
            fn: (() => {
              let seeded = false;
              return async (auth: unknown) => {
                const authClient = auth as AuthClient;
                if (!seeded) {
                  seeded = true;
                  await fetch(`${BASE}/api/v2/otel-realtime`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...authClient.apiKeyHeader,
                    },
                    body: makeOtelRealtimeBody(String(sessionId), 50, 1),
                  });
                }
                const res = await authClient.fetch(
                  `/api/v1/repositories/${repoId}/sessions/${sessionId}/otel`,
                );
                return { ok: res.ok };
              };
            })(),
          },
          {
            name: 'otel:session-empty-delta',
            description:
              'GET /api/v1/repositories/:repoId/sessions/:sid/otel?since=<cursor> — empty-delta fast path',
            fn: (() => {
              let cursor: string | null = null;
              return async (auth: unknown) => {
                const authClient = auth as AuthClient;
                const path = `/api/v1/repositories/${repoId}/sessions/${sessionId}/otel`;
                if (cursor === null) {
                  const first = await authClient.fetch(path);
                  if (!first.ok) return { ok: false };
                  cursor = ((await first.json()) as { cursor: string }).cursor;
                }
                const res = await authClient.fetch(
                  `${path}?since=${encodeURIComponent(cursor)}`,
                );
                return { ok: res.ok };
              };
            })(),
          },
        ]
      : []),
    {
      name: 'api-keys:list',
      description: 'GET /api/v1/api-keys',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/api-keys');
        return { ok: res.ok };
      },
    },
    {
      name: 'teams:list',
      description: 'GET /api/v1/teams',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/teams');
        return { ok: res.ok };
      },
    },
    {
      name: 'teams:create-delete',
      writes: true,
      description: 'POST /api/v1/teams + DELETE — full lifecycle',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const name = `perf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const createRes = await authClient.fetchJson('/api/v1/teams', 'POST', {
          name,
        });
        if (!createRes.ok) return { ok: false };
        const team = (await createRes.json()) as Record<string, string>;
        const deleteRes = await authClient.fetch(`/api/v1/teams/${team.id}`, {
          method: 'DELETE',
        });
        return { ok: deleteRes.ok };
      },
    },
    {
      name: 'invitations:list',
      description: 'GET /api/v1/invitations',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/invitations');
        return { ok: res.ok };
      },
    },
    {
      name: 'api-keys:create-delete',
      writes: true,
      description: 'POST /api/v1/api-keys + DELETE — full lifecycle',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const name = `perf-tmp-${randomUUID()}`;
        const createRes = await authClient.fetchJson(
          '/api/v1/api-keys',
          'POST',
          {
            name,
          },
        );
        if (!createRes.ok) return { ok: false };
        const created = (await createRes.json()) as Record<string, unknown>;
        const id = created.id as string | number;
        const deleteRes = await authClient.fetch(`/api/v1/api-keys/${id}`, {
          method: 'DELETE',
        });
        return { ok: deleteRes.ok };
      },
    },
    {
      name: 'model-pricing',
      description: 'GET /api/v1/model-pricing',
      fn: async (auth) => {
        const authClient = auth as AuthClient;
        const res = await authClient.fetch('/api/v1/model-pricing');
        return { ok: res.ok };
      },
    },
    {
      name: 'health',
      description: 'GET /health — DB connectivity check',
      fn: async (_auth) => {
        const res = await fetch(`${BASE}/health`);
        return { ok: res.ok };
      },
    },
  ];

  // Read-only target mode (PERF_READONLY=1 / PERF_REPO_ID): every scenario that sends a mutating
  // request is dropped, announced like the auth-mode skip below — a target the harness does not
  // own is only ever read.
  const runnable = config.readOnly ? all.filter((s) => !s.writes) : all;
  if (config.readOnly) {
    const skippedWrites = all.filter((s) => s.writes).map((s) => s.name);
    if (skippedWrites.length > 0) {
      console.log(`  Skipping ${skippedWrites.join(', ')} — read-only mode`);
    }
  }

  if (authMode === 'none') {
    const skipped = runnable
      .filter((s) => PASSWORD_ONLY_SCENARIOS.has(s.name))
      .map((s) => s.name);
    if (skipped.length > 0) {
      // Announced, never silent: a scenario missing from the report has to be visible in the
      // run log, or the next reader assumes the suite covered it.
      console.log(
        `  Skipping ${skipped.join(', ')} — AUTH_MODE=none has no password login endpoint`,
      );
    }
    return runnable.filter((s) => !PASSWORD_ONLY_SCENARIOS.has(s.name));
  }

  return runnable;
}
