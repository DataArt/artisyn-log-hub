// Stand smoke (impl-plan Test coverage plan, C): the isolated stand answers /health, runs in the
// auth mode the runner asked for, serves the SPA, and the shared fixtures work in every mode.
// That the dev DB and server/src/public/static stay untouched is checked by run.mjs (DD C14),
// before and after the whole run, not here.
import { test, expect } from '../fixtures';
import { detectAuthMode } from '../helpers/auth-mode';
import { createApiKey } from '../helpers/api-key';
import { waitForQueueIdle } from '../helpers/queue';

test('stand smoke: health, auth mode, SPA @mode-a @mode-b @mode-c', async ({ stand, api, page }) => {
  await test.step('GET /health answers 200', async () => {
    const res = await api.get('/health');
    expect(res.status()).toBe(200);
  });

  await test.step('GET /api/v1/auth/config reports the mode the stand was started in', async () => {
    expect(await detectAuthMode(stand.url)).toBe(stand.authMode);
  });

  await test.step('the SPA loads and renders', async () => {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    await expect(page.locator('#root')).not.toBeEmpty();
  });
});

test('stand smoke: fixtures users, db, api key, queue @mode-a @mode-b @mode-c', async ({ stand, db, users, page }) => {
  const admin = await test.step('users.user("admin") opens a session with the admin role', async () => {
    const u = await users.user('admin');
    const me = await u.api.get('/api/v1/auth/me');
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ id: u.id, email: u.email, role: 'admin' });
    return u;
  });

  await test.step('users.user("user") gets the user role', async () => {
    const u = await users.user('user');
    const me = await u.api.get('/api/v1/auth/me');
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ email: u.email, role: 'user' });
  });

  await test.step('db reads the stand schema', async () => {
    const { rows } = await db.query<{ schema: string; n: string }>(
      'SELECT current_schema() AS schema, (SELECT count(*) FROM users) AS n',
    );
    expect(rows[0].schema).toBe(stand.schema);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  await test.step('createApiKey mints a key the API lists', async () => {
    const key = await createApiKey(admin.api);
    expect(key.key.length).toBeGreaterThan(10);
    const list = await admin.api.get('/api/v1/api-keys');
    expect(list.status()).toBe(200);
    expect((await list.json()) as Array<{ id: number }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: key.id })]),
    );
  });

  await test.step('waitForQueueIdle returns at once for a user with no uploads', async () => {
    expect(await waitForQueueIdle(db, admin.id, { timeoutMs: 2_000 })).toEqual({});
  });

  await test.step('signIn carries the session into the browser', async () => {
    await admin.signIn(page);
    await page.goto('/#/main');
    await expect(page).not.toHaveURL(/#\/login/);
    await expect(page.locator('#root')).not.toBeEmpty();
  });
});
