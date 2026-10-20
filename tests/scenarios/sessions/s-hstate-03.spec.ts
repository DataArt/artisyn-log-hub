// S-HSTATE-03. Hook state does not leak to others and answers with clear errors
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-HSTATE-03, formerly S-HOOK-03; no mode in
// the design → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). The hook state of repo H comes the way
// the hook sends it: a `hook-status` line in the session's artisyn log (`logTail`, non-uploadable
// logs, recommendations). Repo Q gets an ordinary session without that line.
//
// Step 4, the open question (impl-plan DD 1 «Чужое состояние хука для участника команды»: pin the
// current behaviour, observation in the task Notes): the hook state lives on the repository row,
// and `GET /repositories/:id/hook-state` only runs `assertRepoAccess(user, repoId, teamId)`. So a
// member of a team that holds H gets H's whole hook state with `?teamId=` — the owner's `logTail`
// (paths, error text) included — in a `restricted` team too. Without `teamId` the member gets 403.
//
// Code facts that differ from the design text:
//   - the empty state reads «No hook state reported for this repository yet.»
//
// Replaces:
//   - server/test/hook-state.e2e-spec.ts (401 ×2, 404 ×2, 403, «only caller's own repos»: 6)
//   - client/src/viewer/__tests__/components/HookStatePage.test.tsx (404 and 403 states: 2)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, promptSessionBodies, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';

const NOT_REPORTED = 'No hook state reported for this repository yet.';

interface HookRepo {
  id: number;
  repoUrl: string;
}

test('@S-HSTATE-03 hook state does not leak to others and answers with clear errors @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const urlH = `https://git.arrakis.test/scn/${run}/hooked-h`;
  const urlQ = `https://git.arrakis.test/scn/${run}/quiet-q`;
  const secret = `/home/owner-${run}/private/build.sh`;
  const owner = await users.user('user', { label: 'hs03-owner' });
  const nonowner = await users.user('user', { label: 'hs03-nonowner' });
  const regular = await users.user('user', { label: 'hs03-member' });
  const H: PromptSession = { sessionId: `hs03-${run}-h`, prompt: `hooked ${run}`, repoUrl: urlH };

  const { repoH, repoQ, teamId } = await test.step('setup: H with a hook-status (logTail with a path and an error), Q without; REGULAR in a restricted team that holds H', async () => {
    const key = await createApiKey(owner.api);
    const { artisyn, claude } = promptSessionBodies(H);
    const status = {
      type: 'hook-status',
      hookVersion: '0.0.1',
      timestamp: new Date().toISOString(),
      logTail: [`[info] uploading ${secret}`, `[error] upload failed for ${secret}: timeout`],
      nonUploadableLogs: [{ file: 'big-session.jsonl', reason: 'timeout after 10000ms (size=12.0MB)' }],
      recommendations: [],
    };
    for (const [type, body] of [
      ['artisyn', `${artisyn}${JSON.stringify(status)}\n`],
      ['claude', claude],
    ] as const) {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: H.sessionId, type },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: body,
      });
      expect(res.status(), type).toBe(201);
    }
    await waitForQueueIdle(db, owner.id);
    await uploadPromptSession(api, key.key, { sessionId: `hs03-${run}-q`, prompt: `quiet ${run}`, repoUrl: urlQ }, { db, userId: owner.id });
    const teamId = await createTeam(owner, `Hooks-${run}`);
    await inviteAndAccept(owner, regular, teamId);
    await addTeamRepo(owner, teamId, urlH);
    return { repoH: await ownRepoId(owner.api, urlH), repoQ: await ownRepoId(owner.api, urlQ), teamId };
  });

  const statePath = (repoId: number, query = '') => `/api/v1/repositories/${repoId}/hook-state${query}`;
  const hookRepos = async (user: ScenarioUser) => {
    const res = await user.api.get('/api/v1/repositories/hooks');
    expect(res.status()).toBe(200);
    return ((await res.json()) as HookRepo[]).map((r) => r.id);
  };
  const expectNoLeak = async (res: { text(): Promise<string> }, what: string) => {
    const text = await res.text();
    expect(text, what).not.toContain(secret);
    expect(text, what).not.toContain('logTail');
  };

  await test.step('0. OWNER: H has its hook state (the logTail with the path is there)', async () => {
    const res = await owner.api.get(statePath(repoH));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { hookVersion: string; logTail: string[]; errors: string[] };
    expect(body.hookVersion).toBe('0.0.1');
    expect(body.logTail.join('\n')).toContain(secret);
    expect(body.errors).toHaveLength(1);
  });

  await test.step('1. no cookie: GET /repositories/hooks and GET /repositories/:H/hook-state → 401', async () => {
    for (const path of ['/api/v1/repositories/hooks', statePath(repoH)]) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(401);
      await expectNoLeak(res, path);
    }
  });

  await test.step('2. OWNER: Q → 404 «not found», an unknown id → 404; the hooks list has H, not Q', async () => {
    const q = await owner.api.get(statePath(repoQ));
    expect(q.status()).toBe(404);
    expect(await q.text()).toContain('Hook state not found for this repository');
    expect((await owner.api.get(statePath(999_999_999))).status()).toBe(404);
    const ids = await hookRepos(owner);
    expect(ids).toContain(repoH);
    expect(ids).not.toContain(repoQ);
  });

  await test.step('3. NONOWNER: H → 403 without the logTail; the hooks list holds only own repositories (not H)', async () => {
    const res = await nonowner.api.get(statePath(repoH));
    expect(res.status()).toBe(403);
    await expectNoLeak(res, 'nonowner H');
    expect(await hookRepos(nonowner)).not.toContain(repoH);
    const withTeam = await nonowner.api.get(statePath(repoH, `?teamId=${teamId}`));
    expect(withTeam.status()).toBe(403);
    await expectNoLeak(withTeam, 'nonowner H with teamId');
  });

  await test.step('4. REGULAR (member of a restricted team holding H): no teamId → 403; with teamId → 200 with the owner’s hook state (current behaviour, task Notes)', async () => {
    const bare = await regular.api.get(statePath(repoH));
    expect(bare.status()).toBe(403);
    await expectNoLeak(bare, 'member H without teamId');
    expect(await hookRepos(regular)).not.toContain(repoH);
    const scoped = await regular.api.get(statePath(repoH, `?teamId=${teamId}`));
    expect(scoped.status()).toBe(200);
    const body = (await scoped.json()) as { repoUrl: string; logTail: string[] };
    expect(body.repoUrl).toBe(urlH);
    expect(body.logTail.join('\n')).toContain(secret);
  });

  await test.step('5. UI: NONOWNER on #/repos/<H>/hook-state → «No access»; OWNER on #/repos/<Q>/hook-state → the not-reported state', async () => {
    const { context, page: other } = await browserAs(browser, stand.url, nonowner, `/#/repos/${repoH}/hook-state`);
    try {
      await expect(other.getByText('No access', { exact: true })).toBeVisible();
      await expect(other.getByText(secret)).toHaveCount(0);
    } finally {
      await context.close();
    }
    await skipNewUserNudge(page.context());
    await owner.signIn(page);
    await page.goto(`/#/repos/${repoQ}/hook-state`);
    await expect(page.getByText(NOT_REPORTED, { exact: true })).toBeVisible();
  });
});
