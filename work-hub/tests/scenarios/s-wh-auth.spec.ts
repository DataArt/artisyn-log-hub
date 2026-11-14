// @S-WH-01 — sign-in per auth mode (AC-6). Runs in every mode: the stand's mode decides which
// steps apply (a: identify-only; b: password + email confirmation; c: password).
import {
  expect,
  latestEmailText,
  test,
  TEST_PASSWORD,
  tokenFromEmail,
  uniqueEmail,
  watchOrigin,
  withDb,
} from './fixtures';

test('@S-WH-01 @mode-a @mode-b @mode-c sign-in per auth mode', async ({ browser, stand, api }) => {
  const context = await browser.newContext({ baseURL: stand.url });
  const offOrigin = watchOrigin(context, stand);
  const page = await context.newPage();

  await test.step('1. the login page shows the form of the mode', async () => {
    await page.goto('/#/login');
    const email = page.getByPlaceholder('Email');
    await expect(email).toBeVisible();
    if (stand.mode === 'a') {
      await expect(page.getByText('Enter your email to continue')).toBeVisible();
      await expect(page.getByPlaceholder('Password')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Sign up' })).toHaveCount(0);
    } else {
      await expect(page.getByPlaceholder('Password')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible();
    }
  });

  await test.step('2. the API answers 401 without a session cookie', async () => {
    const r = await api.get('/api/v1/workspaces');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'unauthorized' });
  });

  const email = uniqueEmail('auth');

  if (stand.mode === 'a') {
    await test.step('4. mode a: identify creates the user on first use', async () => {
      const before = await withDb(stand, (db) =>
        db.query('SELECT id FROM users WHERE email_key = $1', [email.toLowerCase()]),
      );
      expect(before.rowCount).toBe(0);
      expect((await api.get('/api/v1/auth/me')).status).toBe(401);

      await page.getByPlaceholder('Email').fill(email);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();

      // The browser's session answers /me with the identified user.
      const me = await page.evaluate(async () => {
        const r = await fetch('/api/v1/auth/me', { credentials: 'include' });
        return { status: r.status, body: (await r.json()) as { email: string } };
      });
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(email);

      const after = await withDb(stand, (db) =>
        db.query('SELECT id FROM users WHERE email_key = $1', [email.toLowerCase()]),
      );
      expect(after.rowCount).toBe(1);
      await expect(page.getByTestId('workspaces-empty')).toHaveText('No workspaces yet. Create one to start.');
    });
  } else {
    await test.step('3. sign up, then sign in', async () => {
      await page.getByRole('button', { name: 'Sign up' }).click();
      await expect(page).toHaveURL(/#\/signup/);
      await page.getByPlaceholder('Email').fill(email);
      await page.getByPlaceholder('Password', { exact: true }).fill(TEST_PASSWORD);
      await page.getByPlaceholder('Confirm password').fill(TEST_PASSWORD);
      await page.getByRole('button', { name: 'Sign up' }).click();

      if (stand.mode === 'b') {
        await expect(page.getByText('Check your email to confirm your account.')).toBeVisible({ timeout: 60_000 });
        // Not confirmed yet: the password does not sign in.
        const early = await api.post('/api/v1/auth/login', { email, password: TEST_PASSWORD });
        expect(early.status).not.toBe(200);

        const token = tokenFromEmail(await latestEmailText(stand, email), '#/confirm-email?token=');
        await page.goto(`/#/confirm-email?token=${encodeURIComponent(token)}`);
        await expect(page.getByText('Your email has been confirmed. You can now log in.')).toBeVisible({ timeout: 30_000 });
        await page.getByRole('button', { name: 'Back to log in' }).click();
        await expect(page).toHaveURL(/#\/login/);
        await page.getByPlaceholder('Email').fill(email);
        await page.getByPlaceholder('Password').fill(TEST_PASSWORD);
        await page.getByRole('button', { name: 'Log in' }).click();
      }

      // Mode c: signup signs the user in at once.
      await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
      await expect(page.getByTestId('workspaces-empty')).toBeVisible();

      // Logout, then the password signs in again.
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitem', { name: 'Logout' }).click();
      await expect(page).toHaveURL(/#\/login/);
      await page.getByPlaceholder('Email').fill(email);
      await page.getByPlaceholder('Password').fill(TEST_PASSWORD);
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
    });
  }

  expect(offOrigin, 'requests outside the stand origin').toEqual([]);
  await context.close();
});
