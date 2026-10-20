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
//   - `count: 3` is stored as «3» and `tags: ["a","b"]` as its JSON text «["a","b"]»
//     (`coerceContextValue`); an empty key and a non-object context are skipped;
//   - a whitespace-only `git.repo` is dropped after normalisation (`logs.service.ts`), a numeric
//     one before it (`extractRepoUrls`).
//
// Replaces:
//   - server/test/logs.e2e-spec.ts block «artisyn log extraction» (17)
//   - server/src/logs/artisyn-extractor.spec.ts (repository, branch and time extraction: ≈ 8)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ndjson, postLogs, sessionRowCount } from '../helpers/ingest';
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

test('@S-INGEST-02 first v2 upload: repository, branch, user, context; re-uploads add no duplicates @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(180_000);
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

  await test.step('7. Junk: git.repo «   » and 42, context {"": "x"} and "str" → 201, no new repository, no context', async () => {
    const contextsBefore = await countRows(db, 'SELECT count(*) AS n FROM contexts', []);
    const junk = [
      { event: 'prompt_start', timestamp: at('12:00:00'), session_id: sidJunk, prompt: `junk ${run}`, git: { repo: '   ', branch: 'main' }, context: { '': 'x' } },
      { event: 'prompt_start', timestamp: at('12:01:00'), session_id: sidJunk, prompt: `junk 2 ${run}`, git: { repo: 42 }, context: 'str' },
    ];
    await send(key.key, sidJunk, 'artisyn', ndjson(junk));
    await queueA();
    expect(await ownerRepos()).toBe(1);
    expect(await countRows(db, 'SELECT count(*) AS n FROM contexts', [])).toBe(contextsBefore);
    expect(
      await countRows(
        db,
        `SELECT count(*) AS n FROM log_contexts lc JOIN logs l ON l.id = lc.log_id JOIN sessions s ON s.id = l.session_id
          WHERE s.session_id = $1`,
        [sidJunk],
      ),
    ).toBe(0);
    expect(await sessionRowCount(db, sidJunk)).toBe(1);
  });

  await test.step('8. Context: project=shop, lab=team-a, count «3» and tags as text', async () => {
    const contexts = (await (await owner.api.get(`${base}/contexts`)).json()) as Array<{ key: string; value: string }>;
    expect(contexts).toEqual(
      expect.arrayContaining([
        { key: 'project', value: 'shop' },
        { key: 'lab', value: 'team-a' },
        { key: 'count', value: '3' },
        { key: 'tags', value: '["a","b"]' },
      ]),
    );
    expect(contexts).toHaveLength(4);
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
});
