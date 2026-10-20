// S-AUTH-02. First login: the data-collection consent screen cannot be bypassed
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-02; «any mode» → A and C, DD SC4).
//
// Deviations from the design text, both forced by the code or by DD SC3:
//   - step 4 uploads through `POST /api/v2/logs` (DD SC3), as a second never-consented user: the
//     first one must stay without repositories for the «new user lands on API keys» check;
//   - the left menu is checked as «no <nav> element», the Install tab and the Help button by role.
//
// Replaces:
//   - tests/e2e/data-collection-consent.spec.ts (3)
//   - client/src/viewer/__tests__/components/data-collection-consent-screen.test.tsx (10; «a changed
//     text brings the gate back» and «Escape does not close it» are steps 7 and 3)
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadGolden } from '../helpers/golden';
import { DATA_COLLECTION_NOTICE_SETTING } from '../helpers/notice-hash';

const CONSENT = 'data-collection-consent-screen';
const ACCEPT = { name: 'I understand and accept' };

test('@S-AUTH-02 first login: the data-collection consent screen cannot be bypassed @mode-a @mode-c', async ({
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const admin = await users.user('admin');
  const newcomer = await users.user('user', { label: 'consent', acceptNotice: false });

  const expectGateOnly = async () => {
    await expect(page.getByTestId(CONSENT)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', ACCEPT)).toBeVisible();
    // The screen replaces the shell instead of overlaying it.
    await expect(page.getByRole('tab', { name: 'Install' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help' })).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
  };

  await test.step('1–2. UI: /#/main and every deep link show only the consent screen', async () => {
    await newcomer.signIn(page);
    for (const route of ['/#/main', '/#/api-keys', '/#/teams', '/#/admin', '/#/repos/1']) {
      await page.goto(route);
      await expectGateOnly();
    }
  });

  const retentionInText = await test.step('3. the notice names the retention window, warns about secrets, has no way out', async () => {
    await expect(page.getByText('If the assistant handles secrets')).toBeVisible();
    const sentence = page.getByText(/Stored session data is purged after \d+ days/);
    await expect(sentence).toBeVisible();
    const days = Number(/purged after (\d+) days/.exec(await sentence.innerText())?.[1]);
    expect(Number.isInteger(days)).toBe(true);
    await expect(page.getByText('{{RETENTION_DAYS}}')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /decline/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(CONSENT)).toBeVisible();
    return days;
  });

  await test.step('4. API: a never-consented user still uploads logs with a key and reads user-settings', async () => {
    // Consent is a UI gate only — recorded so nobody mistakes it for an API protection.
    const uploader = await users.user('user', { label: 'consent-api', acceptNotice: false });
    const key = await createApiKey(uploader.api);
    // uploadGolden throws on any non-201 answer and on a failed queue row.
    await uploadGolden(uploader.api, key.key, 'gs-01', { queue: { db, userId: uploader.id } });
    const repos = await uploader.api.get('/api/v1/repositories');
    expect(repos.status()).toBe(200);
    expect(((await repos.json()) as unknown[]).length).toBeGreaterThan(0);
    const settings = await uploader.api.get('/api/v1/user-settings');
    expect(settings.status()).toBe(200);
  });

  await test.step('5. UI: «I understand and accept» on /#/main → the shell appears, a new user lands on API keys', async () => {
    await page.goto('/#/main');
    await expect(page.getByTestId(CONSENT)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', ACCEPT).click();
    await expect(page.getByTestId(CONSENT)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
    await expect(page).toHaveURL(/#\/api-keys/);
  });

  await test.step('6. reload and a new tab: the screen stays gone; the API-keys nudge fired only once', async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Help' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(CONSENT)).toHaveCount(0);
    await page.goto('/#/main');
    await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
    await expect(page).toHaveURL(/#\/main/);

    const second = await page.context().newPage();
    try {
      await second.goto('/#/teams');
      await expect(second.getByRole('button', { name: 'Help' })).toBeVisible({ timeout: 15_000 });
      await expect(second.getByTestId(CONSENT)).toHaveCount(0);
    } finally {
      await second.close();
    }
  });

  await test.step('7. API: a foreign hash in the stored consent brings the gate back', async () => {
    const res = await newcomer.api.put(`/api/v1/user-settings/${DATA_COLLECTION_NOTICE_SETTING}`, {
      data: { value: JSON.stringify({ noticeHash: 'deadbeef', acceptedAt: new Date().toISOString() }) },
    });
    expect(res.ok()).toBe(true);
    await page.reload();
    await expectGateOnly();
  });

  await test.step('8. API: the admin-side retention equals the number in the notice text', async () => {
    const res = await admin.api.get('/api/v1/admin/retention');
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { retentionDays: number }).retentionDays).toBe(retentionInText);
  });
});
