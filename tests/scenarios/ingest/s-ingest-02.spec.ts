// S-INGEST-02. First upload of a session: repository, branch, user, context, re-uploads without
// duplicates (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INGEST-02; layer
// UI+API, no mode in the design → A and C, DD SC4).
//
// Only v2 (impl-plan DD SC3): the design's `POST /api/v1/logs` → 201 with an empty body is
// `POST /api/v2/logs` → 201 `{warnings: []}` followed by `waitForQueueIdle`.
//
// Code facts that differ from the design text:
//   - the artisyn log alone creates the repository, the session row and its repository link, but
//     the session list (`GET …/sessions`) only lists sessions that also have a `claude` log; the
//     design's step-5 claude upload therefore runs right after step 1 (1a), and step 5 re-sends it
//     to show it does not overwrite the artisyn-derived branch and times. The other sessions of
//     the scenario (late repo, user B) get a claude log too;
//   - the session list row shows the end time, cost, first prompt and branch, not a duration; the
//     4-minute span is read from the session pane's Info tab (Timeline → Duration), which also
//     shows the repository, branch and user;
//   - the hook `context` of `prompt_start` is no longer projected (2026-11-24 otel-session-tags:
//     session tags come from OTEL resource attributes); an old hook that still sends it is
//     ingested without error, the line is stored verbatim and no `session_tags` row appears
//     (AC-11, step 8);
//   - a whitespace-only `git.repo` is dropped after normalisation (`logs.service.ts`), a numeric
//     one before it (`extractRepoUrls`).
//
// Steps 12–16 (2026-11-23 session-logs-streaming) cover the ingest hash skip
// (algorithm doc ingest-hash-skip.md), the newer-upload-wins guard, coalescing of a burst
// (`superseded` measurements), the re-extract drain on new artisyn edit records and the
// workflows backfill / gzip drains converging legacy rows.
//
// Steps 17–23 (2026-11-24-traffic-optimization) cover append uploads (`POST /api/v2/logs/append`,
// algorithm doc ingest-append.md): full + deltas equal one full upload, the row fields a delta
// leaves, the next full upload, a stale delta, ordering of append rows, a gzipped delta and two
// concurrent deltas with the same startLine.
//
// Replaces:
//   - server/test/logs.e2e-spec.ts block «artisyn log extraction» (17)
//   - server/src/logs/artisyn-extractor.spec.ts (repository, branch and time extraction: ≈ 8)
import { createHash, randomBytes } from 'crypto';
import { gunzipSync } from 'zlib';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  holdSessionTreeLock,
  measurementOutcomes,
  ndjson,
  postLogs,
  postLogsAppend,
  processedSizes,
  queueRowCount,
  sessionRowCount,
  storedBody,
} from '../helpers/ingest';
import { ownRepoId } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { infoValue, openSession } from '../helpers/session-view';
import type { Pool } from 'pg';

const DAY_MS = 24 * 60 * 60 * 1000;

interface SessionRow {
  sessionId: string;
  gitBranch?: string;
  userEmail?: string;
  firstPrompt: string | null;
}

async function countRows(db: Pool, sql: string, params: unknown[]): Promise<number> {
  return Number((await db.query<{ n: string }>(sql, params)).rows[0].n);
}

/** `session_tags` rows of the session with string id `$1` (tags live on the root row). */
const sessionTagCountSql = `SELECT count(*) AS n FROM session_tags st JOIN sessions s ON s.id = st.session_id
                             WHERE s.session_id = $1`;

test('@S-INGEST-02 first v2 upload: repository, branch, user, context; re-uploads add no duplicates @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(300_000);
  const run = randomBytes(4).toString('hex');
  const host = 'git.arrakis.test';
  const sshUrl = `git@${host}:scn/${run}/shop.git`;
  const httpsUrl = `https://${host}/scn/${run}/shop.git`;
  const canonical = `https://${host}/scn/${run}/shop`;
  const owner = await users.user('user', { label: 'ing02-owner' });
  const userB = await users.user('user', { label: 'ing02-b' });
  const key = await createApiKey(owner.api);
  const keyB = await createApiKey(userB.api);
  const queueA = () => waitForQueueIdle(db, owner.id);

  // Yesterday 10:00:00Z → 10:04:00Z, so default "last 30 days" ranges include the session.
  const day = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const at = (hms: string) => `${day}T${hms}Z`;
  const sidX = `sess-x-${run}`;
  const sidLate = `sess-late-${run}`;
  const sidJunk = `sess-junk-${run}`;
  const prompt = `Add the cart page ${run}`;

  const artisynX = (repo: string) =>
    ndjson([
      {
        event: 'prompt_start',
        timestamp: at('10:00:00'),
        session_id: sidX,
        prompt,
        git: { repo, branch: 'feature/cart', user: 'Jane Dev' },
        context: { project: 'shop', lab: 'team-a', count: 3, tags: ['a', 'b'] },
      },
      { event: 'prompt_stop', timestamp: at('10:04:00'), session_id: sidX },
    ]);
  const claudeX = ndjson([
    {
      type: 'user',
      uuid: `${sidX}-u1`,
      sessionId: sidX,
      timestamp: at('10:00:00'),
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    },
    {
      type: 'assistant',
      uuid: `${sidX}-a1`,
      parentUuid: `${sidX}-u1`,
      sessionId: sidX,
      timestamp: at('10:04:00'),
      message: {
        id: `msg-${run}`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 120, output_tokens: 40 },
        content: [{ type: 'text', text: `Cart page added ${run}.` }],
      },
    },
  ]);
  const claudeFor = (sessionId: string, text: string, hms: string) =>
    ndjson([
      {
        type: 'user',
        uuid: `${sessionId}-u1`,
        sessionId,
        timestamp: at(hms),
        message: { role: 'user', content: [{ type: 'text', text }] },
      },
    ]);
  const send = async (k: string, sessionId: string, type: string, body: string) => {
    const res = await postLogs(api, k, { sessionId, type }, body);
    expect(res.status(), `${type} ${sessionId}`).toBe(201);
    expect(await res.json()).toEqual({ warnings: [] });
  };
  const ownerRepos = () => countRows(db, 'SELECT count(*) AS n FROM repositories WHERE user_id = $1', [owner.id]);
  const artisynLog = async () =>
    (
      await db.query<{ id: number; created_at: Date; updated_at: Date }>(
        `SELECT l.id, l.created_at, l.updated_at FROM logs l JOIN sessions s ON s.id = l.session_id
          WHERE s.session_id = $1 AND l.log_type = 'artisyn'`,
        [sidX],
      )
    ).rows;
  const linksOf = (logId: number) => countRows(db, 'SELECT count(*) AS n FROM log_repositories WHERE log_id = $1', [logId]);

  const repoId = await test.step('1. v2 upload of the artisyn log (ssh remote) → 201 {warnings: []}; the repository exists, the list waits for the claude log', async () => {
    await send(key.key, sidX, 'artisyn', artisynX(sshUrl));
    await queueA();
    expect(await ownerRepos()).toBe(1);
    const id = await ownRepoId(owner.api, canonical);
    expect(await (await owner.api.get(`/api/v1/repositories/${id}/sessions`)).json()).toEqual([]);
    return id;
  });
  const base = `/api/v1/repositories/${repoId}`;

  await test.step('1a. v2 upload of the claude transcript (the design’s step-5 upload, moved up) → 201', async () => {
    await send(key.key, sidX, 'claude', claudeX);
    await queueA();
  });

  const firstLog = await test.step('2. API: one repository (ssh normalised to https), one session of the key owner on feature/cart', async () => {
    const repos = (await (await owner.api.get('/api/v1/repositories')).json()) as Array<{ repoUrl: string }>;
    expect(repos.map((r) => r.repoUrl)).toEqual([canonical]);
    const sessions = (await (await owner.api.get(`${base}/sessions`)).json()) as SessionRow[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: sidX, gitBranch: 'feature/cart', userEmail: owner.email, firstPrompt: prompt });
    const branches = (await (await owner.api.get(`${base}/sessions/branches`)).json()) as Array<{ branch: string | null }>;
    expect(branches.map((b) => b.branch)).toEqual(['feature/cart']);
    const rows = await artisynLog();
    expect(rows).toHaveLength(1);
    expect(await linksOf(rows[0].id)).toBe(1);
    expect(await sessionRowCount(db, sidX)).toBe(1);
    return rows[0];
  });

  await test.step('3. UI: the repository lists the session with its branch and first prompt', async () => {
    await openSession(page, owner, repoId, sidX);
    const item = page.getByTestId('session-item').filter({ hasText: prompt });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toContainText('feature/cart');
  });

  await test.step('4. The same log with the https URL → still one repository, one link, one session; created_at kept, updated_at grows', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await send(key.key, sidX, 'artisyn', artisynX(httpsUrl));
    await queueA();
    expect(await ownerRepos()).toBe(1);
    const rows = await artisynLog();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstLog.id);
    expect(rows[0].created_at.getTime()).toBe(firstLog.created_at.getTime());
    expect(rows[0].updated_at.getTime()).toBeGreaterThan(firstLog.updated_at.getTime());
    expect(await linksOf(rows[0].id)).toBe(1);
    expect(await sessionRowCount(db, sidX)).toBe(1);
  });

  await test.step('5. type=claude again → the session logs carry the messages; branch and time from artisyn stay; UI Info: repo, branch, user, 4 min', async () => {
    await send(key.key, sidX, 'claude', claudeX);
    await queueA();
    const logsRes = await owner.api.get(`${base}/sessions/${sidX}/logs`);
    expect(logsRes.status()).toBe(200);
    const logsText = await logsRes.text();
    expect(logsText).toContain(`Cart page added ${run}.`);
    expect(logsText).toContain(prompt);
    const sessions = (await (await owner.api.get(`${base}/sessions`)).json()) as Array<SessionRow & { startTime: string; endTime: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ gitBranch: 'feature/cart', startTime: at('10:00:00').replace('Z', '.000Z'), endTime: at('10:04:00').replace('Z', '.000Z') });

    await openSession(page, owner, repoId, sidX, { tab: 'info' });
    await expect(infoValue(page, 'Repository')).toHaveText(canonical);
    await expect(infoValue(page, 'Branch')).toHaveText('feature/cart');
    await expect(infoValue(page, 'User')).toHaveText(owner.email);
    await expect(infoValue(page, 'Duration')).toHaveText('0:04:00');
  });

  await test.step('6. A second session: no git.repo in the first upload, the repo only in later lines → linked after the second upload', async () => {
    const early = {
      event: 'prompt_start',
      timestamp: at('11:00:00'),
      session_id: sidLate,
      prompt: `Late repo ${run}`,
    };
    const late = { event: 'prompt_start', timestamp: at('11:02:00'), session_id: sidLate, prompt: `Late repo again ${run}`, git: { repo: httpsUrl, branch: 'main' } };
    await send(key.key, sidLate, 'claude', claudeFor(sidLate, `Late repo ${run}`, '11:00:00'));
    await send(key.key, sidLate, 'artisyn', ndjson([early]));
    await queueA();
    let ids = ((await (await owner.api.get(`${base}/sessions`)).json()) as SessionRow[]).map((s) => s.sessionId);
    expect(ids).not.toContain(sidLate);
    await send(key.key, sidLate, 'artisyn', ndjson([early, late]));
    await queueA();
    ids = ((await (await owner.api.get(`${base}/sessions`)).json()) as SessionRow[]).map((s) => s.sessionId);
    expect(ids.sort()).toEqual([sidLate, sidX].sort());
    expect(await ownerRepos()).toBe(1);
  });

  await test.step('7. Junk: git.repo «   » and 42, context {"": "x"} and "str" → 201, no new repository, no tag', async () => {
    const junk = [
      { event: 'prompt_start', timestamp: at('12:00:00'), session_id: sidJunk, prompt: `junk ${run}`, git: { repo: '   ', branch: 'main' }, context: { '': 'x' } },
      { event: 'prompt_start', timestamp: at('12:01:00'), session_id: sidJunk, prompt: `junk 2 ${run}`, git: { repo: 42 }, context: 'str' },
    ];
    await send(key.key, sidJunk, 'artisyn', ndjson(junk));
    await queueA();
    expect(await ownerRepos()).toBe(1);
    expect(await countRows(db, sessionTagCountSql, [sidJunk])).toBe(0);
    expect(await sessionRowCount(db, sidJunk)).toBe(1);
  });

  await test.step('8. Old hook (AC-11): the `context` of prompt_start is stored verbatim, ingests without error and projects no tag', async () => {
    // Session tags come from OTEL resource attributes only (2026-11-24 otel-session-tags); an
    // old hook still sends `prompt_start.context` — the line is kept as sent and ignored.
    const body = (await storedBody(db, sidX, 'artisyn')) as Array<{ event?: string; context?: unknown }>;
    expect(body.find((l) => l.event === 'prompt_start')?.context).toEqual({ project: 'shop', lab: 'team-a', count: 3, tags: ['a', 'b'] });
    expect(await countRows(db, sessionTagCountSql, [sidX])).toBe(0);
    expect(await countRows(db, 'SELECT count(*) AS n FROM upload_queue WHERE session_id = $1 AND status = $2', [sidX, 'failed'])).toBe(0);
    expect((await owner.api.get(`${base}/contexts`)).status()).toBe(200);
    expect(await (await owner.api.get(`${base}/contexts`)).json()).toEqual([]);
    const row = ((await (await owner.api.get(`${base}/sessions`)).json()) as Array<SessionRow & { tags?: unknown[] }>).find(
      (s) => s.sessionId === sidX,
    );
    expect(row?.tags).toEqual([]);
    expect(await (await owner.api.get(`${base}/session-tags/values`)).json()).toEqual({ tags: {}, noisyKeys: [] });
  });

  await test.step('9. User B uploads the same repository URL with its own key → B gets its own repository; A is untouched', async () => {
    const sidB = `sess-b-${run}`;
    await send(keyB.key, sidB, 'claude', claudeFor(sidB, `B prompt ${run}`, '13:00:00'));
    await send(keyB.key, sidB, 'artisyn', ndjson([
      { event: 'prompt_start', timestamp: at('13:00:00'), session_id: sidB, prompt: `B prompt ${run}`, git: { repo: httpsUrl, branch: 'main' } },
    ]));
    await waitForQueueIdle(db, userB.id);
    const repoB = await ownRepoId(userB.api, canonical);
    expect(repoB).not.toBe(repoId);
    const sessionsB = (await (await userB.api.get(`/api/v1/repositories/${repoB}/sessions`)).json()) as SessionRow[];
    expect(sessionsB.map((s) => s.sessionId)).toEqual([sidB]);
    const sessionsA = (await (await owner.api.get(`${base}/sessions`)).json()) as SessionRow[];
    expect(sessionsA.map((s) => s.sessionId).sort()).toEqual([sidLate, sidX].sort());
    expect(await ownerRepos()).toBe(1);
  });

  await test.step('10. Harness snapshot: the same snapshotId from two owners stores two isolated rows (each session reads its own body); a later ref to a different id never moves an already-bound session (COALESCE)', async () => {
    const SNAP_SHARED = 'b7cd7696dff2d64be4ad428f8f3dde1cc104ac5ad42a33284561258b9aa963c9';
    const SNAP_OTHER = 'f4a647d9a2a0ae48b469cab6fd8491f7bc70d9de14e3d988b654cf0813c51971';
    const sidSnapA = `sess-snap-a-${run}`;
    const sidSnapB = `sess-snap-b-${run}`;

    const refLine = (snapshotId: string) => ({ type: 'harness-snapshot-ref', snapshotId });
    const snapshotLine = (snapshotId: string, skillName: string) => ({
      type: 'harness-snapshot',
      snapshotId,
      schemaVersion: 1,
      perToolDetailSupported: true,
      skills: [
        {
          name: skillName,
          kind: 'skill',
          source: 'project',
          description: 'A test skill',
          body: '',
          path: `.claude/skills/${skillName}/SKILL.md`,
          bytes: 10,
          contentHash: skillName.padEnd(64, '0'),
        },
      ],
      agents: [],
      mcpServers: [],
      systemContext: null,
    });
    const snapArtisyn = (sessionId: string, skillName: string) =>
      ndjson([
        {
          event: 'prompt_start',
          timestamp: at('14:00:00'),
          session_id: sessionId,
          prompt: `Snapshot test ${run}`,
          git: { repo: httpsUrl, branch: 'main' },
        },
        refLine(SNAP_SHARED),
        snapshotLine(SNAP_SHARED, skillName),
      ]);
    const boundIdOf = async (sessionId: string) =>
      (
        await db.query<{ harness_snapshot_id: string | null }>(
          'SELECT harness_snapshot_id FROM sessions WHERE session_id = $1',
          [sessionId],
        )
      ).rows[0]?.harness_snapshot_id;

    const resA = await postLogs(
      api,
      key.key,
      { sessionId: sidSnapA, type: 'artisyn', snapshotId: SNAP_SHARED, snapshotFull: '1' },
      snapArtisyn(sidSnapA, 'owner-only-skill'),
    );
    expect(resA.status()).toBe(201);
    await queueA();

    const resB = await postLogs(
      api,
      keyB.key,
      { sessionId: sidSnapB, type: 'artisyn', snapshotId: SNAP_SHARED, snapshotFull: '1' },
      snapArtisyn(sidSnapB, 'userb-only-skill'),
    );
    expect(resB.status()).toBe(201);
    await waitForQueueIdle(db, userB.id);

    // GET …/sessions/:sessionId/logs 404s without a `claude` log (Step 2's `if (!claudeLog)`
    // guard) — give each session one so `harnessSnapshot` is reachable.
    await send(key.key, sidSnapA, 'claude', claudeFor(sidSnapA, `Snapshot test ${run}`, '14:00:00'));
    await queueA();
    await send(keyB.key, sidSnapB, 'claude', claudeFor(sidSnapB, `Snapshot test ${run}`, '14:01:00'));
    await waitForQueueIdle(db, userB.id);

    expect(
      await countRows(db, 'SELECT count(*) AS n FROM harness_snapshots WHERE snapshot_id = $1', [SNAP_SHARED]),
      'one harness_snapshots row per owner, same snapshotId',
    ).toBe(2);
    expect(await boundIdOf(sidSnapA)).toBe(SNAP_SHARED);
    expect(await boundIdOf(sidSnapB)).toBe(SNAP_SHARED);

    const repoBId = await ownRepoId(userB.api, canonical);
    const logsA = (await (await owner.api.get(`${base}/sessions/${sidSnapA}/logs`)).json()) as {
      harnessSnapshot?: { skills: Array<{ name: string }> } | null;
    };
    const logsB = (await (await userB.api.get(`/api/v1/repositories/${repoBId}/sessions/${sidSnapB}/logs`)).json()) as {
      harnessSnapshot?: { skills: Array<{ name: string }> } | null;
    };
    expect(logsA.harnessSnapshot?.skills.map((s) => s.name), 'owner reads its own body').toEqual(['owner-only-skill']);
    expect(logsB.harnessSnapshot?.skills.map((s) => s.name), 'user B reads its own body').toEqual(['userb-only-skill']);

    const resRef = await postLogs(
      api,
      key.key,
      { sessionId: sidSnapA, type: 'artisyn', snapshotId: SNAP_OTHER },
      ndjson([refLine(SNAP_OTHER)]),
    );
    expect(resRef.status()).toBe(201);
    expect((await resRef.json()).unknownSnapshotId, 'SNAP_OTHER was never stored or queued').toBe(SNAP_OTHER);
    await queueA();
    expect(
      await boundIdOf(sidSnapA),
      'COALESCE: an already-bound session never moves to a later ref',
    ).toBe(SNAP_SHARED);
  });

  await test.step('11. otel-status (hook 2.30.0): the latest event by timestamp is stored, an older upload never moves it back, an unknown state/reason is stored as «unknown», and the artisyn end_time ignores the event', async () => {
    const sidOtel = `sess-otel-status-${run}`;
    const statusLine = (hms: string, state: string, reason: string | null, logs: number) => ({
      type: 'otel-status',
      timestamp: at(hms),
      sessionId: sidOtel,
      state,
      reason,
      detail: null,
      received: { logs, metrics: 0, spans: 0, firstAt: logs > 0 ? at('15:01:00') : null },
      claudeVersion: '2.1.300',
      forward: 'off',
      hookVersion: '2.30.0',
      receiverVersion: '2.30.0',
    });
    const stored = async () =>
      (
        await db.query<{
          otel_state: string | null;
          otel_reason: string | null;
          ts: string | null;
          logs: string | null;
          end_time: Date | null;
        }>(
          `SELECT ss.otel_state, ss.otel_reason, ss.otel_status ->> 'timestamp' AS ts,
                  ss.otel_status -> 'received' ->> 'logs' AS logs, l.end_time
             FROM sessions s
             LEFT JOIN session_stats ss ON ss.session_id = s.id
             LEFT JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
            WHERE s.session_id = $1`,
          [sidOtel],
        )
      ).rows[0];
    const endTime = new Date(at('15:04:00')).toISOString();

    // The hook appends the event to the session's artisyn log and uploads the whole log, so
    // every body below carries the activity lines (15:00 → 15:04) too.
    const activity = [
      {
        event: 'prompt_start',
        timestamp: at('15:00:00'),
        session_id: sidOtel,
        prompt: `OTEL status ${run}`,
        git: { repo: httpsUrl, branch: 'main' },
      },
      { event: 'prompt_stop', timestamp: at('15:04:00'), session_id: sidOtel },
    ];
    const first = [statusLine('15:06:00', 'none', 'not-configured', 0), statusLine('15:10:00', 'partial', 'managed-endpoint', 3)];

    // Two events in one body: the later one (15:10) wins.
    await send(key.key, sidOtel, 'artisyn', ndjson([...activity, ...first]));
    await queueA();
    let row = await stored();
    expect(row, 'the latest event of the body').toMatchObject({
      otel_state: 'partial',
      otel_reason: 'managed-endpoint',
      ts: new Date(at('15:10:00')).toISOString(),
      logs: '3',
    });
    expect(row.end_time?.toISOString(), 'end_time stays at the last activity line').toBe(endTime);

    // A late retry of an older body, whose latest event is 15:08, does not overwrite the stored
    // 15:10 one.
    await send(key.key, sidOtel, 'artisyn', ndjson([...activity, statusLine('15:08:00', 'ok', null, 9)]));
    await queueA();
    row = await stored();
    expect(row, 'an older event never moves the status back').toMatchObject({
      otel_state: 'partial',
      otel_reason: 'managed-endpoint',
      ts: new Date(at('15:10:00')).toISOString(),
    });

    // A newer event with values this server does not know is stored as «unknown».
    await send(
      key.key,
      sidOtel,
      'artisyn',
      ndjson([...activity, ...first, statusLine('15:20:00', 'weird', 'galaxy-brain', 0)]),
    );
    await queueA();
    row = await stored();
    expect(row, 'unknown state and reason → unknown').toMatchObject({
      otel_state: 'unknown',
      otel_reason: 'unknown',
      ts: new Date(at('15:20:00')).toISOString(),
    });
    expect(row.end_time?.toISOString(), 'end_time never follows an otel-status timestamp').toBe(endTime);
  });

  // Steps 12–16 (2026-11-23 session-logs-streaming, FR-5 / FR-6 / FR-8): the server hash skip,
  // the newer-upload-wins guard, coalescing of a burst, the re-extract on new edit records and
  // the convergence of legacy rows through the background drains. Own sessions, so the steps
  // above keep their numbers.
  const sidEdit = `sess-edit-${run}`;
  const writeId = `toolu_w_${run}`;
  const artisynEdit = (extra: object[] = []) =>
    ndjson([
      { event: 'prompt_start', timestamp: at('16:00:00'), session_id: sidEdit, prompt: `Edit records ${run}`, git: { repo: httpsUrl, branch: 'main' } },
      ...extra,
      { event: 'prompt_stop', timestamp: at('16:03:00'), session_id: sidEdit },
    ]);
  // A Write call (no patch in the transcript, so its lines are uncovered until the hook's
  // edit record arrives) and a Workflow call (a stored workflow run).
  const claudeEdit = (answer: string) =>
    ndjson([
      { type: 'user', uuid: `${sidEdit}-u1`, sessionId: sidEdit, timestamp: at('16:00:00'), message: { role: 'user', content: [{ type: 'text', text: `Edit records ${run}` }] } },
      {
        type: 'assistant', uuid: `${sidEdit}-a1`, parentUuid: `${sidEdit}-u1`, sessionId: sidEdit, timestamp: at('16:01:00'),
        message: {
          id: `msg-edit-${run}-1`, role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 50, output_tokens: 20 },
          content: [
            { type: 'tool_use', id: writeId, name: 'Write', input: { file_path: 'src/new.ts', content: 'a\nb\nc\nd\ne\n' } },
            { type: 'tool_use', id: `toolu_wf_${run}`, name: 'Workflow', input: { name: 'ShipIt' } },
          ],
        },
      },
      {
        type: 'user', uuid: `${sidEdit}-u2`, parentUuid: `${sidEdit}-a1`, sessionId: sidEdit, timestamp: at('16:02:00'),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: writeId, content: 'File created' }] },
      },
      {
        type: 'assistant', uuid: `${sidEdit}-a2`, parentUuid: `${sidEdit}-u2`, sessionId: sidEdit, timestamp: at('16:03:00'),
        message: { id: `msg-edit-${run}-2`, role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 60, output_tokens: 10 }, content: [{ type: 'text', text: answer }] },
      },
    ]);
  const claudeRow = async (sessionId: string) =>
    (
      await db.query<{
        id: number;
        updated_at: Date;
        body_rev: string | null;
        body_sha256: string | null;
        body_received_at: Date | null;
        stats: unknown;
      }>(
        `SELECT l.id, l.updated_at, l.body_rev::text AS body_rev, l.body_sha256, l.body_received_at, to_jsonb(ss) AS stats
           FROM logs l JOIN sessions s ON s.id = l.session_id
           LEFT JOIN session_stats ss ON ss.session_id = s.id
          WHERE s.session_id = $1 AND l.log_type = 'claude'`,
        [sessionId],
      )
    ).rows[0];
  const outcomesOf = (sessionId: string) => measurementOutcomes(db, sessionId);
  const countOf = (list: string[], outcome: string) => list.filter((o) => o === outcome).length;

  await test.step('12. An identical claude re-upload is skipped: logs.updated_at, body_rev and session_stats stay; after a forced re-process of the same body the hash is kept and the next identical upload is skipped again', async () => {
    // The artisyn log first, so the transcript is extracted against the tree's edit revision.
    await send(key.key, sidEdit, 'artisyn', artisynEdit());
    await queueA();
    const body = claudeEdit(`Done ${run}`);
    await send(key.key, sidEdit, 'claude', body);
    await queueA();
    await expect.poll(() => outcomesOf(sidEdit)).toEqual(['success', 'success']);
    const before = await claudeRow(sidEdit);
    expect(before.body_sha256, 'the processed upload stores its body hash').toMatch(/^[0-9a-f]{64}$/);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await send(key.key, sidEdit, 'claude', body);
    await queueA();
    await expect.poll(async () => countOf(await outcomesOf(sidEdit), 'skipped'), 'measured as skipped').toBe(1);
    const after = await claudeRow(sidEdit);
    expect(after.updated_at.getTime(), 'updated_at kept').toBe(before.updated_at.getTime());
    expect(after.body_rev, 'body_rev kept').toBe(before.body_rev);
    expect(after.stats, 'session_stats untouched').toEqual(before.stats);

    // A stale extraction revision forces the "process" path for the same body: the upsert
    // rewrites the same hash with a new body_received_at, and the logs_body_guard trigger keeps it.
    await db.query('UPDATE logs SET stats_edit_sha256 = NULL WHERE id = $1', [before.id]);
    await send(key.key, sidEdit, 'claude', body);
    await queueA();
    await expect.poll(async () => countOf(await outcomesOf(sidEdit), 'success'), 'the same body processed again').toBe(3);
    const reprocessed = await claudeRow(sidEdit);
    expect(reprocessed.body_sha256, 'the trigger kept the hash on the re-write').toBe(before.body_sha256);
    await send(key.key, sidEdit, 'claude', body);
    await queueA();
    await expect.poll(async () => countOf(await outcomesOf(sidEdit), 'skipped'), 'the next identical upload is skipped').toBe(2);
  });

  await test.step('13. An upload older than the stored body (body_received_at in the future) writes nothing and is measured superseded', async () => {
    const stored = await claudeRow(sidEdit);
    const bodyBefore = await storedBody(db, sidEdit, 'claude');
    await db.query("UPDATE logs SET body_received_at = now() + interval '1 hour' WHERE id = $1", [stored.id]);
    try {
      await send(key.key, sidEdit, 'claude', claudeEdit(`Older answer ${run}`));
      await queueA();
      await expect.poll(async () => countOf(await outcomesOf(sidEdit), 'superseded')).toBe(1);
      expect(await storedBody(db, sidEdit, 'claude'), 'the newer body stays').toEqual(bodyBefore);
      expect((await claudeRow(sidEdit)).body_rev, 'no body write').toBe(stored.body_rev);
    } finally {
      await db.query('UPDATE logs SET body_received_at = $2 WHERE id = $1', [stored.id, stored.body_received_at]);
    }
  });

  await test.step('14. Three quick uploads of one transcript: one processed row (the newest body) plus two superseded measurements', async () => {
    const sidBlock = `sess-block-${run}`;
    const sidBurst = `sess-burst-${run}`;
    // The queue processes one row at a time: a blocker upload whose tree lock the scenario
    // holds keeps the tick busy, so all three uploads of the burst are queued together.
    const release = await holdSessionTreeLock(db, sidBlock);
    try {
      await send(key.key, sidBlock, 'claude', claudeFor(sidBlock, `Blocker ${run}`, '17:00:00'));
      await expect
        .poll(async () => (await db.query<{ status: string }>('SELECT status FROM upload_queue WHERE session_id = $1', [sidBlock])).rows[0]?.status)
        .toBe('processing');
      for (const n of [1, 2, 3]) {
        await send(key.key, sidBurst, 'claude', claudeFor(sidBurst, `Burst ${n} ${run}`, '17:10:00'));
      }
    } finally {
      await release();
    }
    await queueA();
    await expect.poll(async () => (await outcomesOf(sidBurst)).sort()).toEqual(['success', 'superseded', 'superseded']);
    const stored = (await storedBody(db, sidBurst, 'claude')) as Array<{ message: { content: Array<{ text: string }> } }>;
    expect(stored[0].message.content[0].text, 'the newest body is stored').toBe(`Burst 3 ${run}`);
    expect(await queueRowCount(db, sidBurst), 'no queued leftovers').toBe(0);
  });

  await test.step('15. An artisyn upload adding an edit_result record re-extracts the transcript through the drain: lines_added 0 → 5', async () => {
    const linesAdded = async () =>
      (
        await db.query<{ lines_added: number }>(
          'SELECT ss.lines_added FROM session_stats ss JOIN sessions s ON s.id = ss.session_id WHERE s.session_id = $1',
          [sidEdit],
        )
      ).rows[0]?.lines_added;
    expect(await linesAdded(), 'a Write without a patch is uncovered').toBe(0);
    await send(
      key.key,
      sidEdit,
      'artisyn',
      artisynEdit([
        {
          hook_event_name: 'PostToolUse',
          timestamp: at('16:02:00'),
          session_id: sidEdit,
          tool_name: 'Write',
          tool_use_id: writeId,
          edit_result: { added: 5, removed: 0, changeKind: 'added', filePath: 'src/new.ts' },
        },
      ]),
    );
    await queueA();
    await expect.poll(linesAdded, { timeout: 30_000 }).toBe(5);
    await expect
      .poll(async () => countRows(db, 'SELECT count(*) AS n FROM session_reextract_queue q JOIN sessions s ON s.id = q.session_pk WHERE s.session_id = $1', [sidEdit]))
      .toBe(0);
  });

  await test.step('16. Legacy rows (no stored workflows, no body_rev, no gzip copy) converge: the backfill restores the workflows, the gzip drain a body_rev and a valid gzip copy', async () => {
    const stored = await db.query<{ log_id: number; session_pk: number; workflows: unknown }>(
      `SELECT l.id AS log_id, s.id AS session_pk, ss.workflows
         FROM logs l JOIN sessions s ON s.id = l.session_id JOIN session_stats ss ON ss.session_id = s.id
        WHERE s.session_id = $1 AND l.log_type = 'claude'`,
      [sidEdit],
    );
    const { log_id: logId, session_pk: sessionPk, workflows } = stored.rows[0];
    expect(workflows, 'the Workflow call is stored as one run').toHaveLength(1);
    await db.query('UPDATE session_stats SET workflows = NULL, workflows_version = NULL WHERE session_id = $1', [sessionPk]);
    await db.query('UPDATE logs SET body_gz = NULL, body_gz_rev = NULL, body_rev = NULL WHERE id = $1', [logId]);

    await expect
      .poll(
        async () =>
          (await db.query<{ v: number | null }>('SELECT workflows_version AS v FROM session_stats WHERE session_id = $1', [sessionPk])).rows[0]
            .v,
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const restored = await db.query<{ workflows: unknown }>('SELECT workflows FROM session_stats WHERE session_id = $1', [sessionPk]);
    expect(restored.rows[0].workflows, 'the same workflows').toEqual(workflows);

    const gzRow = async () =>
      (
        await db.query<{ body_rev: string | null; body_gz_rev: string | null; body_gz: Buffer | null; t: string }>(
          'SELECT body_rev::text AS body_rev, body_gz_rev::text AS body_gz_rev, body_gz, body::text AS t FROM logs WHERE id = $1',
          [logId],
        )
      ).rows[0];
    await expect
      .poll(async () => {
        const r = await gzRow();
        return r.body_rev !== null && r.body_gz_rev === r.body_rev && r.body_gz !== null;
      }, { timeout: 30_000 })
      .toBe(true);
    const r = await gzRow();
    expect(gunzipSync(r.body_gz!).toString('utf8'), 'the gzip copy is the body text').toBe(r.t);
  });

  // Steps 17–23 (2026-11-24-traffic-optimization, FR-4a/4d/5/9, algorithm doc
  // ingest-append.md): `POST /api/v2/logs/append` deltas on top of a full upload. Every session
  // below gets the same 9-line transcript, parametrised only by its session id.
  const transcript = (sessionId: string): object[] => {
    const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 10 });
    const assistant = (n: number, parent: string, hms: string, content: object[], u: object) => ({
      type: 'assistant', uuid: `${sessionId}-a${n}`, parentUuid: parent, sessionId, timestamp: at(hms),
      message: { id: `msg-${sessionId}-${n}`, role: 'assistant', model: 'claude-sonnet-4-6', usage: u, content },
    });
    const user = (n: number, parent: string | null, hms: string, content: object[]) => ({
      type: 'user', uuid: `${sessionId}-u${n}`, ...(parent ? { parentUuid: parent } : {}), sessionId, timestamp: at(hms),
      message: { role: 'user', content },
    });
    return [
      user(1, null, '18:00:00', [{ type: 'text', text: `Append transcript ${run}` }]),
      assistant(1, `${sessionId}-u1`, '18:00:10', [
        { type: 'tool_use', id: `toolu_bash_${sessionId}`, name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: `toolu_wf_${sessionId}`, name: 'Workflow', input: { name: 'ShipIt' } },
      ], usage(100, 30)),
      user(2, `${sessionId}-a1`, '18:00:20', [{ type: 'tool_result', tool_use_id: `toolu_bash_${sessionId}`, content: 'a.ts' }]),
      assistant(2, `${sessionId}-u2`, '18:00:30', [
        { type: 'tool_use', id: `toolu_w_${sessionId}`, name: 'Write', input: { file_path: 'src/a.ts', content: 'x\ny\n' } },
      ], usage(120, 40)),
      user(3, `${sessionId}-a2`, '18:00:40', [{ type: 'tool_result', tool_use_id: `toolu_w_${sessionId}`, content: 'File created' }]),
      assistant(3, `${sessionId}-u3`, '18:00:50', [{ type: 'text', text: `First answer ${run}` }], usage(130, 20)),
      user(4, `${sessionId}-a3`, '18:01:00', [{ type: 'text', text: `Second prompt ${run}` }]),
      assistant(4, `${sessionId}-u4`, '18:01:10', [
        { type: 'tool_use', id: `toolu_bash2_${sessionId}`, name: 'Bash', input: { command: 'npm test' } },
      ], usage(140, 25)),
      assistant(5, `${sessionId}-a4`, '18:01:20', [{ type: 'text', text: `Second answer ${run}` }], usage(150, 35)),
    ];
  };
  const appendOk = async (sessionId: string, startLine: number, rows: object[], gzip = false) => {
    const res = await postLogsAppend(api, { key: key.key, sessionId, type: 'claude', startLine, body: ndjson(rows), gzip });
    expect(res.status(), `append ${sessionId} @${startLine}`).toBe(201);
    expect(await res.json()).toEqual({ warnings: [] });
  };
  const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  // Everything ingest derives from the transcript, with the session's own ids replaced, so two
  // sessions with the same transcript compare equal.
  const derived = async (sessionId: string) => {
    const { rows } = await db.query<{ stats: unknown; tools: unknown; cost: unknown }>(
      `SELECT to_jsonb(ss) - 'session_id' - 'updated_at' - 'cs_computed_at' AS stats,
              (SELECT jsonb_agg(to_jsonb(t) - 'session_id' ORDER BY t.tool_name) FROM session_tool_stats t WHERE t.session_id = s.id) AS tools,
              (SELECT to_jsonb(c) - 'session_id' - 'computed_at' FROM session_costs c WHERE c.session_id = s.id) AS cost
         FROM sessions s LEFT JOIN session_stats ss ON ss.session_id = s.id
        WHERE s.session_id = $1`,
      [sessionId],
    );
    return JSON.parse(JSON.stringify(rows[0]).split(sessionId).join('<sid>')) as { stats: Record<string, unknown>; tools: unknown; cost: unknown };
  };
  const sidAp = `sess-append-${run}`;
  const sidOne = `sess-oneshot-${run}`;
  const linesAp = transcript(sidAp);

  await test.step('17. A full upload of 3 lines, then a delta of 3 more (startLine 3): the queued row carries start_line; afterwards body_sha256 is NULL, body_received_at is the row’s received_at and body_rev advanced', async () => {
    await send(key.key, sidAp, 'claude', ndjson(linesAp.slice(0, 3)));
    await queueA();
    const before = await claudeRow(sidAp);
    expect(before.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    let receivedAt: string;
    // The tree lock keeps the delta queued, so its row can be read before the worker deletes it.
    const release = await holdSessionTreeLock(db, sidAp);
    try {
      await appendOk(sidAp, 3, linesAp.slice(3, 6));
      const { rows } = await db.query<{ start_line: number | null; received_at: string }>(
        // The worker carries received_at as a JS Date, so body_received_at has millisecond precision.
        "SELECT start_line, date_trunc('milliseconds', received_at)::text AS received_at FROM upload_queue WHERE session_id = $1",
        [sidAp],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].start_line).toBe(3);
      receivedAt = rows[0].received_at;
    } finally {
      await release();
    }
    await queueA();
    expect(await storedBody(db, sidAp, 'claude'), 'stored body + delta').toEqual(linesAp.slice(0, 6));
    const after = await db.query<{ body_sha256: string | null; body_received_at: string; body_rev: string }>(
      `SELECT l.body_sha256, l.body_received_at::text AS body_received_at, l.body_rev::text AS body_rev
         FROM logs l JOIN sessions s ON s.id = l.session_id WHERE s.session_id = $1 AND l.log_type = 'claude'`,
      [sidAp],
    );
    expect(after.rows[0].body_sha256, 'a delta leaves no whole-body hash').toBeNull();
    expect(after.rows[0].body_received_at).toBe(receivedAt!);
    expect(BigInt(after.rows[0].body_rev) > BigInt(before.body_rev!), 'body_rev advanced').toBe(true);
    await expect.poll(() => outcomesOf(sidAp)).toEqual(['success', 'success']);
  });

  await test.step('18. A second delta (startLine 6): full + deltas equal one full upload of the whole transcript — body, stats, workflows, tool stats and cost', async () => {
    await appendOk(sidAp, 6, linesAp.slice(6));
    await send(key.key, sidOne, 'claude', ndjson(transcript(sidOne)));
    await queueA();
    expect(await storedBody(db, sidAp, 'claude')).toEqual(linesAp);
    const ap = await derived(sidAp);
    const one = await derived(sidOne);
    expect(one.stats.workflows, 'the Workflow call is one stored run').toHaveLength(1);
    expect(one.tools, 'tool stats are there').not.toBeNull();
    expect(one.cost, 'cost is there').not.toBeNull();
    expect(ap).toEqual(one);
  });

  await test.step('19. The next full upload after a delta is processed, not skipped (no stored hash), and stores its hash again', async () => {
    const body = ndjson(linesAp);
    await send(key.key, sidAp, 'claude', body);
    await queueA();
    await expect.poll(async () => countOf(await outcomesOf(sidAp), 'success'), 'processed').toBe(4);
    expect(countOf(await outcomesOf(sidAp), 'skipped')).toBe(0);
    expect((await claudeRow(sidAp)).body_sha256).toBe(sha256Hex(body));
    expect(await storedBody(db, sidAp, 'claude')).toEqual(linesAp);
  });

  await test.step('20. An append older than the stored body is discarded: body unchanged, measured superseded, and it is not in failedUploads', async () => {
    const stored = await claudeRow(sidAp);
    await db.query("UPDATE logs SET body_received_at = now() + interval '1 hour' WHERE id = $1", [stored.id]);
    try {
      await appendOk(sidAp, linesAp.length, [{ type: 'user', uuid: `${sidAp}-late`, sessionId: sidAp, timestamp: at('18:02:00'), message: { role: 'user', content: 'late' } }]);
      await queueA();
      await expect.poll(async () => countOf(await outcomesOf(sidAp), 'superseded')).toBe(1);
      expect(await storedBody(db, sidAp, 'claude'), 'the body stays').toEqual(linesAp);
      expect((await claudeRow(sidAp)).body_rev, 'no body write').toBe(stored.body_rev);
      const sidFb = `sess-fb-${run}`;
      const fb = await postLogs(api, key.key, { sessionId: sidFb, type: 'artisyn', uploadFeedback: 1 }, ndjson([{ event: 'prompt_start', timestamp: at('18:03:00'), session_id: sidFb, prompt: `fb ${run}` }]));
      expect(fb.status()).toBe(201);
      expect(await fb.json()).toEqual({ warnings: [], failedUploads: [] });
      await queueA();
    } finally {
      await db.query('UPDATE logs SET body_received_at = $2 WHERE id = $1', [stored.id, stored.body_received_at]);
    }
  });

  await test.step('21. A full row followed by two append rows, all queued together: never superseded, applied in order', async () => {
    const sidBlock = `sess-block2-${run}`;
    const sidOrd = `sess-order-${run}`;
    const lines = transcript(sidOrd);
    const release = await holdSessionTreeLock(db, sidBlock);
    try {
      await send(key.key, sidBlock, 'claude', claudeFor(sidBlock, `Blocker 2 ${run}`, '17:00:00'));
      await expect
        .poll(async () => (await db.query<{ status: string }>('SELECT status FROM upload_queue WHERE session_id = $1', [sidBlock])).rows[0]?.status)
        .toBe('processing');
      await send(key.key, sidOrd, 'claude', ndjson(lines.slice(0, 2)));
      await appendOk(sidOrd, 2, lines.slice(2, 5));
      await appendOk(sidOrd, 5, lines.slice(5));
      const { rows } = await db.query<{ start_line: number | null }>(
        "SELECT start_line FROM upload_queue WHERE session_id = $1 AND status = 'pending' ORDER BY id",
        [sidOrd],
      );
      expect(rows.map((r) => r.start_line)).toEqual([null, 2, 5]);
    } finally {
      await release();
    }
    await queueA();
    await expect.poll(() => outcomesOf(sidOrd)).toEqual(['success', 'success', 'success']);
    expect(await storedBody(db, sidOrd, 'claude')).toEqual(lines);
  });

  await test.step('22. A gzipped delta (Content-Encoding: gzip) is stored exactly like a plain one; its processed size is the plain delta size', async () => {
    const sidGz = `sess-append-gz-${run}`;
    const lines = transcript(sidGz);
    await send(key.key, sidGz, 'claude', ndjson(lines.slice(0, 3)));
    await queueA();
    await appendOk(sidGz, 3, lines.slice(3), true);
    await queueA();
    expect(await storedBody(db, sidGz, 'claude')).toEqual(lines);
    await expect
      .poll(() => processedSizes(db, sidGz))
      .toEqual([Buffer.byteLength(ndjson(lines.slice(0, 3))), Buffer.byteLength(ndjson(lines.slice(3)))]);
  });

  await test.step('23. Two concurrent deltas with the same startLine: one is applied, the other fails «upload-full» and is reported in failedUploads; the full re-upload leaves exactly one copy of every line', async () => {
    const sidCc = `sess-append-cc-${run}`;
    const lines = transcript(sidCc);
    await send(key.key, sidCc, 'claude', ndjson(lines.slice(0, 3)));
    await queueA();
    await Promise.all([appendOk(sidCc, 3, lines.slice(3)), appendOk(sidCc, 3, lines.slice(3))]);
    await waitForQueueIdle(db, owner.id, { allowFailed: true });
    const failed = await db.query<{ error_message: string }>(
      "SELECT error_message FROM upload_queue WHERE session_id = $1 AND status = 'failed'",
      [sidCc],
    );
    expect(failed.rows.map((r) => r.error_message)).toEqual(['upload-full']);
    expect(await storedBody(db, sidCc, 'claude'), 'the applied delta, once').toEqual(lines);
    const fb = await postLogs(api, key.key, { sessionId: sidCc, type: 'artisyn', uploadFeedback: 1 }, ndjson([{ event: 'prompt_start', timestamp: at('18:00:00'), session_id: sidCc, prompt: `cc ${run}` }]));
    expect(fb.status()).toBe(201);
    expect(((await fb.json()) as { failedUploads?: unknown }).failedUploads).toEqual([{ sessionId: sidCc, type: 'claude' }]);
    await send(key.key, sidCc, 'claude', ndjson(lines));
    await queueA();
    const stored = (await storedBody(db, sidCc, 'claude')) as Array<{ uuid: string }>;
    expect(stored).toEqual(lines);
    expect(new Set(stored.map((l) => l.uuid)).size, 'every line once').toBe(lines.length);
  });
});
