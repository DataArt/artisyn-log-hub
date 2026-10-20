// S-SLIFE-07. Deleting a root session removes its sub-agents and grandchildren, their data and the
// contexts nobody else holds (docs/qaa-overview/scenarios/02-repos-sessions.md §S-SLIFE-07; no
// mode in the design → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). Sub-agents are uploaded the way the
// hook does (`type=claude-subagent` with `parentSessionId`); the grandchild G hangs under C1.
//
// The expected tree cost is computed here from the DD D3 sonnet-4-6 rates (input $3, output $15
// per Mtok): the root's prompt session is 10 in / 5 out, each `uploadSubagent` transcript
// 400 in / 200 out.
//
// What the design leaves to internal state is read from the stand schema (`db`): no `logs` rows
// for any of the four sessions, the orphaned context row gone while the shared one stays, and the
// favourite row of R removed (the design's «user_favorite_sessions для R снесены»).
//
// Replaces:
//   - server/test/session-delete.e2e-spec.ts («child sessions soft-deleted», «grandchild (2 levels
//     deep)», «orphan contexts removed», «204 owner … data is purged»: 4)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  ownRepoId,
  postSessionLog,
  rangeAround,
  uploadPromptSession,
  uploadSubagent,
  type PromptSession,
} from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';

const ROOT_COST = (10 * 3 + 5 * 15) / 1e6;
const AGENT_COST = (400 * 3 + 200 * 15) / 1e6;

test('@S-SLIFE-07 deleting a root removes sub-agents, grandchildren, their data and orphaned contexts @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/slife07`;
  const owner = await users.user('user', { label: 'sl07-owner' });
  const sharedCtx = `ctx-shared-${run}`;
  const onlyRCtx = `ctx-only-R-${run}`;
  const R: PromptSession = {
    sessionId: `sl07-${run}-r`,
    prompt: `root R ${run}`,
    repoUrl,
    context: { claudeMd: sharedCtx, feature: onlyRCtx },
  };
  const X: PromptSession = { sessionId: `sl07-${run}-x`, prompt: `other X ${run}`, repoUrl, context: { claudeMd: sharedCtx } };
  const C1 = `agent-sl07-${run}-c1`;
  const C2 = `agent-sl07-${run}-c2`;
  const G = `agent-sl07-${run}-g`;
  const tree = [R.sessionId, C1, C2, G];
  const queue = { db, userId: owner.id };

  const { key, repoId } = await test.step('setup: R with C1, C2 and G under C1; X shares one context of R', async () => {
    const key = await createApiKey(owner.api);
    await uploadPromptSession(api, key.key, R, queue);
    await uploadSubagent(api, key.key, { sessionId: C1, parentSessionId: R.sessionId, prompt: `c1 ${run}` }, queue);
    await uploadSubagent(api, key.key, { sessionId: C2, parentSessionId: R.sessionId, prompt: `c2 ${run}` }, queue);
    await uploadSubagent(api, key.key, { sessionId: G, parentSessionId: C1, prompt: `g ${run}` }, queue);
    await uploadPromptSession(api, key.key, X, queue);
    return { key, repoId: await ownRepoId(owner.api, repoUrl) };
  });

  const base = `/api/v1/repositories/${repoId}`;
  const logsOf = (sid: string) => owner.api.get(`${base}/sessions/${encodeURIComponent(sid)}/logs`);
  const listed = async () =>
    ((await (await owner.api.get(`${base}/sessions`)).json()) as Array<{ sessionId: string }>).map((r) => r.sessionId).sort();
  const repoContexts = async () =>
    ((await (await owner.api.get(`${base}/contexts`)).json()) as Array<{ key: string; value: string }>).map((c) => c.value);
  const sessionCount = async () => ((await (await owner.api.get(`${base}/summary`)).json()) as { sessionCount: number }).sessionCount;
  const logRowsOfTree = async () =>
    Number(
      (
        await db.query<{ n: string }>(
          'SELECT count(*) AS n FROM logs l JOIN sessions s ON s.id = l.session_id WHERE s.session_id = ANY($1::text[])',
          [tree],
        )
      ).rows[0].n,
    );
  const contextRows = async (value: string) =>
    Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM contexts WHERE context_value = $1', [value])).rows[0].n);

  await test.step('1. before: R’s logs carry subagentStats for C1, C2 and G (G under C1); the timeline cost of R is all three levels; R is a favourite', async () => {
    const res = await logsOf(R.sessionId);
    expect(res.status()).toBe(200);
    const logs = (await res.json()) as {
      subagentStats: Record<string, unknown>;
      subagents: Array<{ sessionId: string; parentSessionId: string | null }>;
    };
    expect(Object.keys(logs.subagentStats).sort()).toEqual([C1, C2, G].sort());
    expect(logs.subagents.find((s) => s.sessionId === G)?.parentSessionId).toBe(C1);
    const timeline = (await (await owner.api.get(`${base}/analytics/timeline?${rangeAround()}`)).json()) as Array<{
      sessionId: string;
      totalCost: number | null;
    }>;
    expect(timeline.map((r) => r.sessionId).sort()).toEqual([R.sessionId, X.sessionId].sort());
    expect(timeline.find((r) => r.sessionId === R.sessionId)?.totalCost).toBeCloseTo(ROOT_COST + 3 * AGENT_COST, 9);
    expect(await sessionCount()).toBe(2);
    expect(await repoContexts()).toEqual(expect.arrayContaining([sharedCtx, onlyRCtx]));
    const fav = await owner.api.post(`${base}/sessions/${R.sessionId}/favorite`, { data: { favorite: true } });
    expect(fav.ok(), `favorite ${fav.status()}`).toBe(true);
  });

  await test.step('2. DELETE /sessions/R as the owner → 204', async () => {
    expect((await owner.api.delete(`/api/v1/sessions/${R.sessionId}`)).status()).toBe(204);
  });

  await test.step('3. C1, C2, G and R → 404 and none is listed; sessionCount −1; X stays', async () => {
    for (const sid of tree) expect((await logsOf(sid)).status(), sid).toBe(404);
    expect(await listed()).toEqual([X.sessionId]);
    expect(await sessionCount()).toBe(1);
    expect((await logsOf(X.sessionId)).status()).toBe(200);
    expect(await logRowsOfTree()).toBe(0);
  });

  await test.step('4. contexts: ctx-only-R is gone (also from the contexts table), ctx-shared stays (X holds it)', async () => {
    const values = await repoContexts();
    expect(values).toContain(sharedCtx);
    expect(values).not.toContain(onlyRCtx);
    expect(await contextRows(onlyRCtx)).toBe(0);
    expect(await contextRows(sharedCtx)).toBe(1);
  });

  await test.step('5. the hook re-uploads G and C2 (with parentSessionId) → 201, ignored: still not listed, no logs rows', async () => {
    for (const [sid, parent] of [
      [G, C1],
      [C2, R.sessionId],
    ]) {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: sid, type: 'claude-subagent', parentSessionId: parent },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: `${JSON.stringify({ type: 'user', uuid: `${sid}-again`, sessionId: sid, isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'user', content: 'again' } })}\n`,
      });
      expect(res.status(), sid).toBe(201);
    }
    expect((await postSessionLog(api, R, 'artisyn', { 'X-API-Key': key.key })).status()).toBe(201);
    await waitForQueueIdle(db, owner.id);
    expect(await listed()).toEqual([X.sessionId]);
    expect(await logRowsOfTree()).toBe(0);
    for (const sid of tree) expect((await logsOf(sid)).status(), sid).toBe(404);
  });

  await test.step('6. favourites: R’s favourite row is gone and the session list still answers', async () => {
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM user_favorite_sessions f JOIN sessions s ON s.id = f.session_id WHERE s.session_id = $1',
      [R.sessionId],
    );
    expect(Number(rows[0].n)).toBe(0);
    const res = await owner.api.get(`${base}/sessions`);
    expect(res.status()).toBe(200);
  });
});
