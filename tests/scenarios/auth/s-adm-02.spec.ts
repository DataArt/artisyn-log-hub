// S-ADM-02. An admin manages users: role, reset link, e-mail change, deletion
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-ADM-02; any mode → A and C, DD SC4).
//
// Mode-dependent steps: using the reset link (step 5) and logging in with the old/new e-mail
// (step 7) need passwords, so in mode A they are replaced by what that mode can observe — the
// renamed user's live session reads the new e-mail. The legacy `PATCH /api/v1/users/:id/role`
// route stays (DD 1, decision on G-3) and is only checked for its guard here.
//
// Code facts that differ from the design text:
//   - step 3: with one admin left, the last-admin rule fires on any demotion the caller asks for —
//     the caller cannot be the target («Cannot change your own role»), so it is checked by
//     demoting another (non-admin) user, which is what the code compares (`countAdmins() <= 1`);
//   - step 8: the delete dialog demands the target e-mail exactly, case included
//     (`ConfirmDialog.requiresTyping`); only the server compares case-insensitively, which is
//     checked through the API.
//
// Replaces:
//   - server/test/access-management.e2e-spec.ts («PATCH /users/:id/role» 6, «PATCH /admin/users/:id/email» 7)
//   - server/test/admin-panel.e2e-spec.ts («GET users», «PATCH role», ≈10)
//   - tests/e2e/admin-panel.spec.ts (Users, Reset Password: 2)
//   - client/src/viewer/__tests__/components/admin-users-tab.test.tsx (8)
//   - server/test/account-deletion.e2e-spec.ts (admin deletion block, 5 — with S-AUTH-09)
import { request as pwRequest } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect, loginPastBackoff } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { createApiKey } from '../helpers/api-key';
import { postSessionLog } from '../helpers/prompt-session';

const NEW_PASSWORD = 'Reset!Passw0rd#2468';

test('@S-ADM-02 admin manages users: role, reset link, e-mail change, deletion @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(150_000);
  const runId = randomBytes(4).toString('hex');
  const a1 = await users.user('admin', { label: 'adm2-a1' });
  const a2 = await users.user('admin', { label: 'adm2-a2' });
  const u1 = await users.user('user', { label: 'adm2-one' });
  const u2 = await users.user('user', { label: 'adm2-two' });
  const u3 = await users.user('user', { label: 'adm2-three' });
  const u4 = await users.user('user', { label: 'adm2-four' });
  const regular = await users.user('user', { label: 'adm2-regular' });
  const hasPasswords = stand.authMode !== 'none';
  const teamRes = await u1.api.post('/api/v1/teams', { data: { name: `OwnedBy-U1-${runId}` } });
  expect(teamRes.status()).toBe(201);
  const teamId = ((await teamRes.json()) as { id: number }).id;
  const u3Key = await createApiKey(u3.api);

  const row = (email: string) => page.getByRole('row').filter({ hasText: email });
  const dialog = page.getByRole('dialog');

  await a1.signIn(page);
  await page.goto('/#/admin?tab=all-users');
  await expect(row(u1.email)).toBeVisible({ timeout: 15_000 });

  await test.step('1. UI (A1): in A1’s own row the role and Delete buttons are disabled, with their hints', async () => {
    const own = row(a1.email);
    const roleButton = own.getByRole('button', { name: 'Revoke Admin' });
    const deleteButton = own.getByRole('button', { name: 'Delete', exact: true });
    await expect(roleButton).toBeDisabled();
    await expect(deleteButton).toBeDisabled();
    await roleButton.locator('xpath=..').hover();
    await expect(page.getByRole('tooltip')).toHaveText('Cannot revoke your own admin role');
    await page.keyboard.press('Escape');
    await deleteButton.locator('xpath=..').hover();
    await expect(
      page.getByRole('tooltip').filter({ hasText: 'Cannot delete your own account here — use the account menu' }),
    ).toHaveCount(1);
  });

  await test.step('2. UI: «Make Admin» for U1 (confirmed) → admin; «Revoke Admin» → user again', async () => {
    await row(u1.email).getByRole('button', { name: 'Make Admin' }).click();
    await expect(dialog.getByText('Grant admin role?')).toBeVisible();
    await expect(dialog.getByText(`Grant admin access to ${u1.email}?`)).toBeVisible();
    await dialog.getByRole('button', { name: 'Make Admin' }).click();
    await expect(row(u1.email).getByRole('cell', { name: 'admin', exact: true })).toBeVisible();

    await row(u1.email).getByRole('button', { name: 'Revoke Admin' }).click();
    await expect(dialog.getByText('Revoke admin role?')).toBeVisible();
    await expect(dialog.getByText(`Revoke admin access from ${u1.email}? They will lose all admin privileges.`)).toBeVisible();
    await dialog.getByRole('button', { name: 'Revoke Admin' }).click();
    await expect(row(u1.email).getByRole('cell', { name: 'user', exact: true })).toBeVisible();
    const { rows } = await db.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [u1.id]);
    expect(rows[0].role).toBe('user');
  });

  await test.step('3. API: own role → 400; demotion with one admin left → 400; unknown user → 404', async () => {
    const own = await a1.api.patch(`/api/v1/admin/users/${a1.id}/role`, { data: { role: 'user' } });
    expect(own.status()).toBe(400);
    expect(await own.text()).toContain('Cannot change your own role');

    const { rows } = await db.query<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND id <> $1", [a1.id]);
    const others = rows.map((r) => r.id);
    await db.query("UPDATE users SET role = 'user' WHERE id = ANY($1)", [others]);
    try {
      const last = await a1.api.patch(`/api/v1/admin/users/${u2.id}/role`, { data: { role: 'user' } });
      expect(last.status()).toBe(400);
      expect(await last.text()).toContain('Cannot remove the last admin');
    } finally {
      await db.query("UPDATE users SET role = 'admin' WHERE id = ANY($1)", [others]);
    }
    expect((await a1.api.patch('/api/v1/admin/users/2147483647/role', { data: { role: 'admin' } })).status()).toBe(404);
  });

  const resetToken = await test.step('4. UI: «Reset Password» for U2 → a link on the stand origin whose token is U2’s latest in the DB', async () => {
    await row(u2.email).getByRole('button', { name: 'Reset Password' }).click();
    await expect(dialog.getByText('Password Reset Link')).toBeVisible();
    await expect(dialog.getByText(`Reset link for ${u2.email}:`)).toBeVisible();
    const url = (await dialog.locator('code').textContent())?.trim() ?? '';
    const match = new RegExp(`^${stand.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#/reset-password\\?token=(.+)$`).exec(url);
    expect(match, url).not.toBeNull();
    const token = match![1];
    const { rows } = await db.query<{ token: string }>(
      'SELECT token FROM password_reset_tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [u2.id],
    );
    expect(rows[0].token).toBe(token);
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dialog).toHaveCount(0);
    return token;
  });

  if (hasPasswords) {
    await test.step('5. API (U2): the link sets a new password; it logs in, the old one does not; the link is single-use (409)', async () => {
      const reset = () =>
        api.post('/api/v1/auth/reset-password', {
          data: { token: resetToken, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD },
        });
      expect((await reset()).ok()).toBe(true);
      expect((await api.post('/api/v1/auth/login', { data: { email: u2.email, password: u2.password } })).status()).toBe(401);
      const fresh = await pwLogin(u2.email, NEW_PASSWORD);
      expect(fresh).toBe(200);
      expect((await reset()).status()).toBe(409);
    });
  }

  const renamed = `renamed-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
  await test.step('6. UI: «Rename Email» for U1 → the new e-mail, no password hash; U4’s e-mail → «Email already in use» (409)', async () => {
    await row(u1.email).getByRole('button', { name: 'Rename Email' }).click();
    await expect(dialog.getByText('Rename Email')).toBeVisible();
    await dialog.getByPlaceholder('new.email@example.com').fill(renamed);
    const response = page.waitForResponse((r) => r.url().includes(`/api/v1/admin/users/${u1.id}/email`));
    await dialog.getByRole('button', { name: 'Rename' }).click();
    const res = await response;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: u1.id, email: renamed });
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('password_hash');
    await expect(row(renamed)).toBeVisible();

    await row(renamed).getByRole('button', { name: 'Rename Email' }).click();
    await dialog.getByPlaceholder('new.email@example.com').fill(u4.email);
    const clash = page.waitForResponse((r) => r.url().includes(`/api/v1/admin/users/${u1.id}/email`));
    await dialog.getByRole('button', { name: 'Rename' }).click();
    expect((await clash).status()).toBe(409);
    await expect(dialog.getByText('Email already in use')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const { rows } = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [u1.id]);
    expect(rows[0].email).toBe(renamed);
  });

  await test.step('7. API: U1 is the same account under the new e-mail and still owns OwnedBy-U1', async () => {
    if (hasPasswords) {
      expect((await api.post('/api/v1/auth/login', { data: { email: u1.email, password: u1.password } })).status()).toBe(401);
      expect(await pwLogin(renamed, u1.password)).toBe(200);
    }
    const me = (await (await u1.api.get('/api/v1/auth/me')).json()) as { id: number; email: string };
    expect(me).toMatchObject({ id: u1.id, email: renamed });
    const teams = (await (await a1.api.get('/api/v1/admin/teams')).json()) as Array<{ id: number; ownerEmail: string }>;
    expect(teams.find((t) => t.id === teamId)?.ownerEmail).toBe(renamed);
  });

  await test.step('8. UI: «Delete» for U3 unlocks only for U3’s exact e-mail → 204, the row is gone', async () => {
    const mismatch = await a1.api.post(`/api/v1/admin/users/${u3.id}/delete`, { data: { confirmEmail: u4.email } });
    expect(mismatch.status()).toBe(400);

    await row(u3.email).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog.getByText("Delete this user's account?")).toBeVisible();
    const input = dialog.getByPlaceholder(`Type "${u3.email}" to confirm`);
    const confirm = dialog.getByRole('button', { name: 'Delete', exact: true });
    for (const typed of [u4.email, u3.email.toUpperCase()]) {
      await input.fill(typed);
      await expect(confirm, typed).toBeDisabled();
    }
    await input.fill(u3.email);
    await expect(confirm).toBeEnabled();
    const deleted = page.waitForResponse((r) => r.url().includes(`/api/v1/admin/users/${u3.id}/delete`));
    await confirm.click();
    expect((await deleted).status()).toBe(204);
    await expect(row(u3.email)).toHaveCount(0);
  });

  await test.step('9. API: U3 cannot log in, U3’s key → 401, U3 is not in the user list', async () => {
    if (hasPasswords) {
      expect((await api.post('/api/v1/auth/login', { data: { email: u3.email, password: u3.password } })).status()).toBe(401);
    }
    const me = await u3.api.get('/api/v1/auth/me');
    if (me.status() === 200) {
      // Mode A: a dead cookie on /auth/me is re-identified as another account, never as U3.
      expect(((await me.json()) as { id: number }).id).not.toBe(u3.id);
    } else {
      expect(me.status()).toBe(401);
    }
    const upload = await postSessionLog(
      api,
      { sessionId: `adm2-${runId}`, prompt: 'deleted user upload', repoUrl: `https://git.arrakis.test/scn/${runId}/adm2` },
      'artisyn',
      { 'X-API-Key': u3Key.key },
    );
    expect(upload.status()).toBe(401);
    const list = (await (await a1.api.get('/api/v1/admin/users')).json()) as Array<{ id: number }>;
    expect(list.map((u) => u.id)).not.toContain(u3.id);

    // The server side of the confirmation is case-insensitive.
    const caseInsensitive = await a1.api.post(`/api/v1/admin/users/${u4.id}/delete`, {
      data: { confirmEmail: u4.email.toUpperCase() },
    });
    expect(caseInsensitive.status()).toBe(204);
  });

  await test.step('10. API: REGULAR → 403 and anonymous → 401 on role, delete, reset link and the legacy role route', async () => {
    const calls: Array<[string, 'patch' | 'post', string, Record<string, unknown>]> = [
      ['admin role', 'patch', `/api/v1/admin/users/${a2.id}/role`, { role: 'user' }],
      ['admin delete', 'post', `/api/v1/admin/users/${a2.id}/delete`, { confirmEmail: a2.email }],
      ['reset link', 'post', `/api/v1/users/${a2.id}/reset-password-link`, {}],
      ['legacy role', 'patch', `/api/v1/users/${a2.id}/role`, { role: 'user' }],
    ];
    for (const [what, method, path, data] of calls) {
      expect((await regular.api[method](path, { data })).status(), `REGULAR ${what}`).toBe(403);
      expect((await api[method](path, { data })).status(), `anonymous ${what}`).toBe(401);
    }
    expect((await a2.api.get('/api/v1/auth/me')).status()).toBe(200);
  });

  await test.step('11. UI: «Filter by email…» with part of U2’s e-mail narrows the table to U2', async () => {
    await page.reload();
    await page.getByPlaceholder('Filter by email…').fill(u2.email.split('@')[0]);
    const dataRows = page.getByRole('row').filter({ has: page.getByRole('cell') });
    await expect(dataRows).toHaveCount(1);
    await expect(dataRows).toContainText(u2.email);
  });

  async function pwLogin(email: string, password: string): Promise<number> {
    const ctx = await pwRequest.newContext({ baseURL: stand.url });
    try {
      return (await loginPastBackoff(ctx, email, password)).status();
    } finally {
      await ctx.dispose();
    }
  }
});
