// S-INGEST-01. Life of an API key on the ingest routes: created, works, expires, revoked
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INGEST-01; layer API, no
// mode in the design → A and C, DD SC4).
//
// Only v2 (impl-plan DD SC3): every design step on `POST /api/v1/logs` → 201 runs on
// `POST /api/v2/logs` → 201 `{warnings}` and waits for the queue. The removed v1 route gets a step
// of its own: it answers 404 with and without a key.
//
// Code facts that differ from the design text:
//   - the second key gets its expiry at creation (`expires_at` = now + 3 s) instead of a PATCH;
//     the key cache re-checks the expiry on every hit (`api-keys.service.ts` validateApiKey), so
//     the same key flips to 401 without any invalidation;
//   - every 401 carries the same body `{statusCode: 401, message: 'Unauthorized'}`, so «why» cannot
//     be told apart — checked by comparing the bodies of all four refusals.
//
// Replaces:
//   - server/test/logs.e2e-spec.ts block «log auth guard» (3)
//   - server/test/upload-queue.e2e-spec.ts (v2 without a key → 401: 3)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { logRowCount, ndjson, postLogs, sessionRowCount } from '../helpers/ingest';
import { waitForQueueIdle } from '../helpers/queue';

test('@S-INGEST-01 API key life on the ingest routes: created, works, expires, revoked; v1 is gone @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/keys`;
  const owner = await users.user('admin', { label: 'ing01-owner' });
  const other = await users.user('user', { label: 'ing01-other' });
  const sid = (n: number) => `sess-key-${run}-${n}`;
  const body = (n: number) =>
    ndjson([
      {
        event: 'prompt_start',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        session_id: sid(n),
        prompt: `key prompt ${run} #${n}`,
        git: { repo: repoUrl, branch: 'main' },
      },
    ]);
  const upload = (key: string | null, n: number) => postLogs(api, key, { sessionId: sid(n), type: 'artisyn' }, body(n));
  const echo = (key: string | null) =>
    api.post('/api/v1/log-echo', { headers: key ? { 'X-API-Key': key } : {} });
  const refusals: Array<{ what: string; body: string }> = [];
  const refused = async (what: string, res: Awaited<ReturnType<typeof upload>>) => {
    expect(res.status(), what).toBe(401);
    refusals.push({ what, body: await res.text() });
  };
  const ownerLogRows = async () =>
    Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM logs WHERE user_id = $1', [owner.id])).rows[0].n);

  await test.step('1. No X-API-Key: v2 upload and log-echo → 401', async () => {
    await refused('v2 without key', await upload(null, 1));
    expect((await echo(null)).status()).toBe(401);
  });

  await test.step('2. X-API-Key «abc» (shorter than 6) and a wrong key → 401, no logs row', async () => {
    await refused('short key', await upload('abc', 1));
    await refused('wrong key', await upload('zzzzzz-wrong-key', 1));
    expect(await logRowCount(db, sid(1))).toBe(0);
    expect(await ownerLogRows()).toBe(0);
  });

  const key1 = await test.step('3. POST /api/v1/api-keys → 201 with the plaintext once; GET /api-keys never shows it', async () => {
    const res = await owner.api.post('/api/v1/api-keys', { data: { name: `ing01-ok-${run}` } });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { id: number; key: string };
    expect(created.key.length).toBeGreaterThan(10);
    const listText = await (await owner.api.get('/api/v1/api-keys')).text();
    expect(listText).not.toContain(created.key);
    expect(JSON.parse(listText) as Array<{ id: number }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
    return created;
  });

  await test.step('4. POST /api/v1/log-echo with the key → 200 «OK» (what the installer calls on upgrade)', async () => {
    const res = await echo(key1.key);
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  await test.step('5. v2 upload with the key → 201 {warnings: []}; one logs row, one session, the repo belongs to the key owner', async () => {
    const res = await upload(key1.key, 1);
    expect(res.status()).toBe(201);
    expect(await res.json()).toEqual({ warnings: [] });
    await waitForQueueIdle(db, owner.id);
    expect(await logRowCount(db, sid(1))).toBe(1);
    expect(await sessionRowCount(db, sid(1))).toBe(1);
    const { rows } = await db.query<{ user_id: number }>('SELECT user_id FROM repositories WHERE repo_url = $1', [
      repoUrl,
    ]);
    expect(rows.map((r) => r.user_id)).toEqual([owner.id]);
  });

  await test.step('5a. (DD SC3) the removed POST /api/v1/logs answers 404 — with and without a key — and stores nothing', async () => {
    const variants: Array<Record<string, string>> = [{}, { 'X-API-Key': key1.key }];
    for (const headers of variants) {
      const res = await api.post('/api/v1/logs', {
        params: { sessionId: sid(9), type: 'artisyn' },
        headers: { 'Content-Type': 'application/x-ndjson', ...headers },
        data: body(9),
      });
      expect(res.status()).toBe(404);
    }
    expect(await sessionRowCount(db, sid(9))).toBe(0);
  });

  await test.step('6. A second key expiring in 3 s works, then → 401 once expired; the first key keeps working', async () => {
    const expiresAt = new Date(Date.now() + 3_000);
    const key2 = await createApiKey(owner.api, { name: `ing01-short-${run}`, expiresAt: expiresAt.toISOString() });
    expect((await upload(key2.key, 2)).status()).toBe(201);
    await waitForQueueIdle(db, owner.id);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 500));
    await refused('expired key', await upload(key2.key, 3));
    expect((await echo(key2.key)).status()).toBe(401);
    expect((await upload(key1.key, 4)).status()).toBe(201);
    await waitForQueueIdle(db, owner.id);
    expect(await logRowCount(db, sid(3))).toBe(0);
    expect(await logRowCount(db, sid(4))).toBe(1);
  });

  await test.step('7. DELETE the first key → 204; v2 upload and log-echo with it → 401; other keys untouched', async () => {
    const spare = await createApiKey(owner.api, { name: `ing01-spare-${run}` });
    const before = await ownerLogRows();
    expect((await owner.api.delete(`/api/v1/api-keys/${key1.id}`)).status()).toBe(204);
    await refused('revoked key', await upload(key1.key, 5));
    expect((await echo(key1.key)).status()).toBe(401);
    expect(await ownerLogRows()).toBe(before);
    const names = ((await (await owner.api.get('/api/v1/api-keys')).json()) as Array<{ name: string }>).map((k) => k.name);
    expect(names).toContain(`ing01-spare-${run}`);
    expect(names).not.toContain(`ing01-ok-${run}`);
    expect((await echo(spare.key)).status()).toBe(200);
  });

  await test.step('8. A live key on the session routes (GET /api/v1/repositories) → 401: a key only writes logs', async () => {
    const live = await createApiKey(other.api, { name: `ing01-live-${run}` });
    const before = await ownerLogRows();
    for (const path of ['/api/v1/repositories', '/api/v1/api-keys']) {
      expect((await api.get(path, { headers: { 'X-API-Key': live.key } })).status(), path).toBe(401);
    }
    expect(await ownerLogRows()).toBe(before);
  });

  await test.step('All refusals look the same: one 401 body for «no key», «wrong», «expired», «revoked»', async () => {
    const bodies = new Set(refusals.map((r) => r.body));
    expect(refusals.map((r) => r.what)).toEqual([
      'v2 without key',
      'short key',
      'wrong key',
      'expired key',
      'revoked key',
    ]);
    expect([...bodies]).toHaveLength(1);
    expect(JSON.parse([...bodies][0]) as unknown).toMatchObject({ statusCode: 401 });
  });
});
