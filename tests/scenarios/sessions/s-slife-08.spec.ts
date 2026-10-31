// S-SLIFE-08. Retention: an old session disappears with its whole tree; young, empty and already
// soft-deleted sessions are left alone (docs/qaa-overview/scenarios/02-repos-sessions.md
// §S-SLIFE-08; no mode in the design → A and C, DD SC4).
//
// How the stand is set up for it (impl-plan DD C4, C5):
//   - `SESSION_RETENTION_DAYS` is not set, so the window is the default 30 days;
//   - the retention scheduler ticks every 50 ms (`SESSION_RETENTION_CHECK_INTERVAL_MS`, DD C4);
//   - "old" is made with `shiftSessionTree` (DD C5), which moves every timestamp of a session tree
//     — `logs.created_at`, the age retention reads, included — 31/29/40 days back.
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). OLD2's stuck chunked upload is a real
// chunk 0 of 3 (`uploadId`/`chunkIndex`/`totalChunks`), which leaves a `partially_uploaded` queue
// row and a staged chunk file. Its tree is shifted with `upload_queue` excluded: an aged
// `partially_uploaded` row is expired by the partial-upload sweep on its own, and the step is
// about retention removing it.
//
// State with no public read is taken from the stand schema (`db`): EMPTY is a `sessions` row
// without logs (the API never creates one — DD 1), the `deleted_session_log` audit rows (there is
// no admin API for them), and SOFT's bare soft-deleted row. A soft-deleted sub-agent of OLD covers
// the design's «no audit row for an already soft-deleted descendant»; it is deleted by its owner —
// a bare sub-agent session has no artisyn log, so its owner is resolved from its other logs
// (deleting is owner-only since 2026-10-21-private-repo-visibility).
//
// The design's step 6 (two concurrent purges) cannot be driven through the stand; what is
// observable is that later ticks add no second audit row (`session_pk` is the claim).
//
// OTEL steps (2026-10-30 OTEL tabs, DD-25): OLD also carries an OTEL chunk (projected into the
// OTEL fact tables), which goes with its root; two OTEL-only roots — sessions that only ever got
// realtime batches, so they have no `logs` row and age by `otel_session_state.created_at` — one
// 31 days old (purged) and one 29 days old (kept); and a realtime batch for the soft-deleted SOFT
// is answered `ignored: 'deleted'` and writes nothing.
//
// Code facts that differ from the design text:
//   - `GET /api/v1/sessions/retention-days` answers `{ retentionDays: 30 }`, not `{ days: 30 }`.
//
// Replaces:
//   - server/test/session-retention.e2e-spec.ts (10)
//   - server/src/sessions/session-retention.service.spec.ts (11; per-tick env reading and the batch
//     size stay unit-level details, design «Что теряем»)
import { randomBytes, randomUUID } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { insertRow } from '../helpers/db-seed';
import { ownRepoId, uploadPromptSession, uploadSubagent, type PromptSession } from '../helpers/prompt-session';
import { skipNewUserNudge } from '../helpers/teams';
import { shiftSessionTree } from '../helpers/time-shift';
import { apiRequestLine, callLines, otelTurn, spanLines } from '../fixtures/otel/otel-lines';
import { otelRowCounts, sendRealtime, uploadOtelChunk, waitForOtelProjected } from '../helpers/otel';

const OTEL_TABLES = ['otel_session_state', 'otel_calls', 'otel_spans', 'otel_cost_buckets', 'otel_reclass_queue', 'logs_otel'];

const TICKS_MS = 600;

interface AuditRow {
  session_id: string;
  deleted_by_user_id: number | null;
}

test('@S-SLIFE-08 retention removes an old session tree and leaves young, empty and soft-deleted ones @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/slife08`;
  const owner = await users.user('user', { label: 'sl08-owner' });
  const admin = await users.user('admin', { label: 'sl08-admin' });
  const session = (name: string): PromptSession => ({ sessionId: `sl08-${run}-${name}`, prompt: `${name} ${run}`, repoUrl });
  const OLD = session('old');
  const OLD2 = session('old2');
  const YOUNG = session('young');
  const SOFT = session('soft');
  const EMPTY = `sl08-${run}-empty`;
  const child = `agent-sl08-${run}-child`;
  const grandchild = `agent-sl08-${run}-grandchild`;
  const softChild = `agent-sl08-${run}-softchild`;
  const queue = { db, userId: owner.id };

  const sessionRow = async (sid: string) =>
    (await db.query<{ id: number; deleted: boolean }>('SELECT id, deleted FROM sessions WHERE session_id = $1', [sid])).rows[0];
  const audit = async (sid: string) =>
    (
      await db.query<AuditRow>(
        'SELECT session_id, deleted_by_user_id FROM deleted_session_log WHERE session_id = $1 ORDER BY id',
        [sid],
      )
    ).rows;
  const OTEL_OLD = `sl08-${run}-otel-old`;
  const OTEL_YOUNG = `sl08-${run}-otel-young`;
  /** Rows of every OTEL table for a `sessions.id` (the row itself may be gone already). */
  const otelRowsById = async (id: number) => {
    let n = 0;
    for (const table of OTEL_TABLES) {
      n += Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE session_id = $1`, [id])).rows[0].n);
    }
    return n;
  };
  let oldOtel = { id: 0, otelOldId: 0 };
  const queueRows = async (sid: string) =>
    (await db.query<{ status: string }>('SELECT status FROM upload_queue WHERE session_id = $1', [sid])).rows.map((r) => r.status);

  const { repoId, uploadId } = await test.step('setup: OLD (root + child + grandchild + an owner-deleted child), OLD2 with a stuck chunked upload, YOUNG, SOFT (owner-deleted), EMPTY', async () => {
    const key = await createApiKey(owner.api);
    for (const s of [OLD, OLD2, YOUNG, SOFT]) await uploadPromptSession(api, key.key, s, queue);
    await uploadSubagent(api, key.key, { sessionId: child, parentSessionId: OLD.sessionId, prompt: `child ${run}` }, queue);
    await uploadSubagent(api, key.key, { sessionId: grandchild, parentSessionId: child, prompt: `grandchild ${run}` }, queue);
    await uploadSubagent(api, key.key, { sessionId: softChild, parentSessionId: OLD.sessionId, prompt: `soft child ${run}` }, queue);
    expect((await owner.api.delete(`/api/v1/sessions/${softChild}`)).status()).toBe(204);
    expect((await owner.api.delete(`/api/v1/sessions/${SOFT.sessionId}`)).status()).toBe(204);

    const uploadId = randomUUID();
    const chunk = await api.post('/api/v2/logs', {
      params: { sessionId: OLD2.sessionId, type: 'claude', uploadId, chunkIndex: '0', totalChunks: '3', totalSize: '300' },
      headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
      data: `${JSON.stringify({ type: 'user', uuid: `${uploadId}-0`, sessionId: OLD2.sessionId, message: { role: 'user', content: 'part' } })}\n`,
    });
    expect(chunk.status()).toBe(201);
    expect(await chunk.json()).toMatchObject({ complete: false });
    expect(await queueRows(OLD2.sessionId)).toContain('partially_uploaded');

    await insertRow(db, 'sessions', { session_id: EMPTY });

    // OTEL: OLD's chunk (logs and spans) projected into the fact tables; two OTEL-only roots.
    const turn = otelTurn(`o${run}`, new Date(Date.now() - 2 * 60 * 60 * 1000));
    await uploadOtelChunk(api, key.key, OLD.sessionId, [...callLines(OLD.sessionId, turn), ...spanLines(OLD.sessionId, turn)], queue);
    await waitForOtelProjected(db, OLD.sessionId);
    for (const sid of [OTEL_OLD, OTEL_YOUNG]) {
      const res = await sendRealtime(api, key.key, {
        sessionId: sid,
        receiverId: `rcv-${run}`,
        batchSeq: 1,
        lines: [apiRequestLine(sid, { requestId: `${sid}-req`, querySource: 'repl_main_thread', model: 'claude-scn-model-a', at: new Date(), costUsd: 0.01, input: 10, output: 1 })],
      });
      expect(res.accepted).toEqual({ calls: 1, spans: 0 });
    }
    expect(await otelRowCounts(db, OLD.sessionId)).toMatchObject({ otel_session_state: 1, otel_calls: 5, otel_spans: 6, logs_otel: 1 });
    oldOtel = { id: (await sessionRow(OLD.sessionId)).id, otelOldId: (await sessionRow(OTEL_OLD)).id };
    return { repoId: await ownRepoId(owner.api, repoUrl), uploadId };
  });

  await test.step('1b. realtime to the soft-deleted SOFT: 200 ignored «deleted», no OTEL row written', async () => {
    const key = await createApiKey(owner.api);
    const res = await sendRealtime(api, key.key, {
      sessionId: SOFT.sessionId,
      receiverId: `rcv-soft-${run}`,
      batchSeq: 1,
      lines: [apiRequestLine(SOFT.sessionId, { requestId: `soft-${run}-req`, querySource: 'repl_main_thread', model: 'claude-scn-model-a', at: new Date(), costUsd: 0.01, input: 10, output: 1 })],
    });
    expect(res).toMatchObject({ ignored: 'deleted', accepted: { calls: 0, spans: 0 } });
    expect(await otelRowsById((await sessionRow(SOFT.sessionId)).id)).toBe(0);
  });

  const base = `/api/v1/repositories/${repoId}`;
  const listed = async () =>
    ((await (await owner.api.get(`${base}/sessions`)).json()) as Array<{ sessionId: string }>).map((r) => r.sessionId).sort();
  const sessionCount = async () => ((await (await owner.api.get(`${base}/summary`)).json()) as { sessionCount: number }).sessionCount;
  const logsStatus = async (sid: string) => (await owner.api.get(`${base}/sessions/${encodeURIComponent(sid)}/logs`)).status();

  await test.step('1. GET /sessions/retention-days: a regular user gets 30; no cookie → 401', async () => {
    const res = await owner.api.get('/api/v1/sessions/retention-days');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: 30 });
    expect((await api.get('/api/v1/sessions/retention-days')).status()).toBe(401);
  });

  await test.step('2. before: OLD, OLD2 and YOUNG listed (SOFT is not), sessionCount 3', async () => {
    expect(await listed()).toEqual([OLD, OLD2, YOUNG].map((s) => s.sessionId).sort());
    expect(await sessionCount()).toBe(3);
  });

  await test.step('3. age the data: OLD and OLD2 31 days, YOUNG 29 days, SOFT 40 days (shiftSessionTree)', async () => {
    await shiftSessionTree(db, YOUNG.sessionId, 29);
    await shiftSessionTree(db, SOFT.sessionId, 40);
    await shiftSessionTree(db, OLD2.sessionId, 31, { excludeTables: ['upload_queue'] });
    const shifted = await shiftSessionTree(db, OLD.sessionId, 31);
    expect(shifted.sessionIds.sort()).toEqual([OLD.sessionId, child, grandchild, softChild].sort());
    expect(shifted.tables.find((t) => t.table === 'logs_otel')).toMatchObject({ rows: 1 });
    expect(shifted.tables.find((t) => t.table === 'logs_otel')?.columns).toContain('created_at');
    const otelOnly = await shiftSessionTree(db, OTEL_OLD, 31);
    expect(otelOnly.tables.find((t) => t.table === 'otel_session_state')).toMatchObject({ rows: 1 });
    expect(otelOnly.tables.find((t) => t.table === 'otel_session_state')?.columns).toContain('created_at');
    await shiftSessionTree(db, OTEL_YOUNG, 29);
  });

  await test.step('4. the scheduler purges OLD with its whole tree and OLD2 with its queue row; YOUNG, EMPTY and SOFT stay', async () => {
    await expect.poll(async () => (await sessionRow(OLD.sessionId)) ?? null, { timeout: 15_000 }).toBeNull();
    await expect.poll(async () => (await sessionRow(OLD2.sessionId)) ?? null, { timeout: 15_000 }).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, TICKS_MS));
    for (const sid of [child, grandchild, softChild]) expect(await sessionRow(sid), sid).toBeUndefined();
    for (const sid of [OLD.sessionId, OLD2.sessionId, child, grandchild]) expect(await logsStatus(sid), sid).toBe(404);
    expect(await listed()).toEqual([YOUNG.sessionId]);
    expect(await queueRows(OLD2.sessionId)).toEqual([]);

    const admins = await admin.api.get('/api/v1/admin/upload-queue');
    expect(admins.status()).toBe(200);
    const items = (await admins.json()) as Array<{ sessionId: string; uploadId: string | null }>;
    expect(items.filter((i) => i.sessionId === OLD2.sessionId || i.uploadId === uploadId)).toEqual([]);

    expect(await sessionRow(YOUNG.sessionId)).toMatchObject({ deleted: false });
    expect(await logsStatus(YOUNG.sessionId)).toBe(200);
    expect(await sessionRow(EMPTY)).toMatchObject({ deleted: false });
    expect(await sessionRow(SOFT.sessionId)).toMatchObject({ deleted: true });
  });

  await test.step('4b. OTEL: OLD’s OTEL rows went with it; the 31-day-old OTEL-only root is purged with its rows; the 29-day-old one stays', async () => {
    expect(await otelRowsById(oldOtel.id)).toBe(0);
    await expect.poll(async () => (await sessionRow(OTEL_OLD)) ?? null, { timeout: 15_000 }).toBeNull();
    expect(await otelRowsById(oldOtel.otelOldId)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, TICKS_MS));
    expect(await sessionRow(OTEL_YOUNG)).toMatchObject({ deleted: false });
    expect(await otelRowCounts(db, OTEL_YOUNG)).toMatchObject({ otel_session_state: 1, otel_calls: 1 });
  });

  await test.step('5. audit: one automatic row (deleted_by null) per active session of OLD’s tree; none added for the owner-deleted child or SOFT', async () => {
    for (const sid of [OLD.sessionId, child, grandchild, OLD2.sessionId]) {
      expect(await audit(sid), sid).toEqual([{ session_id: sid, deleted_by_user_id: null }]);
    }
    expect(await audit(softChild)).toEqual([{ session_id: softChild, deleted_by_user_id: owner.id }]);
    expect(await audit(SOFT.sessionId)).toEqual([{ session_id: SOFT.sessionId, deleted_by_user_id: owner.id }]);
  });

  await test.step('6. later ticks change nothing: still one audit row per session, YOUNG and EMPTY still there', async () => {
    await new Promise((resolve) => setTimeout(resolve, TICKS_MS));
    for (const sid of [OLD.sessionId, child, grandchild, OLD2.sessionId]) expect(await audit(sid), sid).toHaveLength(1);
    expect(await sessionRow(YOUNG.sessionId)).toMatchObject({ deleted: false });
    expect(await sessionRow(EMPTY)).toMatchObject({ deleted: false });
  });

  await test.step('7. UI (OWNER): repo A lists YOUNG only and the header says «Sessions: 1»', async () => {
    expect(await sessionCount()).toBe(1);
    await skipNewUserNudge(page.context());
    await owner.signIn(page);
    await page.goto(`/#/repos/${repoId}`);
    await expect(page.getByTestId('session-item').filter({ hasText: YOUNG.prompt })).toBeVisible();
    for (const s of [OLD, OLD2, SOFT]) await expect(page.getByTestId('session-item').filter({ hasText: s.prompt })).toHaveCount(0);
    await expect(page.getByText('Sessions: 1', { exact: false })).toBeVisible();
  });
});
