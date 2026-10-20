// S-REL-02. Signed release link: from the admin panel to an anonymous download and every refusal
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-REL-02; layer UI+API, no mode
// in the design → A and C, DD SC4).
//
// The release zips go into the stand's own RELEASES_DIR (`<STAND_RUN_DIR>/releases`,
// `helpers/releases.ts`), which `ReleasesService` reads per request; the scenario starts from a
// missing directory and removes it again at the end.
//
// Code facts that differ from the design text:
//   - the HMAC key is not SESSION_SECRET itself but HKDF-SHA256(SESSION_SECRET, info
//     «release-link»); in modes A and C the secret is the generated `server_secrets` row of the
//     stand schema, which is where the scenario reads it to sign an expired link (step 5);
//   - step 10 (restart with another SESSION_SECRET) cannot restart the stand from inside a spec;
//     the same property — the signature is bound to the server key — is checked by signing a
//     live link with a different key → 403;
//   - step 11 runs only its «no TRUST_PROXY» half: the stand starts without TRUST_PROXY, so
//     X-Forwarded-* are ignored and the link keeps the request's own origin;
//   - a non-zip name in `POST /admin/releases/download-link` is refused by the DTO pattern
//     («file must be a release zip file name»), a well-formed name that is not in the current
//     inventory by the controller («That release is not available…») — both 400.
//
// Replaces:
//   - server/test/releases.e2e-spec.ts (17)
//   - server/src/releases/release-token.spec.ts (7 of 11)
//   - server/src/releases/releases.service.spec.ts (3 of 10)
//   - server/test/admin-releases.spec.ts (1)
//   - client/src/viewer/__tests__/components/ReleaseDownloadsSection.test.tsx (2)
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import { skipNewUserNudge } from '../helpers/teams';
import {
  releaseDownloadPath,
  releaseLinkKey,
  signRelease,
  standReleasesDir,
  writeReleaseFiles,
} from '../helpers/releases';

const OLD = 'artisyn-log-hub-20260101-000000-amd64.zip';
const AMD = 'artisyn-log-hub-20260918-142233-amd64.zip';
const ARM = 'artisyn-log-hub-20260918-142233-arm64.zip';
const RISCV = 'artisyn-log-hub-20260918-142233-riscv.zip';
const BAD_STAMP = 'artisyn-log-hub-bad-stamp-amd64.zip';
const NEWER = 'artisyn-log-hub-20260919-080000-amd64.zip';
const DAY_S = 24 * 60 * 60;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('@S-REL-02 signed release link: admin panel, anonymous download, every refusal @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const dir = standReleasesDir(stand);
  fs.rmSync(dir, { recursive: true, force: true });
  const admin = await users.user('admin', { label: 'rel02-admin' });
  const regular = await users.user('user', { label: 'rel02-user' });
  const amdBytes = randomBytes(1024);
  const listed = async () =>
    ((await (await admin.api.get('/api/v1/admin/releases')).json()) as { entries: Array<{ fileName: string }> }).entries.map(
      (e) => e.fileName,
    );
  const mint = (file: string, headers: Record<string, string> = {}) =>
    admin.api.post('/api/v1/admin/releases/download-link', { data: { file }, headers });
  const refusal = async (url: string, status: number, title: string, what: string) => {
    const res = await api.get(url);
    expect(res.status(), what).toBe(status);
    expect(res.headers()['content-type'], what).toMatch(/^text\/html/);
    const body = await res.body();
    expect(body.toString('utf8'), what).toContain(`<title>${title}</title>`);
    expect(body.includes(amdBytes), `${what}: no file bytes`).toBe(false);
    expect(body.toString('utf8'), `${what}: no path`).not.toContain(stand.runDir);
    expect(body.toString('utf8'), `${what}: no path`).not.toMatch(/releases[\\/]/);
  };

  try {
    await skipNewUserNudge(page.context());
    await admin.signIn(page);

    await test.step('0. No RELEASES_DIR yet → an empty inventory, no error; the UI says so', async () => {
      expect(await listed()).toEqual([]);
      await page.goto('/#/admin?tab=system-info');
      await expect(page.getByText('No release zips on this instance')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('1. UI (admin): Release Downloads lists only the newest stamp per architecture', async () => {
      writeReleaseFiles(dir, {
        [OLD]: randomBytes(512),
        [AMD]: amdBytes,
        [ARM]: randomBytes(700),
        [RISCV]: randomBytes(300),
        [BAD_STAMP]: randomBytes(300),
        'notes.txt': 'release notes',
      });
      expect(await listed()).toEqual([AMD, ARM]);
      await page.reload();
      const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Generate link' }) });
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText(AMD);
      await expect(rows.nth(1)).toContainText(ARM);
      for (const hidden of [OLD, RISCV, BAD_STAMP, 'notes.txt']) await expect(page.getByText(hidden)).toHaveCount(0);
    });

    const link = await test.step('2. «Generate link» for amd64: a signed URL on this origin, expiring in 24 h (UTC), with Copy link', async () => {
      const minted = page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/releases/download-link'));
      const before = Math.floor(Date.now() / 1000);
      await page.getByRole('row').filter({ hasText: AMD }).getByRole('button', { name: 'Generate link' }).click();
      const res = await minted;
      expect(res.status()).toBe(200);
      const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
      const shown = page.locator('code').filter({ hasText: '/api/v1/releases/download?' });
      await expect(shown).toHaveText(url);
      expect(url.startsWith(`${stand.url}/api/v1/releases/download?file=${AMD}&exp=`)).toBe(true);
      const parsed = new URL(url);
      const exp = Number(parsed.searchParams.get('exp'));
      expect(Math.abs(exp - (before + DAY_S))).toBeLessThanOrEqual(60);
      expect(Date.parse(expiresAt)).toBe(exp * 1000);
      await expect(page.getByText(`expires ${expiresAt.slice(0, 19).replace('T', ' ')} UTC`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
      return { path: `${parsed.pathname}${parsed.search}`, exp, sig: parsed.searchParams.get('sig') as string };
    });

    await test.step('3. Anonymous download → 200 application/zip, attachment with the file name, the exact bytes', async () => {
      const res = await api.get(link.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/zip');
      expect(res.headers()['content-disposition']).toBe(`attachment; filename="${AMD}"`);
      expect(sha256(await res.body())).toBe(sha256(amdBytes));
    });

    await test.step('4. Tampering → 403 «Invalid download link» HTML, no bytes, no paths', async () => {
      const flipped = link.sig.slice(0, -1) + (link.sig.endsWith('A') ? 'B' : 'A');
      await refusal(releaseDownloadPath(AMD, link.exp, flipped), 403, 'Invalid download link', 'one sig char changed');
      await refusal(releaseDownloadPath(AMD, link.exp + 3600, link.sig), 403, 'Invalid download link', 'exp +1 h, old sig');
      await refusal(`/api/v1/releases/download?file=a&file=b&exp=${link.exp}&sig=${link.sig}`, 403, 'Invalid download link', 'repeated file');
      await refusal(`/api/v1/releases/download?file[x]=1&exp=${link.exp}&sig=${link.sig}`, 403, 'Invalid download link', 'file[x]');
      await refusal(`/api/v1/releases/download?file=../../etc/passwd&exp=${link.exp}&sig=${link.sig}`, 403, 'Invalid download link', '../../etc/passwd');
      await refusal(`/api/v1/releases/download?file=..%2f..%2fsecret.zip&exp=${link.exp}&sig=${link.sig}`, 403, 'Invalid download link', '..%2f');
      await refusal(releaseDownloadPath('release.zip', link.exp, link.sig), 403, 'Invalid download link', 'name off the pattern');
    });

    const key = await releaseLinkKey(db);

    await test.step('5. A genuine signature over a past exp → 410 «Link expired»; a negative or non-numeric exp → 403 (not 500)', async () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      expect(signRelease(AMD, link.exp, key)).toBe(link.sig);
      await refusal(releaseDownloadPath(AMD, past, signRelease(AMD, past, key)), 410, 'Link expired', 'expired');
      await refusal(releaseDownloadPath(AMD, -5, signRelease(AMD, -5, key)), 403, 'Invalid download link', 'negative exp');
      await refusal(releaseDownloadPath(AMD, 'abc', signRelease(AMD, 'abc', key)), 403, 'Invalid download link', 'non-numeric exp');
      // Pattern before signature: an expired-but-genuine link to a bad name is 403, not 410.
      await refusal(releaseDownloadPath(RISCV, past, signRelease(RISCV, past, key)), 403, 'Invalid download link', 'bad name, past');
    });

    await test.step('10*. The signature is bound to the server key: the same link signed with another key → 403', async () => {
      const otherKey = randomBytes(32);
      await refusal(releaseDownloadPath(AMD, link.exp, signRelease(AMD, link.exp, otherKey)), 403, 'Invalid download link', 'other key');
    });

    await test.step('7. A newer stamp appears: the old link keeps working, but minting for the superseded, unknown or non-zip names → 400', async () => {
      writeReleaseFiles(dir, { [NEWER]: randomBytes(256) });
      expect(await listed()).toEqual([NEWER]);
      expect((await api.get(link.path)).status()).toBe(200);
      const superseded = await mint(AMD);
      expect(superseded.status()).toBe(400);
      expect(((await superseded.json()) as { message: string }).message).toBe('That release is not available for download on this server');
      expect((await mint('artisyn-log-hub-20250101-000000-arm64.zip')).status()).toBe(400);
      for (const file of ['notes.txt', 'not-a-zip']) {
        const res = await mint(file);
        expect(res.status(), file).toBe(400);
        expect(((await res.json()) as { message: string }).message, file).toBe('file must be a release zip file name');
      }
      expect((await mint(NEWER)).status()).toBe(200);
    });

    await test.step('6. The file is deleted from disk: the live link → 404 «File no longer available», no 500', async () => {
      fs.rmSync(path.join(dir, AMD));
      await refusal(link.path, 404, 'File no longer available', 'deleted file');
    });

    await test.step('8. Rights: a regular user → 403 on the admin routes, anonymous → 401; the public link needs no login', async () => {
      expect((await regular.api.get('/api/v1/admin/releases')).status()).toBe(403);
      expect((await regular.api.post('/api/v1/admin/releases/download-link', { data: { file: NEWER } })).status()).toBe(403);
      expect((await api.get('/api/v1/admin/releases')).status()).toBe(401);
      expect((await api.post('/api/v1/admin/releases/download-link', { data: { file: NEWER } })).status()).toBe(401);
      const fresh = (await (await mint(NEWER)).json()) as { url: string };
      const u = new URL(fresh.url);
      expect((await api.get(`${u.pathname}${u.search}`)).status()).toBe(200);
    });

    await test.step('9. /static/<zip> and /<zip>, anonymous and as a user, never serve the zip bytes', async () => {
      const newerBytes = fs.readFileSync(path.join(dir, NEWER));
      for (const ctx of [api, regular.api]) {
        for (const p of [`/static/${NEWER}`, `/${NEWER}`, `/releases/${NEWER}`]) {
          const body = await (await ctx.get(p)).body();
          expect(body.includes(newerBytes), p).toBe(false);
        }
      }
    });

    await test.step('11. Without TRUST_PROXY, X-Forwarded-Proto/Host are ignored: the link keeps the request origin', async () => {
      const res = await mint(NEWER, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'logs.arrakis.test' });
      expect(res.status()).toBe(200);
      const { url } = (await res.json()) as { url: string };
      expect(url.startsWith(`${stand.url}/api/v1/releases/download?`)).toBe(true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
