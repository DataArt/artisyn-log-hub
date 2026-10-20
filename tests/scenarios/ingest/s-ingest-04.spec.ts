// S-INGEST-04. A big session over v2 in chunks: chunk retry, foreign parameters, byte-exact assembly
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INGEST-04; layer API, the
// last step UI; no mode in the design → A and C, DD SC4).
//
// Data: a ~2.5 MB `claude` transcript of 6000 NDJSON lines full of Cyrillic and emoji, cut on `\n`
// into three chunks c0, c1, c2 (each below the stand's 2 MB body limit). The session also gets a
// small `artisyn` log, because the session list and its logs route only know a session through
// the artisyn log's repository link.
//
// Code facts that differ from the design text:
//   - the foreign-user step runs while A's upload is still partial: once the queue has stored the
//     session, B's request is refused earlier, as a foreign session (201 with a warning, S-SLIFE),
//     and never reaches the uploadId lookup;
//   - the reassembled `<uploadId>.raw` file lives for one 50 ms queue tick, too short to download
//     reliably; the byte check is done on the staged chunk 0 (downloaded through
//     `GET /api/v1/admin/upload-queue/:id/file` while the upload is partial, SHA-256 equal to c0)
//     and on the result: the stored lines equal the source lines and the processed size equals N;
//   - «last writer wins» on a re-upload replaces the `logs` row of (session, type) in place.
//
// Replaces:
//   - server/test/upload-queue.e2e-spec.ts blocks «chunked uploads» (5), «async staging» (3),
//     v1-unmodified (1)
//   - server/test/logs-gzip.e2e-spec.ts block «compressed chunked uploads» (2)
//   - server/src/logs/upload-queue.service.spec.ts (chunk assembly and staging: 8)
import { createHash, randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { logRowCount, ndjson, postLogs, processedSizes, sessionRowCount, storedBody } from '../helpers/ingest';
import { ownRepoId } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { openSession } from '../helpers/session-view';

const DAY_MS = 24 * 60 * 60 * 1000;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface QueueItem {
  id: number;
  sessionId: string;
  status: string;
  uploadId: string | null;
  chunksReceived: number | null;
  totalChunks: number | null;
}

/** Splits `body` on line ends into `n` parts of roughly equal byte size. */
function splitOnLines(body: Buffer, n: number): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 1; i < n; i += 1) {
    const cut = body.indexOf(0x0a, Math.floor((body.length * i) / n)) + 1;
    parts.push(body.subarray(start, cut));
    start = cut;
  }
  parts.push(body.subarray(start));
  return parts;
}

test('@S-INGEST-04 a big session over v2 in chunks: retry, foreign parameters, byte-exact assembly @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(240_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/chunks`;
  const owner = await users.user('admin', { label: 'ing04' });
  const intruder = await users.user('user', { label: 'ing04-b' });
  const key = (await createApiKey(owner.api)).key;
  const keyB = (await createApiKey(intruder.api)).key;
  const S = `sess-chunks-${run}`;
  const start = new Date(Date.now() - DAY_MS);
  const ts = (i: number) => new Date(start.getTime() + i * 100).toISOString();
  const firstPrompt = `Начало работы 🚀 ${run}`;
  const lastPrompt = `Финиш — всё готово 🎉 ${run}`;

  // 6000 lines: the first and the last are prompts (two Logs turns), the rest assistant answers.
  const lines: object[] = [];
  for (let i = 0; i < 6000; i += 1) {
    if (i === 0 || i === 5999) {
      const text = i === 0 ? firstPrompt : lastPrompt;
      lines.push({ type: 'user', uuid: `${S}-${i}`, sessionId: S, timestamp: ts(i), message: { role: 'user', content: [{ type: 'text', text }] } });
    } else {
      lines.push({
        type: 'assistant',
        uuid: `${S}-${i}`,
        parentUuid: `${S}-${i - 1}`,
        sessionId: S,
        timestamp: ts(i),
        message: {
          id: `msg-${run}-${i}`,
          role: 'assistant',
          content: [{ type: 'text', text: `Строка ${i}: привет, мир 👋🏽 — проверка многобайтных символов 🧪✨ ${'ж'.repeat(120)}` }],
        },
      });
    }
  }
  const file = Buffer.from(ndjson(lines), 'utf8');
  const N = file.length;
  const [c0, c1, c2] = splitOnLines(file, 3);
  const uploadId = `u-${run}`;
  const chunk = (k: string, params: Record<string, string | number>, body: Buffer | string) =>
    postLogs(api, k, { sessionId: S, type: 'claude', ...params }, body);
  const queueRow = async (id: string) =>
    ((await (await owner.api.get('/api/v1/admin/upload-queue')).json()) as QueueItem[]).find((r) => r.uploadId === id);

  expect(N).toBeGreaterThan(2 * 1024 * 1024);
  expect(Buffer.concat([c0, c1, c2]).equals(file)).toBe(true);

  await test.step('1. Chunk 0 of 3 → 201 {complete: false}; the admin queue shows partially_uploaded 1/3; its staged file is c0', async () => {
    const res = await chunk(key, { uploadId, chunkIndex: 0, totalChunks: 3, totalSize: N }, c0);
    expect(res.status()).toBe(201);
    expect(await res.json()).toEqual({ complete: false });
    const row = await queueRow(uploadId);
    expect(row).toMatchObject({ sessionId: S, status: 'partially_uploaded', chunksReceived: 1, totalChunks: 3 });
    const staged = await owner.api.get(`/api/v1/admin/upload-queue/${row!.id}/file`);
    expect(staged.status()).toBe(200);
    expect(sha256(await staged.body())).toBe(sha256(c0));
  });

  await test.step('2. The same chunk 0 again (a hook retry) → 201 {complete: false}, still 1 received', async () => {
    const res = await chunk(key, { uploadId, chunkIndex: 0, totalChunks: 3, totalSize: N }, c0);
    expect(res.status()).toBe(201);
    expect(await res.json()).toEqual({ complete: false });
    expect(await queueRow(uploadId)).toMatchObject({ chunksReceived: 1, totalChunks: 3 });
  });

  await test.step('5. (while partial) user B sends chunk 1 with A’s uploadId → 400 «Unknown uploadId»', async () => {
    const res = await chunk(keyB, { uploadId, chunkIndex: 1, totalChunks: 3 }, c1);
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('Unknown uploadId');
    expect(await queueRow(uploadId)).toMatchObject({ chunksReceived: 1 });
  });

  await test.step('3. Chunk 2 before chunk 1 → 201, 2 received; chunk 1 → 201 {complete: true, warnings: []}', async () => {
    const r2 = await chunk(key, { uploadId, chunkIndex: 2, totalChunks: 3 }, c2);
    expect(r2.status()).toBe(201);
    expect(await r2.json()).toEqual({ complete: false });
    expect(await queueRow(uploadId)).toMatchObject({ chunksReceived: 2 });
    const r1 = await chunk(key, { uploadId, chunkIndex: 1, totalChunks: 3 }, c1);
    expect(r1.status()).toBe(201);
    expect(await r1.json()).toEqual({ complete: true, warnings: [] });
  });

  await test.step('3a. The artisyn log of S (the hook sends it too) links S to its repository', async () => {
    const res = await postLogs(api, key, { sessionId: S, type: 'artisyn' }, ndjson([
      { event: 'prompt_start', timestamp: ts(0), session_id: S, prompt: firstPrompt, git: { repo: repoUrl, branch: 'main' } },
      { event: 'prompt_stop', timestamp: ts(5999), session_id: S },
    ]));
    expect(res.status()).toBe(201);
    await waitForQueueIdle(db, owner.id, { timeoutMs: 60_000 });
  });

  await test.step('4. Parameter errors (each on a fresh uploadId) → 400 with the exact reason', async () => {
    const cases: Array<[string, Record<string, string | number>, RegExp]> = [
      ['uploadId only', { uploadId: `${uploadId}-a` }, /^Incomplete chunked-upload parameters$/],
      ['chunkIndex=abc', { uploadId: `${uploadId}-b`, chunkIndex: 'abc', totalChunks: 3 }, /must be non-negative integers/],
      ['chunkIndex=3 of 3', { uploadId: `${uploadId}-c`, chunkIndex: 3, totalChunks: 3, totalSize: 10 }, /out of range/],
      ['totalChunks=0', { uploadId: `${uploadId}-d`, chunkIndex: 0, totalChunks: 0, totalSize: 10 }, /out of range/],
      ['chunk 0 without totalSize', { uploadId: `${uploadId}-e`, chunkIndex: 0, totalChunks: 2 }, /^Missing totalSize on first chunk$/],
      ['chunk 1 of an unknown uploadId', { uploadId: `${uploadId}-f`, chunkIndex: 1, totalChunks: 2 }, /^Unknown uploadId$/],
    ];
    for (const [what, params, message] of cases) {
      const res = await chunk(key, params, '{"type":"noop"}\n');
      expect(res.status(), what).toBe(400);
      expect(((await res.json()) as { message: string }).message, what).toMatch(message);
    }
    // totalChunks mismatch: an upload recorded with 3 chunks, then chunk 1 claiming 4.
    const g = `${uploadId}-g`;
    expect((await chunk(key, { uploadId: g, chunkIndex: 0, totalChunks: 3, totalSize: 16 }, '{"type":"noop"}\n')).status()).toBe(201);
    const mismatch = await chunk(key, { uploadId: g, chunkIndex: 1, totalChunks: 4 }, '{"type":"noop"}\n');
    expect(mismatch.status()).toBe(400);
    expect(((await mismatch.json()) as { message: string }).message).toMatch(/mismatch/);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) expect(await queueRow(`${uploadId}-${id}`), id).toBeUndefined();
    // Leave nothing half-uploaded behind for the queue wait below.
    await db.query('DELETE FROM upload_queue WHERE upload_id = $1', [g]);
  });

  await test.step('6. Assembly: one logs row, processed size N, the stored 6000 lines equal the source lines', async () => {
    await waitForQueueIdle(db, owner.id, { timeoutMs: 60_000 });
    expect(await queueRow(uploadId)).toBeUndefined();
    await expect.poll(() => processedSizes(db, S)).toEqual(expect.arrayContaining([N]));
    const stored = await storedBody(db, S, 'claude');
    expect(stored).toHaveLength(6000);
    expect(stored).toEqual(lines);
    const repoId = await ownRepoId(owner.api, repoUrl);
    const logsRes = await owner.api.get(`/api/v1/repositories/${repoId}/sessions/${S}/logs`);
    expect(logsRes.status()).toBe(200);
    const text = await logsRes.text();
    expect(text).toContain(firstPrompt);
    expect(text).toContain(lastPrompt);
  });

  await test.step('7. A single chunk (totalChunks=1) completes at once', async () => {
    const one = `sess-one-${run}`;
    const body = ndjson([{ type: 'user', uuid: `${one}-0`, sessionId: one, timestamp: ts(0), message: { role: 'user', content: [{ type: 'text', text: 'один 🙂' }] } }]);
    const res = await postLogs(api, key, { sessionId: one, type: 'claude', uploadId: `${uploadId}-one`, chunkIndex: 0, totalChunks: 1, totalSize: Buffer.byteLength(body) }, body);
    expect(res.status()).toBe(201);
    expect(await res.json()).toEqual({ complete: true, warnings: [] });
    await waitForQueueIdle(db, owner.id);
    expect(await storedBody(db, one, 'claude')).toEqual([JSON.parse(body) as unknown]);
  });

  await test.step('8. The whole upload again under a new uploadId with a changed last line → last writer wins, no duplicates', async () => {
    const changed = [...lines.slice(0, 5999), { ...(lines[5999] as Record<string, unknown>), uuid: `${S}-5999-v2` }];
    const file2 = Buffer.from(ndjson(changed), 'utf8');
    const parts = splitOnLines(file2, 2);
    const id2 = `${uploadId}-v2`;
    for (const [i, part] of parts.entries()) {
      const res = await chunk(key, { uploadId: id2, chunkIndex: i, totalChunks: 2, ...(i === 0 ? { totalSize: file2.length } : {}) }, part);
      expect(res.status()).toBe(201);
    }
    await waitForQueueIdle(db, owner.id, { timeoutMs: 60_000 });
    expect(await sessionRowCount(db, S)).toBe(1);
    expect(await logRowCount(db, S)).toBe(2); // artisyn + claude
    const stored = (await storedBody(db, S, 'claude')) as Array<{ uuid: string }>;
    expect(stored).toHaveLength(6000);
    expect(stored[5999].uuid).toBe(`${S}-5999-v2`);
  });

  await test.step('9. UI: the Logs tab shows the first and the last prompt, Cyrillic and emoji intact', async () => {
    const repoId = await ownRepoId(owner.api, repoUrl);
    await openSession(page, owner, repoId, S, { tab: 'logs' });
    await expect(page.getByText(firstPrompt).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(lastPrompt).first()).toBeVisible();
  });
});
