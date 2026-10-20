/**
 * Release Downloads — the admin-only section on Admin → System Info, plus the
 * /static regressions the feature had to not break. Extended suite, not @core.
 *
 * The generate-link flow is driven end-to-end against the real backend rather
 * than a routed mock: a fixture zip is written into the releases directory the
 * dev server resolves to, so the inventory endpoint really lists it and the
 * mint endpoint really signs it.
 *
 * That directory is `server/releases` — `resolveReleasesDir()` lands two levels
 * up from the releases module for both dev layouts (`server/src/releases` under
 * ts-node and `server/dist/releases` under `nest start --watch`), and
 * `RELEASES_DIR` is unset on a dev box. It is gitignored, and the fixture is
 * removed again in afterAll.
 *
 * The /static cases live here rather than in `server/test/releases.e2e-spec.ts`
 * because `ServeStaticModule` is inert in the Nest testing app that suite boots
 * (every path it would serve answers 404 there). Here they go through the very
 * same `/static` → backend proxy a browser uses.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { storageStatePath } from './helpers/credentials';

// Serial for the whole file: every test depends on the one on-disk fixture
// that beforeAll writes and afterAll removes.
test.describe.configure({ mode: 'serial' });

// A far-future stamp so this fixture is deterministically the newest release
// on the box — `listReleases()` returns the newest stamp only, so the table
// shows exactly this one row whatever else happens to sit in the directory.
const FIXTURE_STAMP = '20991231-235959';
const FIXTURE_FILE = `artisyn-log-hub-${FIXTURE_STAMP}-amd64.zip`;

const RELEASES_DIR = path.join(__dirname, '..', '..', 'server', 'releases');
const FIXTURE_PATH = path.join(RELEASES_DIR, FIXTURE_FILE);
const FIXTURE_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(2048, 0x07),
]);

test.beforeAll(() => {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, FIXTURE_BYTES);
});

test.afterAll(() => {
  fs.rmSync(FIXTURE_PATH, { force: true });
});

test.describe('Admin — Release Downloads', () => {
  test.use({ storageState: storageStatePath('admin') });

  test('System Info tab shows the Release Downloads section with the release row', async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin');
    await page.waitForURL('**/#/admin', { timeout: 10_000 });

    const tabPanel = page.getByRole('tabpanel');
    await expect(
      tabPanel.getByText('Release Downloads', { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      tabPanel.getByText(
        'Release bundles this instance carries · visible to administrators only',
      ),
    ).toBeVisible();

    // The Release tile in the secondary strip renders the build stamp.
    const releaseTile = tabPanel
      .getByText('Release', { exact: true })
      .locator('..');
    await expect(releaseTile).toContainText('build stamp (UTC)');

    const row = tabPanel.locator('tr').filter({ hasText: FIXTURE_FILE });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText('amd64');
    await expect(row).toContainText(FIXTURE_STAMP);
    await expect(
      row.getByRole('button', { name: 'Generate link' }),
    ).toBeVisible();

    expect(jsErrors).toHaveLength(0);
  });

  test('Generate link mints a download URL and flips the button to Regenerate link', async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin');
    await page.waitForURL('**/#/admin', { timeout: 10_000 });

    const tabPanel = page.getByRole('tabpanel');
    const row = tabPanel.locator('tr').filter({ hasText: FIXTURE_FILE });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole('button', { name: 'Generate link' }).click();

    // The link panel renders in its own full-width row directly below.
    const linkCode = tabPanel
      .locator('code')
      .filter({ hasText: '/api/v1/releases/download' });
    await expect(linkCode).toBeVisible({ timeout: 10_000 });

    const url = (await linkCode.textContent())?.trim() ?? '';
    expect(url).toContain(`file=${FIXTURE_FILE}`);
    expect(url).toMatch(/[?&]exp=\d+/);
    expect(url).toMatch(/[?&]sig=[\w-]+/);

    await expect(
      tabPanel.getByText(/Valid for 24 hours · expires .* UTC/),
    ).toBeVisible();
    await expect(
      tabPanel.getByRole('button', { name: 'Copy link' }),
    ).toBeVisible();

    await expect(
      row.getByRole('button', { name: 'Regenerate link' }),
    ).toBeVisible();

    expect(jsErrors).toHaveLength(0);
  });
});

test.describe('/static — anonymous', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a release zip is never served from /static', async ({ request }) => {
    const res = await request.get(`/static/${FIXTURE_FILE}`);

    // Asserted on the BODY, not the status: with serveRoot '/', an unknown
    // path under ServeStaticModule falls through to index.html with a 200.
    // What must hold is that no zip content ever comes back.
    const body = await res.body();
    expect(res.headers()['content-type'] ?? '').not.toContain(
      'application/zip',
    );
    expect(body.subarray(0, 4).toString('latin1')).not.toBe('PK\u0003\u0004');
    expect(Buffer.compare(body, FIXTURE_BYTES)).not.toBe(0);
  });

  test('the installer tarball and installer-version.json still download unauthenticated', async ({
    request,
  }) => {
    // A deliberately low version: the capture is max-wins, so this cannot
    // regress whatever baseline the dev box has recorded. (The capture itself
    // is asserted in server/test/releases.e2e-spec.ts, which can snapshot and
    // restore the on-disk manifest around the call.)
    const tgz = await request.get('/static/artisyn-hooks-installer.tgz?v=0.0.1');
    expect(tgz.status()).toBe(200);
    expect((await tgz.body()).length).toBeGreaterThan(0);

    const manifest = await request.get('/static/installer-version.json');
    expect(manifest.status()).toBe(200);
    expect(typeof (await manifest.json()).version).toBe('string');
  });

  test('hooks.tar.gz and latest-hook-version.json are not behind auth', async ({
    request,
  }) => {
    // These two live in `server/src/public/static`, which only the production
    // (ncc) layout serves — on a dev box ServeStaticModule's root is
    // `server/dist/public`, so they answer 404 here and a 200 cannot be
    // asserted from any harness we have. What this guards is the property the
    // release work could actually have broken: they must never have become
    // authenticated routes.
    for (const asset of ['hooks.tar.gz', 'latest-hook-version.json']) {
      const res = await request.get(`/static/${asset}`);
      expect([401, 403]).not.toContain(res.status());
    }
  });
});

test.describe('/static — logged-in non-admin', () => {
  test.use({ storageState: storageStatePath('regular') });

  test('a release zip is never served from /static', async ({ request }) => {
    const res = await request.get(`/static/${FIXTURE_FILE}`);

    // Asserted on the BODY, not the status: with serveRoot '/', an unknown
    // path under ServeStaticModule falls through to index.html with a 200.
    // What must hold is that no zip content ever comes back.
    const body = await res.body();
    expect(res.headers()['content-type'] ?? '').not.toContain(
      'application/zip',
    );
    expect(body.subarray(0, 4).toString('latin1')).not.toBe('PK\u0003\u0004');
    expect(Buffer.compare(body, FIXTURE_BYTES)).not.toBe(0);
  });
});
