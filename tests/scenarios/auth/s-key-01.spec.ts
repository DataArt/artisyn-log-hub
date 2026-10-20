// S-KEY-01. Life of an API key: create, see it once, upload logs, revoke, expire
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-KEY-01; any mode → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3) instead of the design's /api/v1/logs.
//
// Code facts that differ from the design text:
//   - known bug (task Notes): the «Expires (optional)» date input of the create form keeps
//     `<date>T00:00:00Z` in state and feeds it back as the input's value, which a date input
//     sanitises to '' — the following `change` event resets the state, so the key is created
//     without expiry. Both expiries of step 5 are therefore set with the pencil
//     (`DatePickerPopover`, local midnight of the chosen day);
//   - the duplicate-name error is the server message «API key name already exists» under the form.
//
// Replaces:
//   - server/test/api-keys.e2e-spec.ts (21)
//   - server/test/logs.e2e-spec.ts (3: no key 401, wrong key 401, expired key 401)
//   - tests/e2e/api-keys.spec.ts (4 of 10: the Keys tab and the @core key creation)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, postSessionLog, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';

interface PublicKey {
  id: number;
  name: string;
  slug: string;
  expires_at: string | null;
  [field: string]: unknown;
}

test('@S-KEY-01 API key life: create, see once, upload, revoke, expire @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const runId = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${runId}/keys`;
  const u = await users.user('user', { label: 'keys' });
  const v = await users.user('user', { label: 'keys-other' });
  const session = (n: number): PromptSession => ({
    sessionId: `key-${runId}-${n}`,
    prompt: `key prompt ${runId} #${n}`,
    repoUrl,
  });
  const listKeys = async () => (await (await u.api.get('/api/v1/api-keys')).json()) as PublicKey[];
  const keyNamed = async (name: string) => {
    const key = (await listKeys()).find((k) => k.name === name);
    if (!key) throw new Error(`No key named ${name}`);
    return key;
  };
  const upload = (key: string, n: number) => postSessionLog(api, session(n), 'artisyn', { 'X-API-Key': key });

  await u.signIn(page);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Generate' }) });
  const generate = async (name: string) => {
    await form.getByPlaceholder('e.g. CI pipeline').fill(name);
    await form.getByRole('button', { name: 'Generate' }).click();
  };
  const banner = page.getByText("Save this key — it won't be shown again.");

  const plaintext = await test.step('1. UI: /#/api-keys → API Keys tab, «upload key» without expiry → Generate', async () => {
    await page.goto('/#/api-keys');
    await page.getByTestId('tab-apikeys-keys').click();
    await generate('upload key');
    await expect(banner).toBeVisible();
    const key = (await banner.locator('xpath=..').locator('code').textContent())?.trim() ?? '';
    expect(key).toMatch(/^\S{6}-\S{7}$/);
    return key;
  });

  await test.step('2. UI: the table shows the name and the prefix only; after Dismiss and a reload the key is gone', async () => {
    const row = page.getByRole('row').filter({ hasText: 'upload key' });
    await expect(row).toContainText(`${plaintext.slice(0, 6)}…`);
    await expect(row).not.toContainText(plaintext);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await page.getByTestId('tab-apikeys-keys').click();
    await expect(page.getByRole('row').filter({ hasText: 'upload key' })).toBeVisible();
    await expect(page.getByText(plaintext)).toHaveCount(0);
    for (const k of await listKeys()) {
      expect(k).not.toHaveProperty('key');
      expect(k).not.toHaveProperty('key_hash');
      expect(k).not.toHaveProperty('keyHash');
    }
  });

  const repoId = await test.step('3. API: an upload with the key → 201; the session shows up in the repository UI', async () => {
    await uploadPromptSession(api, plaintext, session(1), { db, userId: u.id });
    const id = await ownRepoId(u.api, repoUrl);
    await page.goto(`/#/repos/${id}`);
    await expect(page.getByText(session(1).prompt)).toBeVisible({ timeout: 15_000 });
    return id;
  });

  await test.step('4. UI: a second key named «upload key» → «API key name already exists», nothing created', async () => {
    await page.goto('/#/api-keys');
    await page.getByTestId('tab-apikeys-keys').click();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/api-keys') && r.request().method() === 'POST');
    await generate('upload key');
    expect((await created).status()).toBe(409);
    await expect(form.getByText('API key name already exists')).toBeVisible();
    expect((await listKeys()).filter((k) => k.name === 'upload key')).toHaveLength(1);
  });

  const shortLived = await test.step('5. UI: «short-lived» with a future expiry, then the pencil moves it into the past', async () => {
    // The create form's own date input loses its value (known bug, see the header), so the
    // future expiry is set with the pencil right after creation, as the design's step 5 does
    // for the past one.
    await generate('short-lived');
    await expect(banner).toBeVisible();
    const created = await keyNamed('short-lived');
    const shortKey = (await banner.locator('xpath=..').locator('code').textContent())?.trim() ?? '';

    const row = page.getByRole('row').filter({ hasText: 'short-lived' });
    const pickFirstDayOf = async (month: 'Next' | 'Previous') => {
      await row.hover();
      await row.getByTitle('Edit expiry').click();
      const picker = page.getByRole('dialog');
      await picker.getByRole('button', { name: `Go to the ${month} Month` }).click();
      await picker.locator('td[data-day]:not([data-outside]) button').first().click();
      const patched = page.waitForResponse((r) => r.url().includes('/api/v1/api-keys/') && r.request().method() === 'PATCH');
      await picker.getByRole('button', { name: 'Apply' }).click();
      expect((await patched).status()).toBe(200);
      await expect(picker).toHaveCount(0);
      const expiresAt = (await keyNamed('short-lived')).expires_at;
      expect(expiresAt).not.toBeNull();
      return Date.parse(expiresAt as string);
    };
    expect(await pickFirstDayOf('Next')).toBeGreaterThan(Date.now());
    await expect(row).not.toContainText('—');
    expect(await pickFirstDayOf('Previous')).toBeLessThan(Date.now());
    return { key: shortKey, id: created.id };
  });

  await test.step('6. API: an upload with the expired key → 401', async () => {
    expect((await upload(shortLived.key, 2)).status()).toBe(401);
  });

  await test.step('7. API: PATCH expires_at null lifts the expiry, the same key uploads again → 201', async () => {
    const res = await u.api.patch(`/api/v1/api-keys/${shortLived.id}`, { data: { expires_at: null } });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as PublicKey).expires_at).toBeNull();
    expect((await upload(shortLived.key, 3)).status()).toBe(201);
    await waitForQueueIdle(db, u.id);
  });

  await test.step('8. UI: the trash icon on «upload key», confirmed → the row is gone', async () => {
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe('Revoke key "upload key"?');
      void dialog.accept();
    });
    const row = page.getByRole('row').filter({ hasText: /^upload key/ });
    const deleted = page.waitForResponse((r) => r.url().includes('/api/v1/api-keys/') && r.request().method() === 'DELETE');
    await row.getByTitle('Revoke').click();
    expect((await deleted).status()).toBe(204);
    await expect(page.getByRole('cell', { name: 'upload key', exact: true })).toHaveCount(0);
  });

  await test.step('9. API: the revoked key → 401, its earlier session stays; a session cookie on the upload route → 401', async () => {
    expect((await upload(plaintext, 4)).status()).toBe(401);
    const sessions = (await (await u.api.get(`/api/v1/repositories/${repoId}/sessions`)).json()) as Array<{ sessionId: string }>;
    expect(sessions.map((s) => s.sessionId)).toContain(session(1).sessionId);
    expect((await postSessionLog(u.api, session(5), 'artisyn')).status()).toBe(401);
  });

  await test.step('10. API: a valid key on the session routes /teams and /repositories → 401', async () => {
    const live = await createApiKey(u.api, { name: `live-${runId}` });
    for (const path of ['/api/v1/teams', '/api/v1/repositories']) {
      expect((await api.get(path, { headers: { 'X-API-Key': live.key } })).status(), path).toBe(401);
    }
  });

  await test.step('11. API (V): PATCH and DELETE of U’s key → 403; an unknown id → 404', async () => {
    expect((await v.api.patch(`/api/v1/api-keys/${shortLived.id}`, { data: { expires_at: null } })).status()).toBe(403);
    expect((await v.api.delete(`/api/v1/api-keys/${shortLived.id}`)).status()).toBe(403);
    expect((await v.api.delete('/api/v1/api-keys/2147483647')).status()).toBe(404);
    expect((await keyNamed('short-lived')).id).toBe(shortLived.id);
  });

  await test.step('12. API: an empty name → 400; a date without time in expires_at → 400', async () => {
    expect((await u.api.post('/api/v1/api-keys', { data: { name: '' } })).status()).toBe(400);
    const dateOnly = await u.api.post('/api/v1/api-keys', { data: { name: `date-only-${runId}`, expires_at: '2030-01-01' } });
    expect(dateOnly.status()).toBe(400);
  });
});
