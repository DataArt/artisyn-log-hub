// S-SLIFE-07. Deleting a root session removes its sub-agents and grandchildren, their data and its
// session tags (docs/qaa-overview/scenarios/02-repos-sessions.md §S-SLIFE-07; no mode in the
// design → A and C, DD SC4). Tags come from OTEL resource attributes (2026-11-24
// otel-session-tags): R's OTEL chunk carries `feature` + `shared`, X's carries `shared`.
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). Sub-agents are uploaded the way the
// hook does (`type=claude-subagent` with `parentSessionId`); the grandchild G hangs under C1.
//
// The expected tree cost is computed here from the DD D3 sonnet-4-6 rates (input $3, output $15
// per Mtok): the root's prompt session is 10 in / 5 out, each `uploadSubagent` transcript
// 400 in / 200 out.
//
// What the design leaves to internal state is read from the stand schema (`db`): no `logs` rows
// for any of the four sessions, R's `session_tags` rows gone while X's stay, and the
// favourite row of R removed (the design's «user_favorite_sessions для R снесены»).
//
// Tombstones (2026-11-23-session-logs-streaming, DD-27/28/29), steps 1b, 3b, 5b, 5c and 7–9:
//   - before the delete R also owns rows in the survivor tables (an OTEL chunk projected into the
//     OTEL facts, a Turn-End Advisor run, a `tool-calls` log); the delete purges all of them;
//   - after the delete every late write for the tree — a sub-agent never seen before, an OTEL
//     chunk, a realtime OTEL batch, a `tool-calls` log and an advisor run — is answered as usual
//     and writes nothing;
//   - a live child of the deleted root seeded straight into `sessions` (an upload that raced the
//     delete before the tombstone check existed) is soft-deleted by the cleanup drain, which the
//     stand ticks every second (`DELETED_SESSION_CLEANUP_INTERVAL_MS`, modes.ts);
//   - fresh start: after the owner's account deletion, an admin repository removal and a team
//     repository removal, the deleted session id is accepted again.
//
// Replaces:
//   - server/test/session-delete.e2e-spec.ts («child sessions soft-deleted», «grandchild (2 levels
//     deep)», «orphan contexts removed», «204 owner … data is purged»: 4)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
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
import { insertRow } from '../helpers/db-seed';
import { logRowCount, sessionRowCount } from '../helpers/ingest';
import { sendRealtime, uploadOtelChunk, waitForOtelProjected } from '../helpers/otel';
import { addTeamRepo, createTeam, removeTeamRepo } from '../helpers/teams';
import { buildToolCallsLog, uploadToolCallsLog } from '../helpers/tool-monitoring';
import { apiRequestLine, callLines, otelTurn, spanLines, withResource } from '../fixtures/otel/otel-lines';

/**
 * The tables `purgeSessionChildData` empties for a deleted session (DD-28 survivors, plus `logs`
 * and the OTEL facts), all keyed by `sessions.id`. `turn_end_advisor_runs` is keyed by the
 * session id string and counted separately.
 */
const SURVIVOR_TABLES = [
  'logs',
  'logs_otel',
  'otel_session_state',
  'otel_calls',
  'otel_spans',
  'otel_cost_buckets',
  'otel_api_calls',
  'session_request_ids',
  'session_tool_stats',
  'session_harness_usage',
  'session_changed_paths',
  'session_cause_stats',
  'session_attribution',
  'session_attribution_runs',
  'session_prompt_watermark',
  // 2026-11-24 otel-session-tags: the root's tags.
  'session_tags',
];

const ROOT_COST = (10 * 3 + 5 * 15) / 1e6;
const AGENT_COST = (400 * 3 + 200 * 15) / 1e6;

test('@S-SLIFE-07 deleting a root removes sub-agents, grandchildren, their data and its tags @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(240_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/slife07`;
  const owner = await users.user('user', { label: 'sl07-owner' });
  const sharedCtx = `ctx-shared-${run}`;
  const onlyRCtx = `ctx-only-R-${run}`;
  const R: PromptSession = { sessionId: `sl07-${run}-r`, prompt: `root R ${run}`, repoUrl };
  const X: PromptSession = { sessionId: `sl07-${run}-x`, prompt: `other X ${run}`, repoUrl };
  const C1 = `agent-sl07-${run}-c1`;
  const C2 = `agent-sl07-${run}-c2`;
  const G = `agent-sl07-${run}-g`;
  const tree = [R.sessionId, C1, C2, G];
  const queue = { db, userId: owner.id };

  const { key, repoId } = await test.step('setup: R with C1, C2 and G under C1; X beside it', async () => {
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
  const tagRows = async (value: string) =>
    Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM session_tags WHERE value = $1', [value])).rows[0].n);
  /** Rows per survivor table (only the non-zero ones) held by the tree's sessions. */
  const survivorRows = async (sessionIds: readonly string[]): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of SURVIVOR_TABLES) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ANY($1::text[])`,
        [sessionIds],
      );
      if (Number(rows[0].n) > 0) out[table] = Number(rows[0].n);
    }
    const advisor = await db.query<{ n: string }>('SELECT count(*) AS n FROM turn_end_advisor_runs WHERE session_id = ANY($1::text[])', [
      sessionIds,
    ]);
    if (Number(advisor.rows[0].n) > 0) out.turn_end_advisor_runs = Number(advisor.rows[0].n);
    return out;
  };
  const advisorRun = (apiKey: string, sessionId: string) => {
    const now = new Date().toISOString();
    return api.post('/api/v2/turn-end-cost-advisor', {
      headers: { 'X-API-Key': apiKey },
      data: { sessionId, startedAt: now, finishedAt: now, outcome: 'failed' },
    });
  };
  const toolCallsBody = (callId: string) =>
    buildToolCallsLog([{ callId, sessionId: R.sessionId, tool: 'ce', args: ['list'], startedAt: new Date(), exitCode: 0, stdout: `out ${callId}` }]);
  const otelLines = (tag: string, sessionId: string = R.sessionId) => {
    const turn = otelTurn(`${tag}${run}`, new Date(Date.now() - 60 * 60 * 1000));
    return [...callLines(sessionId, turn), ...spanLines(sessionId, turn)];
  };

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
    const fav = await owner.api.post(`${base}/sessions/${R.sessionId}/favorite`, { data: { favorite: true } });
    expect(fav.ok(), `favorite ${fav.status()}`).toBe(true);
  });

  await test.step('1b. R also owns survivor rows: a projected OTEL chunk (with tags), a Turn-End Advisor run, a `tool-calls` log', async () => {
    await uploadOtelChunk(api, key.key, R.sessionId, withResource(otelLines('before'), { shared: sharedCtx, feature: onlyRCtx }), queue);
    await waitForOtelProjected(db, R.sessionId);
    await uploadOtelChunk(api, key.key, X.sessionId, withResource(otelLines('x', X.sessionId), { shared: sharedCtx }), queue);
    await waitForOtelProjected(db, X.sessionId);
    expect((await repoContexts()).sort()).toEqual([onlyRCtx, sharedCtx].sort());
    expect(await tagRows(onlyRCtx)).toBe(1);
    expect(await tagRows(sharedCtx)).toBe(2);
    expect((await advisorRun(key.key, R.sessionId)).status()).toBe(200);
    await uploadToolCallsLog(api, key.key, R.sessionId, toolCallsBody('c-before'), queue);
    expect(await survivorRows(tree)).toMatchObject({
      logs_otel: 1,
      otel_session_state: 1,
      otel_calls: expect.any(Number),
      turn_end_advisor_runs: 1,
    });
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

  await test.step('3b. DD-28: the delete purged every survivor row of the tree (OTEL facts and chunks, advisor runs, tool-calls, …)', async () => {
    expect(await survivorRows(tree)).toEqual({});
  });

  await test.step('4. tags: R’s rows are gone from session_tags and the repository’s tag reads; X keeps its shared tag', async () => {
    const values = await repoContexts();
    expect(values).toContain(sharedCtx);
    expect(values).not.toContain(onlyRCtx);
    expect(await tagRows(onlyRCtx)).toBe(0);
    expect(await tagRows(sharedCtx)).toBe(1);
    const discovery = (await (await owner.api.get(`${base}/session-tags/values`)).json()) as {
      tags: Record<string, Array<{ value: string; sessionCount: number }>>;
    };
    expect(discovery.tags).toEqual({ shared: [{ value: sharedCtx, sessionCount: 1 }] });
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

  const late = `agent-sl07-${run}-late`;

  await test.step('5b. DD-27: late writes for the deleted tree — a never-seen sub-agent, an OTEL chunk, a realtime batch, `tool-calls`, an advisor run — succeed and write nothing', async () => {
    const sub = await api.post('/api/v2/logs', {
      params: { sessionId: late, type: 'claude-subagent', parentSessionId: R.sessionId, uploadFeedback: '1' },
      headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
      data: `${JSON.stringify({ type: 'user', uuid: `${late}-u1`, sessionId: late, isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'user', content: 'late' } })}\n`,
    });
    expect(sub.status()).toBe(201);
    expect(await sub.json(), 'the hook is told the session is deleted').toMatchObject({ complete: true, sessionDeleted: true });

    await uploadOtelChunk(api, key.key, R.sessionId, otelLines('after'), queue);
    const realtime = await sendRealtime(api, key.key, {
      sessionId: R.sessionId,
      receiverId: `rcv-sl07-${run}`,
      batchSeq: 1,
      lines: [apiRequestLine(R.sessionId, { requestId: `sl07-${run}-rt`, querySource: 'repl_main_thread', model: 'claude-scn-model-a', at: new Date(), costUsd: 0.01, input: 10, output: 1 })],
    });
    expect(realtime).toMatchObject({ ignored: 'deleted', accepted: { calls: 0, spans: 0 } });
    await uploadToolCallsLog(api, key.key, R.sessionId, toolCallsBody('c-after'), queue);
    expect((await advisorRun(key.key, R.sessionId)).status()).toBe(200);
    await waitForQueueIdle(db, owner.id);

    expect(await sessionRowCount(db, late), 'no row for the late sub-agent').toBe(0);
    expect(await survivorRows([...tree, late])).toEqual({});
    expect(await listed()).toEqual([X.sessionId]);
  });

  await test.step('5c. DD-28: a live child of the deleted root (seeded, as an upload that raced the delete would leave it) is soft-deleted by the cleanup drain', async () => {
    const seeded = `agent-sl07-${run}-seeded`;
    await insertRow(db, 'sessions', { session_id: seeded, parent_session_id: R.sessionId });
    await expect
      .poll(
        async () =>
          (await db.query<{ deleted: boolean }>('SELECT deleted FROM sessions WHERE session_id = $1', [seeded])).rows[0]?.deleted,
        { message: 'cleanup drain marks the orphan deleted', timeout: 20_000 },
      )
      .toBe(true);
    const audit = await db.query<{ deleted_by_user_id: number | null }>(
      'SELECT deleted_by_user_id FROM deleted_session_log WHERE session_id = $1',
      [seeded],
    );
    expect(audit.rows).toEqual([{ deleted_by_user_id: null }]);
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

  /**
   * One fresh-start case (DD-29): `uploader` uploads S into its own repository, deletes it, a
   * re-upload is ignored; after `clear` the same id uploaded by `reuploader` is stored again.
   */
  const freshStart = async (
    name: string,
    uploader: ScenarioUser,
    clear: (s: PromptSession, repoId: number) => Promise<void>,
    reuploader: ScenarioUser = uploader,
  ) => {
    const s: PromptSession = { sessionId: `sl07-${run}-${name}`, prompt: `${name} ${run}`, repoUrl: `https://git.arrakis.test/scn/${run}/slife07-${name}` };
    const upKey = await createApiKey(uploader.api);
    await uploadPromptSession(api, upKey.key, s, { db, userId: uploader.id });
    const repoId = await ownRepoId(uploader.api, s.repoUrl);
    expect((await uploader.api.delete(`/api/v1/sessions/${s.sessionId}`)).status()).toBe(204);
    await uploadPromptSession(api, upKey.key, s, { db, userId: uploader.id });
    expect(await logRowCount(db, s.sessionId), `${name}: a re-upload of the deleted session is ignored`).toBe(0);

    await clear(s, repoId);

    const reKey = reuploader === uploader ? upKey : await createApiKey(reuploader.api);
    await uploadPromptSession(api, reKey.key, s, { db, userId: reuploader.id });
    expect(await logRowCount(db, s.sessionId), `${name}: the same id is accepted again`).toBe(2);
    const row = await db.query<{ deleted: boolean }>('SELECT deleted FROM sessions WHERE session_id = $1', [s.sessionId]);
    expect(row.rows).toEqual([{ deleted: false }]);
    const again = await reuploader.api.get(`/api/v1/repositories/${await ownRepoId(reuploader.api, s.repoUrl)}/sessions`);
    expect(((await again.json()) as Array<{ sessionId: string }>).map((r) => r.sessionId)).toContain(s.sessionId);
  };

  await test.step('7. DD-29 fresh start: after the owner deletes their account, the same session id is accepted again (another user)', async () => {
    const leaver = await users.user('user', { label: 'sl07-leaver' });
    await freshStart(
      'account',
      leaver,
      async () => {
        expect((await leaver.api.post('/api/v1/auth/delete-account', { data: { confirm: 'delete' } })).status()).toBeLessThan(300);
      },
      owner,
    );
  });

  await test.step('8. DD-29 fresh start: after an admin removes the repository, the same session id is accepted again', async () => {
    const admin = await users.user('admin', { label: 'sl07-admin' });
    await freshStart('admin-repo', owner, async (_s, repoId) => {
      const res = await admin.api.delete(`/api/v1/admin/repos/${repoId}`);
      expect(res.status(), 'admin removes the repository').toBeLessThan(300);
    });
  });

  await test.step('9. DD-29 fresh start: after the team owner removes the repository from the team, the same session id is accepted again', async () => {
    await freshStart('team-repo', owner, async (s) => {
      const teamId = await createTeam(owner, `SL07-${run}`);
      const linkId = await addTeamRepo(owner, teamId, s.repoUrl);
      await removeTeamRepo(owner, teamId, linkId);
    });
  });
});
