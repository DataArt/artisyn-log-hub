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
  const { repoId, sessionId } = seedData;

  const now = new Date();
  const startDate = new Date(
    now.getTime() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const endDate = now.toISOString();

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
    ...(repoId
      ? [
          {
            name: 'repos:sessions',
            description: 'GET /api/v1/repositories/:id/sessions',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/sessions`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:summary',
            description: 'GET /api/v1/repositories/:id/summary',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/summary`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:get',
            description: 'GET /api/v1/repositories/:repoId — single repo fetch',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:branches',
            description: 'GET /api/v1/repositories/:repoId/sessions/branches',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/sessions/branches`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:contexts',
            description: 'GET /api/v1/repositories/:repoId/contexts',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/contexts`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:analytics-timeline',
            description:
              'GET /api/v1/repositories/:repoId/analytics/timeline — 90-day range',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/analytics/timeline?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:analytics-work-time',
            description:
              'GET /api/v1/repositories/:repoId/analytics/work-time — 90-day range',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/analytics/work-time?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:hook-state',
            description: 'GET /api/v1/repositories/:repoId/hook-state',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/hook-state`,
              );
              return { ok: res.ok };
            },
          },
        ]
      : []),
    ...(repoId && sessionId
      ? [
          {
            name: 'repos:session-favorite',
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
            name: 'repos:session-logs',
            description: 'GET /api/v1/repositories/:repoId/sessions/:sid/logs',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/sessions/${sessionId}/logs`,
              );
              return { ok: res.ok };
            },
          },
          {
            name: 'repos:session-contexts',
            description:
              'GET /api/v1/repositories/:repoId/sessions/:sid/contexts',
            fn: async (auth: unknown) => {
              const authClient = auth as AuthClient;
              const res = await authClient.fetch(
                `/api/v1/repositories/${repoId}/sessions/${sessionId}/contexts`,
              );
              return { ok: res.ok };
            },
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

  if (authMode === 'none') {
    const skipped = all
      .filter((s) => PASSWORD_ONLY_SCENARIOS.has(s.name))
      .map((s) => s.name);
    if (skipped.length > 0) {
      // Announced, never silent: a scenario missing from the report has to be visible in the
      // run log, or the next reader assumes the suite covered it.
      console.log(
        `  Skipping ${skipped.join(', ')} — AUTH_MODE=none has no password login endpoint`,
      );
    }
    return all.filter((s) => !PASSWORD_ONLY_SCENARIOS.has(s.name));
  }

  return all;
}
