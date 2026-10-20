// S-INGEST-03. Hostile and huge bodies: empty, malformed, NUL bytes, gzip in four shapes, size limit
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INGEST-03; layer API, no mode
// in the design → A and C, DD SC4). The stand runs with LOGS_MAX_BODY_MB=2 (DD C2), the design's
// ENV-B setting.
//
// Only v2 (impl-plan DD SC3). The design runs steps 1–2 on both /api/v1/logs and /api/v2/logs; v1
// is gone (404, S-INGEST-01), so they run on v2 only.
//
// Code facts that differ from the design text:
//   - v2 does not parse NDJSON on the request path (`logs-v2.controller.ts`): a malformed body is
//     staged → 201, and the queue turns it into a `failed` row whose error starts «Malformed
//     NDJSON» — still no `logs` and no `sessions` row. A body of blank lines is refused up front
//     (400 «Request body must not be empty»), like whitespace;
//   - the stored log is the jsonb array of lines, so «byte-identical» for the plain and gzip
//     variants is an exact equality of the stored lines plus an equal processed size;
//   - the uncompressed size of a gzip upload is read from `upload_queue_measurements.size_bytes`
//     (the queue row's size, recorded when the row is processed and deleted).
//
// Replaces:
//   - server/test/logs.e2e-spec.ts (400 sessionId/type/empty, > 100 KB, 413, NUL ×2, limit: ≈ 11)
//   - server/test/logs-gzip.e2e-spec.ts (13)
//   - server/src/logs/gzip-sniff.middleware.spec.ts (6)
//   (server/src/logs/ndjson-parser.spec.ts was folded into the ndjson-tolerance table test,
//   docs/knowledgebase/algorithms/ndjson-tolerance.md)
import { randomBytes } from 'crypto';
import { gzipSync } from 'zlib';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  logRowCount,
  ndjson,
  postLogs,
  processedSizes,
  queueRowCount,
  sessionRowCount,
  storedBody,
} from '../helpers/ingest';
import { waitForQueueIdle } from '../helpers/queue';

const MB = 1024 * 1024;

/** NDJSON of `{event:'note', i, pad}` lines totalling at least `bytes` bytes. */
function paddedBody(bytes: number, lineBytes = 4096): string {
  const lines: object[] = [];
  const pad = 'x'.repeat(lineBytes);
  for (let i = 0; lines.length * (lineBytes + 30) < bytes; i += 1) lines.push({ event: 'note', i, pad });
  return ndjson(lines);
}

test('@S-INGEST-03 hostile and huge bodies: empty, malformed, NUL, four gzip shapes, size limit @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(240_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('admin', { label: 'ing03' });
  const key = (await createApiKey(owner.api)).key;
  const sid = (name: string) => `ing03-${run}-${name}`;
  const post = (name: string, body: string | Buffer, headers: Record<string, string> = {}) =>
    postLogs(api, key, { sessionId: sid(name), type: 'artisyn' }, body, headers);
  const ok = async (name: string, body: string | Buffer, headers: Record<string, string> = {}) => {
    const res = await post(name, body, headers);
    expect(res.status(), `${name}: ${await res.text()}`).toBe(201);
  };
  const refusedWith = async (status: number, message: RegExp | null, res: Awaited<ReturnType<typeof post>>, what: string) => {
    expect(res.status(), what).toBe(status);
    if (message) expect(((await res.json()) as { message: string }).message, what).toMatch(message);
  };
  const nothingStored = async (name: string) => {
    expect(await queueRowCount(db, sid(name)), `${name}: upload_queue`).toBe(0);
    expect(await sessionRowCount(db, sid(name)), `${name}: sessions`).toBe(0);
    expect(await logRowCount(db, sid(name)), `${name}: logs`).toBe(0);
  };
  const valid: string[] = [];
  const T = ndjson([
    { event: 'prompt_start', timestamp: new Date(Date.now() - 3_600_000).toISOString(), prompt: `gzip twin ${run} — кириллица 🚀` },
    { event: 'note', text: 'second line', n: 2 },
  ]);

  await test.step('1. Structural 400: no sessionId, no type, empty body, whitespace body, blank lines → nothing stored', async () => {
    await refusedWith(400, /Missing sessionId/, await postLogs(api, key, { type: 'artisyn' }, T), 'no sessionId');
    await refusedWith(400, /Missing type/, await postLogs(api, key, { sessionId: sid('s1') }, T), 'no type');
    await refusedWith(400, /must not be empty/, await post('s1', ''), 'empty body');
    await refusedWith(400, /must not be empty/, await post('s1', '   \t  '), 'whitespace body');
    await refusedWith(400, /must not be empty/, await post('s1', '\n\n  \n'), 'blank lines');
    await nothingStored('s1');
    expect(await waitForQueueIdle(db, owner.id)).toEqual({});
  });

  await test.step('2. Malformed NDJSON → 201 staged, then a failed queue row «Malformed NDJSON»; no logs, no session', async () => {
    await ok('bad', '{"a":1}\nNOT-JSON\n');
    const counts = await waitForQueueIdle(db, owner.id, { allowFailed: true });
    expect(counts).toEqual({ failed: 1 });
    const { rows } = await db.query<{ error_message: string }>(
      'SELECT error_message FROM upload_queue WHERE session_id = $1',
      [sid('bad')],
    );
    expect(rows[0].error_message).toMatch(/^Malformed NDJSON: invalid JSON line 2 of 3/);
    expect(await sessionRowCount(db, sid('bad'))).toBe(0);
    expect(await logRowCount(db, sid('bad'))).toBe(0);
    // The next upload's response carries the failure as a warning (until an admin clears it).
    const next = await post('after-bad', T);
    expect(next.status()).toBe(201);
    const { warnings } = (await next.json()) as { warnings: string[] };
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Hook uploaded broken file: \S+\.raw — Malformed NDJSON/);
    valid.push('after-bad');
    await waitForQueueIdle(db, owner.id, { allowFailed: true });
    const cleared = await owner.api.delete('/api/v1/admin/upload-queue/failed');
    expect(cleared.status()).toBe(200);
    expect(await waitForQueueIdle(db, owner.id)).toEqual({});
  });

  await test.step('3. NUL: a real U+0000 → 201 and stored «ab»; a literal «\\u0000» in text stays as text', async () => {
    await ok('nul', ndjson([{ event: 'note', text: 'a\u0000b' }, { event: 'note', text: 'literal \\u0000 here' }]));
    await waitForQueueIdle(db, owner.id);
    expect(await storedBody(db, sid('nul'), 'artisyn')).toEqual([
      { event: 'note', text: 'ab' },
      { event: 'note', text: 'literal \\u0000 here' },
    ]);
    valid.push('nul');
  });

  await test.step('4. A 150 KB body (over the old 100 KB express.json limit) → 201', async () => {
    const body = paddedBody(150 * 1024);
    expect(Buffer.byteLength(body)).toBeGreaterThan(150 * 1024);
    await ok('150kb', body);
    await waitForQueueIdle(db, owner.id);
    expect(await logRowCount(db, sid('150kb'))).toBe(1);
    valid.push('150kb');
  });

  await test.step('5. One body T four ways: plain, gzip + Content-Encoding, gzip without the header → identical; broken gzip → 400', async () => {
    const gz = gzipSync(Buffer.from(T, 'utf8'));
    await ok('gz-plain', T);
    await ok('gz-header', gz, { 'Content-Encoding': 'gzip' });
    await ok('gz-sniffed', gz);
    const broken = Buffer.concat([Buffer.from([0x1f, 0x8b]), randomBytes(64)]);
    await refusedWith(400, /^Malformed gzip request body$/, await post('gz-broken', broken), 'broken gzip');
    await waitForQueueIdle(db, owner.id);
    await nothingStored('gz-broken');
    const plain = await storedBody(db, sid('gz-plain'), 'artisyn');
    expect(plain).toHaveLength(2);
    expect(await storedBody(db, sid('gz-header'), 'artisyn')).toEqual(plain);
    expect(await storedBody(db, sid('gz-sniffed'), 'artisyn')).toEqual(plain);
    const tBytes = Buffer.byteLength(T, 'utf8');
    for (const name of ['gz-plain', 'gz-header', 'gz-sniffed']) {
      await expect
        .poll(() => processedSizes(db, sid(name)), { message: `${name}: size of the decompressed body` })
        .toEqual([tBytes]);
    }
    valid.push('gz-plain', 'gz-header', 'gz-sniffed');
  });

  await test.step('6. Limit 2 MB: 3 MB plain → 413; gzip over 2 MB compressed → 413; a small gzip bomb → 413, not 400', async () => {
    await refusedWith(413, null, await post('big-plain', paddedBody(3 * MB)), '3 MB plain');
    // Random base64 hardly compresses: ~3 MB of text is still > 2 MB gzipped.
    const noisy = gzipSync(Buffer.from(ndjson([{ event: 'note', noise: randomBytes(2_300_000).toString('base64') }])));
    expect(noisy.length).toBeGreaterThan(2 * MB);
    await refusedWith(413, null, await post('big-gz-header', noisy, { 'Content-Encoding': 'gzip' }), 'big gzip with header');
    await refusedWith(413, null, await post('big-gz-sniffed', noisy), 'big gzip without header');
    const bomb = gzipSync(Buffer.from(ndjson([{ event: 'note', pad: 'a'.repeat(3 * MB) }])));
    expect(bomb.length).toBeLessThan(64 * 1024);
    await refusedWith(413, null, await post('bomb-header', bomb, { 'Content-Encoding': 'gzip' }), 'bomb with header');
    await refusedWith(413, null, await post('bomb-sniffed', bomb), 'bomb without header');
    for (const name of ['big-plain', 'big-gz-header', 'big-gz-sniffed', 'bomb-header', 'bomb-sniffed']) await nothingStored(name);
  });

  await test.step('7. A body just under the limit (1.9 MB) → 201', async () => {
    const body = paddedBody(1.9 * MB - 64 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(2 * MB);
    expect(Buffer.byteLength(body)).toBeGreaterThan(1.8 * MB);
    await ok('just-under', body);
    await waitForQueueIdle(db, owner.id);
    expect(await logRowCount(db, sid('just-under'))).toBe(1);
    valid.push('just-under');
  });

  await test.step('8. v2 chunks gzipped: the stored size is the decompressed totalSize', async () => {
    const body = Buffer.from(paddedBody(300 * 1024), 'utf8');
    const cut = body.indexOf(0x0a, Math.floor(body.length / 2)) + 1;
    const parts = [body.subarray(0, cut), body.subarray(cut)];
    const uploadId = `u-${run}-gz`;
    for (const [i, part] of parts.entries()) {
      const res = await postLogs(
        api,
        key,
        { sessionId: sid('gz-chunks'), type: 'artisyn', uploadId, chunkIndex: i, totalChunks: 2, ...(i === 0 ? { totalSize: body.length } : {}) },
        gzipSync(part),
        { 'Content-Encoding': 'gzip' },
      );
      expect(res.status()).toBe(201);
      expect(((await res.json()) as { complete: boolean }).complete).toBe(i === 1);
    }
    await waitForQueueIdle(db, owner.id);
    await expect.poll(() => processedSizes(db, sid('gz-chunks'))).toEqual([body.length]);
    expect(await storedBody(db, sid('gz-chunks'), 'artisyn')).toEqual(
      body.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown),
    );
    valid.push('gz-chunks');
  });

  await test.step('9. The server is alive and every valid upload left exactly one logs row', async () => {
    expect((await api.get('/health')).status()).toBe(200);
    for (const name of valid) expect(await logRowCount(db, sid(name)), name).toBe(1);
    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM logs WHERE user_id = $1', [owner.id]);
    expect(Number(rows[0].n)).toBe(valid.length);
  });
});
