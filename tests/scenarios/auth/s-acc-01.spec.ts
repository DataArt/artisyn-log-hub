// S-ACC-01. Someone else's personal repository is closed — to an admin too, since the admin role
// grants no data access (2026-10-21-private-repo-visibility) — and the route guards do not depend
// on the kind of credential (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-ACC-01; any
// mode → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3); the anonymous and cookie checks of the
// design's `POST /api/v1/logs` are made on /api/v2/logs (v1 answers 404, see S-INGEST-01).
//
// Code facts that differ from the design text:
//   - the security headers the server sets itself are `X-Frame-Options: DENY` and
//     `Content-Security-Policy: frame-ancestors 'none'` (main.ts); they are checked on 200, 401
//     and 404;
//   - a `userId` in the body of `PUT /user-settings/:name` is stripped by the global
//     ValidationPipe (`whitelist: true`), so the write lands on the caller's own row.
//
// Replaces:
//   - tests/e2e/raw-logs-owner-api.spec.ts (2)
//   - server/test/access-management.e2e-spec.ts («Auth guard enforcement», 2)
//   - server/test/user-settings.e2e-spec.ts (isolation and limits, ≈5 of 17)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, postSessionLog, uploadPromptSession } from '../helpers/prompt-session';

const DAY_MS = 24 * 60 * 60 * 1000;

test('@S-ACC-01 a foreign personal repo is closed; guards do not mix credentials @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(120_000);
  const runId = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${runId}/private`;
  const owner = await users.user('user', { label: 'acc-owner' });
  const stranger = await users.user('user', { label: 'acc-stranger' });
  const admin = await users.user('admin', { label: 'acc-admin' });
  const k1 = await createApiKey(owner.api);
  const strangerKey = await createApiKey(stranger.api);
  const sessions = [1, 2].map((n) => ({ sessionId: `acc-${runId}-${n}`, prompt: `private prompt ${n} ${runId}`, repoUrl }));
  for (const s of sessions) await uploadPromptSession(api, k1.key, s, { db, userId: owner.id });
  const repoId = await ownRepoId(owner.api, repoUrl);
  const base = `/api/v1/repositories/${repoId}`;
  const reads = [
    base,
    `${base}/sessions`,
    `${base}/sessions/${sessions[0].sessionId}/logs`,
    `${base}/summary`,
    `${base}/contexts`,
  ];
  const status = async (user: ScenarioUser, path: string) => (await user.api.get(path)).status();

  await test.step('1. OWNER: repository, sessions, raw logs, summary, contexts → 200', async () => {
    for (const path of reads) expect(await status(owner, path), path).toBe(200);
  });

  await test.step('2. STRANGER: the same → 403; the repository is not in STRANGER’s own list', async () => {
    for (const path of reads) expect(await status(stranger, path), path).toBe(403);
    const own = (await (await stranger.api.get('/api/v1/repositories')).json()) as Array<{ id: number }>;
    expect(own.map((r) => r.id)).not.toContain(repoId);
  });

  await test.step('3. STRANGER: settings writes, recompute and export-scope → 403', async () => {
    const config = { config: { fileCategories: [] } };
    expect((await stranger.api.put(`${base}/settings/team`, { data: config })).status()).toBe(403);
    expect((await stranger.api.put(`${base}/settings/user`, { data: config })).status()).toBe(403);
    expect((await stranger.api.post(`${base}/recompute-all-sessions`)).status()).toBe(403);
    const from = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const to = new Date(Date.now() + DAY_MS).toISOString();
    expect(await status(stranger, `${base}/sessions/export-scope?from=${from}&to=${to}`)).toBe(403);
  });

  await test.step('4. ADMIN: every read of the foreign repo, recompute and export-scope → 403, no prompt text', async () => {
    for (const path of reads) {
      const res = await admin.api.get(path);
      expect(res.status(), path).toBe(403);
      expect(await res.text(), path).not.toContain(sessions[0].prompt);
    }
    expect((await admin.api.post(`${base}/recompute-all-sessions`)).status()).toBe(403);
    const from = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const to = new Date(Date.now() + DAY_MS).toISOString();
    expect(await status(admin, `${base}/sessions/export-scope?from=${from}&to=${to}`)).toBe(403);
    const own = (await (await admin.api.get('/api/v1/repositories')).json()) as Array<{ id: number }>;
    expect(own.map((r) => r.id)).not.toContain(repoId);
  });

  await test.step('5. Anonymous: one route of every family → 401', async () => {
    for (const path of [
      '/api/v1/repositories',
      '/api/v1/teams',
      '/api/v1/api-keys',
      '/api/v1/admin/repos',
      '/api/v1/user-settings',
      '/api/v1/ai-tool-versions/claude-code',
    ]) {
      expect((await api.get(path)).status(), path).toBe(401);
    }
    expect((await postSessionLog(api, sessions[0], 'artisyn')).status()).toBe(401);
  });

  await test.step('6. A valid key on session routes → 401; a session cookie on key routes → 401', async () => {
    const key = { 'X-API-Key': k1.key };
    for (const path of ['/api/v1/repositories', '/api/v1/teams', `${base}/sessions`, '/api/v1/api-keys']) {
      expect((await api.get(path, { headers: key })).status(), path).toBe(401);
    }
    expect((await postSessionLog(owner.api, sessions[0], 'artisyn')).status()).toBe(401);
    expect((await owner.api.get('/api/v2/post-turn-analysis/config')).status()).toBe(401);
  });

  await test.step('7. user-settings: each reads their own value; a body userId is ignored; >64 KB and a bad name → 400', async () => {
    const theme = (user: ScenarioUser, value: string, extra: Record<string, unknown> = {}) =>
      user.api.put('/api/v1/user-settings/theme', { data: { value, ...extra } });
    expect((await theme(owner, 'dark')).ok()).toBe(true);
    expect((await theme(stranger, 'light', { userId: owner.id })).ok()).toBe(true);
    const read = async (user: ScenarioUser) => (await (await user.api.get('/api/v1/user-settings/theme')).json()) as { value: string };
    expect((await read(owner)).value).toBe('dark');
    expect((await read(stranger)).value).toBe('light');
    expect((await theme(owner, 'x'.repeat(65_537))).status()).toBe(400);
    expect((await owner.api.put('/api/v1/user-settings/bad%20name!', { data: { value: 'v' } })).status()).toBe(400);
  });

  await test.step('8. STRANGER’s key on OWNER’s session: attribution and advisor → 404; unknown session → applied:false; OWNER → 200', async () => {
    const now = new Date().toISOString();
    const attribution = (key: string, sessionId: string) =>
      api.post('/api/v2/session-attribution', {
        headers: { 'X-API-Key': key },
        data: { sessionId, promptWatermark: 1, startedAt: now, finishedAt: now, invokingSessionId: sessionId, outcome: 'failed', failureReason: 'scenario' },
      });
    const advisor = (key: string, sessionId: string) =>
      api.post('/api/v2/turn-end-cost-advisor', {
        headers: { 'X-API-Key': key },
        data: { sessionId, startedAt: now, finishedAt: now, outcome: 'failed' },
      });
    const target = sessions[0].sessionId;
    expect((await attribution(strangerKey.key, target)).status()).toBe(404);
    expect((await advisor(strangerKey.key, target)).status()).toBe(404);
    const unknown = await attribution(strangerKey.key, `acc-${runId}-unknown`);
    expect(unknown.status()).toBe(200);
    expect(await unknown.json()).toEqual({ applied: false });
    expect((await attribution(k1.key, target)).status()).toBe(200);
    expect((await advisor(k1.key, target)).status()).toBe(200);
  });

  await test.step('security headers are set on 200, 401 and 404 alike', async () => {
    const responses = [
      await owner.api.get(base),
      await api.get('/api/v1/repositories'),
      await owner.api.get('/api/v1/repositories/2147483647'),
    ];
    expect(responses.map((r) => r.status())).toEqual([200, 401, 404]);
    for (const res of responses) {
      expect(res.headers()['x-frame-options']).toBe('DENY');
      expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });
});
