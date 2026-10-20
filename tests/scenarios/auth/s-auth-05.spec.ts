// S-AUTH-05. Changing the password in one browser throws the other one out
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-05; mode B, needs Mailpit).
//
// The old-password login of step 7 goes out from a loopback address of its own
// (helpers/loopback-client.ts) so it does not feed the per-IP backoff of 127.0.0.1.
// Only the `sent` notification is checked; `failed`/`skipped` need a stand without SMTP.
//
// Replaces:
//   - server/test/auth-change-password.e2e-spec.ts (7)
//   - client/src/viewer/__tests__/components/change-password-modal.test.tsx (10)
import { test, expect, loginPastBackoff } from '../fixtures';
import { listEmailsTo } from '../helpers/mailpit';
import { loopbackClient } from '../helpers/loopback-client';
import { navigateInApp, openUserMenu } from '../helpers/ui-auth';

const NEW_PASSWORD = 'New!Passw0rd#5678';

test('@S-AUTH-05 changing the password in one browser throws the other one out @mode-b', async ({
  stand,
  users,
  browser,
}) => {
  test.setTimeout(120_000);
  const c = await users.user('user', { label: 'chpw' });

  const ctxA = await browser.newContext({ baseURL: stand.url });
  const ctxB = await browser.newContext({ baseURL: stand.url });
  try {
    const [pageA, pageB] = await test.step('1. C logs in in two independent browsers A and B', async () => {
      for (const ctx of [ctxA, ctxB]) {
        const res = await loginPastBackoff(ctx.request, c.email, c.password);
        expect(res.status()).toBe(200);
      }
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      for (const page of [a, b]) {
        await page.goto('/#/main');
        await expect(page.getByRole('button', { name: c.email })).toBeVisible({ timeout: 15_000 });
      }
      return [a, b];
    });

    const dialog = pageA.getByRole('dialog');
    const submit = () => dialog.getByRole('button', { name: 'Change password' }).click();
    const fill = async (current: string, next: string, confirm: string) => {
      await dialog.getByLabel('Current password').fill(current);
      await dialog.getByLabel('New password', { exact: true }).fill(next);
      await dialog.getByLabel('Confirm new password').fill(confirm);
    };
    const changeCalls: number[] = [];
    pageA.on('response', (res) => {
      if (res.url().includes('/api/v1/auth/change-password')) changeCalls.push(res.status());
    });

    await test.step('2. UI in A: a wrong current password → «Current password is incorrect.» (403), A stays in', async () => {
      const menu = await openUserMenu(pageA, c.email);
      await menu.getByRole('menuitem', { name: 'Change password' }).click();
      await expect(dialog).toBeVisible();
      await fill(`${c.password}-wrong`, NEW_PASSWORD, NEW_PASSWORD);
      await submit();
      await expect(dialog.getByText('Current password is incorrect.')).toBeVisible();
      expect(changeCalls).toEqual([403]);
      await expect(pageA).not.toHaveURL(/#\/login/);
    });

    await test.step('3. UI in A: a weak new password → the server policy error', async () => {
      await fill(c.password, 'short1234', 'short1234');
      await submit();
      await expect(dialog.getByText(/at least 14 characters/)).toBeVisible();
      expect(changeCalls).toEqual([403, 400]);
    });

    await test.step('4. UI in A: new and confirmation differ → «New passwords do not match.», nothing sent', async () => {
      await fill(c.password, NEW_PASSWORD, `${NEW_PASSWORD}x`);
      await submit();
      await expect(dialog.getByText('New passwords do not match.')).toBeVisible();
      expect(changeCalls).toEqual([403, 400]);
    });

    await test.step('5. UI in A: the right values → «Password changed», «Sent to <e-mail>»', async () => {
      await fill(c.password, NEW_PASSWORD, NEW_PASSWORD);
      await submit();
      await expect(dialog.getByText('Password changed')).toBeVisible();
      await expect(dialog.getByText(`Sent to ${c.email}`)).toBeVisible();
      expect(changeCalls).toEqual([403, 400, 200]);
      await pageA.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });

    await test.step('6. UI: B is sent to /#/login on its next click, A keeps working', async () => {
      await navigateInApp(pageB, '#/teams');
      await expect(pageB).toHaveURL(/#\/login/, { timeout: 15_000 });
      await navigateInApp(pageA, '#/teams');
      await expect(pageA).toHaveURL(/#\/teams/);
      expect((await ctxA.request.get('/api/v1/auth/me')).status()).toBe(200);
    });

    await test.step('7. API: the old password 401, the new one 200', async () => {
      const client = loopbackClient(stand.url);
      expect((await client.post('/api/v1/auth/login', { email: c.email, password: c.password })).status).toBe(401);
      expect((await client.post('/api/v1/auth/login', { email: c.email, password: NEW_PASSWORD })).status).toBe(200);
    });

    await test.step('8. Mailpit: the «Your password was changed» letter reached C', async () => {
      const letters = await listEmailsTo(c.email, { atLeast: 2 });
      expect(letters.map((m) => m.subject)).toContain('Your password was changed');
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
