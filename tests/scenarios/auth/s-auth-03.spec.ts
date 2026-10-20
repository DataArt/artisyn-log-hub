// S-AUTH-03. Login, logout, a live and a dead session, form errors, the password policy
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-03; mode B, PASSWORD_POLICY=long).
//
// Tagged @backoff (impl-plan DD C2): steps 1–2 enter wrong credentials from 127.0.0.1, which feeds
// the per-IP login backoff, so mode B runs this scenario on its own stand together with S-AUTH-06.
//
// Code facts that differ from the design text:
//   - the 429 body carries only `{ statusCode, message }`; the wait is in the `Retry-After` header;
//   - only the active policy level (`long`) is checked here; the table test
//     `server/src/auth/utils/password-policy.algo.spec.ts` (rows in
//     docs/knowledgebase/algorithms/password-policy.md) keeps the boundaries of all three levels
//     (design «Что теряем»).
//
// Replaces:
//   - server/test/auth.e2e-spec.ts (≈17: signup/login/logout/me/ping, «Full session flow»)
//   - tests/e2e/auth-guard.spec.ts (2, mocked answers → the live steps 10–11)
//   - client/src/viewer/__tests__/components/login-page.test.tsx (11)
//   - client/src/viewer/__tests__/components/MainNav.test.tsx (10, menu items per mode)
//   (server/src/auth/utils/password-policy.spec.ts was folded into the password-policy table test)
import { request as pwRequest } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { createApiKey } from '../helpers/api-key';
import { uploadGolden } from '../helpers/golden';
import { loginViaUi, navigateInApp, openUserMenu, submitLoginForm } from '../helpers/ui-auth';

const INVALID = 'Invalid email or password.';

test('@S-AUTH-03 login, logout, live and dead session, form errors, password policy @mode-b @backoff', async ({
  stand,
  db,
  api,
  users,
  page,
}) => {
  test.setTimeout(180_000);
  const p = await users.user('user', { label: 'login' });
  const p2 = await users.user('user', { label: 'login-other' });
  const runId = randomBytes(4).toString('hex');

  await test.step('1–2. UI: a wrong password and an unknown e-mail give the same banner, both 401', async () => {
    await page.goto('/#/login');
    for (const [email, password] of [
      [p.email, `${p.password}-wrong`],
      [`nobody-${runId}@${SCENARIO_EMAIL_DOMAIN}`, p.password],
    ]) {
      const response = page.waitForResponse((r) => r.url().includes('/api/v1/auth/login'));
      await submitLoginForm(page, email, password);
      expect((await response).status()).toBe(401);
      await expect(page.getByText(INVALID, { exact: true })).toBeVisible();
    }
  });

  await test.step('3. UI: the right credentials leave /login; /auth/me has email, role, env_name and no hash', async () => {
    // The two failures above put a 1 s per-IP delay on 127.0.0.1; loginViaUi waits it out.
    await loginViaUi(page, p.email, p.password);
    await expect(page).not.toHaveURL(/#\/login/);
    const me = await page.request.get('/api/v1/auth/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ email: p.email, role: 'user' });
    expect(typeof body.env_name).toBe('string');
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('password_hash');
  });

  const deadCookies = await test.step('4. UI: the account menu has Change password, Delete account, Log out; Log out → /#/login', async () => {
    const { cookies } = await page.context().storageState();
    const menu = await openUserMenu(page, p.email);
    await expect(menu.getByRole('menuitem')).toHaveText(['Change password', 'Delete account', 'Log out']);
    await menu.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/#\/login/);
    return cookies;
  });

  await test.step('5. API without a cookie: /auth/me 401, /auth/logout 401', async () => {
    expect((await api.get('/api/v1/auth/me')).status()).toBe(401);
    expect((await api.post('/api/v1/auth/logout')).status()).toBe(401);
  });

  await test.step('6. UI: Back and /#/teams after logout land on /#/login; the old cookie is dead', async () => {
    await page.goBack();
    await page.goto('/#/teams');
    await expect(page).toHaveURL(/#\/login/);
    const replay = await pwRequest.newContext({ baseURL: stand.url, storageState: { cookies: deadCookies, origins: [] } });
    try {
      expect((await replay.get('/api/v1/auth/me')).status()).toBe(401);
    } finally {
      await replay.dispose();
    }
  });

  await test.step('7. UI: a plain user opening /#/admin is sent to /#/main and has no Admin Panel link', async () => {
    await loginViaUi(page, p.email, p.password);
    await page.goto('/#/admin');
    await expect(page).toHaveURL(/#\/main/);
    await expect(page.getByText('Admin Panel')).toHaveCount(0);
  });

  await test.step('8. API: login and signup again from a logged-in context → 400', async () => {
    const login = await page.request.post('/api/v1/auth/login', { data: { email: p.email, password: p.password } });
    expect(login.status()).toBe(400);
    const signup = await page.request.post('/api/v1/auth/signup', {
      data: { email: `again-${runId}@${SCENARIO_EMAIL_DOMAIN}`, password: p.password, passwordConfirm: p.password },
    });
    expect(signup.status()).toBe(400);
  });

  await test.step('9. API: signup form errors and the `long` policy boundaries', async () => {
    const signup = (email: string | undefined, password: string, passwordConfirm = password) =>
      api.post('/api/v1/auth/signup', {
        data: email === undefined ? { password, passwordConfirm } : { email, password, passwordConfirm },
      });
    const fresh = (tag: string) => `policy-${tag}-${runId}@${SCENARIO_EMAIL_DOMAIN}`;

    const weak = await signup(fresh('weak'), 'short1234');
    expect(weak.status()).toBe(400);
    expect(await weak.json()).toMatchObject({ error: 'weak_password' });

    expect((await signup(fresh('long'), `Aa1!${'x'.repeat(125)}`)).status()).toBe(400); // 129 chars
    expect((await signup(fresh('empty'), '')).status()).toBe(400);
    expect((await signup(undefined, 'Str0ng!Passw0rd#1')).status()).toBe(400);

    const mismatch = await signup(fresh('mismatch'), 'Str0ng!Passw0rd#1', 'Str0ng!Passw0rd#2');
    expect(mismatch.status()).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: 'password_mismatch' });

    const noPunctuation = await signup(fresh('nopunct'), 'Abcdefghijk1234'); // 15 chars, no punctuation
    expect(noPunctuation.status()).toBe(400);
    expect(await noPunctuation.json()).toMatchObject({ error: 'weak_password' });

    const accepted = await signup(fresh('ok'), 'Str0ng!Passw0rd#1');
    expect(accepted.status()).toBe(201);
  });

  await test.step('10. UI: logging out in a second tab sends the first tab to /#/login on its next action', async () => {
    await page.goto('/#/main');
    const second = await page.context().newPage();
    try {
      await second.goto('/#/main');
      const menu = await openUserMenu(second, p.email);
      await menu.getByRole('menuitem', { name: 'Log out' }).click();
      await expect(second).toHaveURL(/#\/login/);
    } finally {
      await second.close();
    }
    await navigateInApp(page, '#/teams');
    await expect(page).toHaveURL(/#\/login/, { timeout: 15_000 });
  });

  await test.step('11. UI: a 403 on a foreign repository keeps the person logged in («No access»)', async () => {
    const key = await createApiKey(p2.api);
    await uploadGolden(p2.api, key.key, 'gs-01', { queue: { db, userId: p2.id } });
    const repos = (await (await p2.api.get('/api/v1/repositories')).json()) as Array<{ id: number }>;
    expect(repos.length).toBeGreaterThan(0);

    await loginViaUi(page, p.email, p.password);
    await page.goto(`/#/repos/${repos[0].id}`);
    await expect(page.getByText('No access', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`#/repos/${repos[0].id}`));
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200);
  });
});
