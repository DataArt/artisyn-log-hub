// S-AUTH-11. Strict-managed: the bootstrap admin, no self sign-up, admin-created users with
// emailed set-password links, forgot password, link lifetimes, no key without a password and the
// per-IP email limit (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-11; mode D,
// needs Mailpit).
//
// The stand (mode D) starts twice on the same schema before Playwright runs, so the one bootstrap
// email Mailpit holds for `stand.adminEmail` proves that the second start sent none.
//
// Email budget: strict-managed allows 20 anonymous "Forgot password?" calls per source IP per hour
// and 100 create user / resend link calls per administrator per hour, counted in the DB for all
// cluster workers — every call counts, even one answered 409 or 429. The anonymous forgot-password
// calls of steps 5–7 and 9 come from a loopback address of their own (Z), and step 8 uses two more
// fresh addresses (X, Y). Mailpit messages are always looked up by recipient, never counted in
// total. The DB keeps only sha256(token), so a step that edits a token row looks it up by hash.
//
// The scenario sets the bootstrap admin's password, so it can run once per stand (retries: 0).
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import { test, expect, loginPastBackoff } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import {
  extractLinkFromEmailBody,
  extractTokenFromEmailBody,
  listEmailsTo,
  type CapturedEmail,
} from '../helpers/mailpit';
import {
  loopbackClient,
  randomLoopbackAddress,
  retryAfterSeconds,
  type LoopbackClient,
} from '../helpers/loopback-client';
import { hashResetToken } from '../helpers/reset-tokens';
import { skipNewUserNudge } from '../helpers/teams';
import { loginViaUi } from '../helpers/ui-auth';
import { DATA_COLLECTION_NOTICE_SETTING, consentSettingValue } from '../helpers/notice-hash';

const BOOTSTRAP_SUBJECT = 'Set your Log Hub administrator password';
const SET_PASSWORD_SUBJECT = 'Set your Log Hub password';
const RESET_SUBJECT = 'Reset your password';
const INVALID_LINK_TEXT =
  'This link is invalid or has expired. Request a new one with "Forgot password?" on the login page.';
const RESET_LINK_MARKER = '/#/reset-password?token=';
const EMAIL_LIMIT_PER_HOUR = 20;

/** A password every PASSWORD_POLICY accepts (`long`: 14+ chars, digit, punctuation, both cases). */
function newPassword(): string {
  return `Scn-Set-${randomBytes(4).toString('hex')}!Pw1`;
}

/** Three distinct loopback source addresses (none is 127.0.0.1). */
function distinctLoopbackAddresses(count: number): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(randomLoopbackAddress());
  return [...out];
}

async function emailsWithSubject(email: string, subject: string, atLeast = 0): Promise<CapturedEmail[]> {
  // Wait for `atLeast` messages of this subject (other subjects to the same address may arrive too).
  const deadline = Date.now() + 10_000;
  for (;;) {
    const matching = (await listEmailsTo(email, { settleMs: atLeast > 0 ? 0 : 750 })).filter(
      (m) => m.subject === subject,
    );
    if (matching.length >= atLeast || Date.now() >= deadline) {
      if (atLeast > 0) {
        // Let a message that should not have been sent show up before the caller counts.
        await new Promise((resolve) => setTimeout(resolve, 750));
        return (await listEmailsTo(email, { settleMs: 0 })).filter((m) => m.subject === subject);
      }
      return matching;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The newest set-password / reset link emailed to `email` with `subject`. */
async function latestLink(email: string, subject: string, atLeast: number): Promise<{ url: string; token: string }> {
  const mails = await emailsWithSubject(email, subject, atLeast);
  expect(mails.length, `${subject} emails to ${email}`).toBeGreaterThanOrEqual(atLeast);
  const text = mails[0].text;
  return { url: extractLinkFromEmailBody(text, RESET_LINK_MARKER), token: extractTokenFromEmailBody(text) };
}

/** Moves every token of the user 61 s into the past, so the 60 s per-account cooldown is over. */
async function endCooldown(db: Pool, userId: number): Promise<void> {
  await db.query(
    `UPDATE password_reset_tokens SET created_at = created_at - interval '61 seconds' WHERE user_id = $1`,
    [userId],
  );
}

async function userIdOf(db: Pool, email: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
  expect(rows, `user row of ${email}`).toHaveLength(1);
  return rows[0].id;
}

async function setPasswordViaApi(api: APIRequestContext, token: string, password: string) {
  return api.post('/api/v1/auth/reset-password', { data: { token, password, passwordConfirm: password } });
}

/** Shifts the expiry of the token whose link carries `token` (the DB row holds its hash). */
async function ageToken(db: Pool, token: string, interval: string): Promise<void> {
  const res = await db.query(
    `UPDATE password_reset_tokens SET expires_at = expires_at - $2::interval WHERE token = $1`,
    [hashResetToken(token), interval],
  );
  expect(res.rowCount, 'the token row').toBe(1);
}

/** Fills the reset page `page` is on and submits it with `buttonName`. */
async function submitPasswordForm(page: Page, password: string, buttonName: string) {
  await page.getByPlaceholder('New password', { exact: true }).fill(password);
  await page.getByPlaceholder('Confirm new password', { exact: true }).fill(password);
  const response = page.waitForResponse((res) => res.url().includes('/api/v1/auth/reset-password'));
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  return response;
}

/** After a successful set: the page says so and its button leads to the login page. */
async function expectPasswordSetThenLogin(page: Page): Promise<void> {
  await expect(page.getByRole('status')).toContainText('Your password is set.');
  await page.getByRole('button', { name: 'Go to log in' }).click();
  await expect(page).toHaveURL(/#\/login/);
}

/** A request context logged in as `email` with the data-collection notice accepted. */
async function sessionOf(baseURL: string, email: string, password: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL });
  const login = await loginPastBackoff(ctx, email, password);
  expect(login.status(), `login ${email}`).toBe(200);
  const consent = await ctx.put(`/api/v1/user-settings/${DATA_COLLECTION_NOTICE_SETTING}`, {
    data: { value: consentSettingValue() },
  });
  expect(consent.ok(), `accept notice for ${email}`).toBe(true);
  return ctx;
}

interface CreateResult {
  id: number;
  email: string;
  role: 'admin' | 'user';
  teamId: number | null;
  email_delivery: 'sent' | 'failed';
}

test('@S-AUTH-11 strict-managed: bootstrap admin, admin-created users, set-password links, email limit @mode-d', async ({
  stand,
  api,
  db,
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const runId = randomBytes(4).toString('hex');
  const addr = (label: string) => `${label}-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
  const [addrZ, addrX, addrY] = distinctLoopbackAddresses(3);
  const anonZ: LoopbackClient = loopbackClient(stand.url, addrZ);
  const contexts: APIRequestContext[] = [];
  const track = (ctx: APIRequestContext) => {
    contexts.push(ctx);
    return ctx;
  };

  const adminEmail = stand.adminEmail;
  expect(adminEmail, 'STAND_ADMIN_EMAIL of the mode-D stand').not.toBe('');
  const adminPassword = newPassword();
  const userRow = (email: string) => page.getByRole('row').filter({ hasText: email });

  try {
    const adminApi = await test.step('1. bootstrap: one email after the restart, «Set your password», a weak password keeps the link, log in, /auth/config', async () => {
      const mails = await listEmailsTo(adminEmail, { atLeast: 1 });
      expect(mails, 'the second start of the stand sent no second bootstrap email').toHaveLength(1);
      expect(mails[0].subject).toBe(BOOTSTRAP_SUBJECT);
      expect(mails[0].text).toContain(`administrator of the Log Hub server at ${stand.url}`);
      const link = extractLinkFromEmailBody(mails[0].text, RESET_LINK_MARKER);
      expect(link.startsWith(`${stand.url}${RESET_LINK_MARKER}`)).toBe(true);
      expect(link).toContain('purpose=set');

      await page.goto(link);
      await expect(page.getByText('Set your password', { exact: true })).toBeVisible({ timeout: 15_000 });
      // The policy is shown before the first submit, and a too-weak password does not use the
      // one-time link up: the same link then takes a good password.
      await expect(page.getByText(/^Password must be at least/)).toBeVisible();
      expect((await submitPasswordForm(page, 'x', 'Set password')).status()).toBe(400);
      await expect(page.getByText(/^Password must be at least/).last()).toBeVisible();
      expect((await submitPasswordForm(page, adminPassword, 'Set password')).status()).toBe(200);
      await expectPasswordSetThenLogin(page);
      await expect(page.getByText(`Accounts are created by your administrator (${adminEmail})`)).toBeVisible();

      const ctx = track(await sessionOf(stand.url, adminEmail, adminPassword));
      const me = (await (await ctx.get('/api/v1/auth/me')).json()) as { email: string; role: string };
      expect(me).toMatchObject({ email: adminEmail, role: 'admin' });

      const config = (await (await api.get('/api/v1/auth/config')).json()) as Record<string, unknown>;
      expect(config).toMatchObject({
        mode: 'strict-managed',
        passwordResetAvailable: true,
        adminContactEmail: adminEmail,
      });
      expect(config.passwordRequirement).toMatch(/^must be at least/);
      return ctx;
    });

    await test.step('2. no signup: no «Sign up» link, «Forgot password?» shown, #/signup → #/login, routes 404', async () => {
      await page.goto('/#/login');
      await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Sign up' })).toHaveCount(0);
      await expect(page.getByText("Don't have an account?")).toHaveCount(0);

      await page.goto('/#/signup');
      await expect(page).toHaveURL(/#\/login/, { timeout: 15_000 });

      for (const path of ['/api/v1/auth/signup', '/api/v1/auth/confirm-email', '/api/v1/auth/resend-confirmation']) {
        const res = await api.post(path, {
          data: { email: addr('signup'), password: adminPassword, passwordConfirm: adminPassword, token: 'x' },
        });
        expect(res.status(), path).toBe(404);
      }
      expect(await listEmailsTo(addr('signup'))).toHaveLength(0);
    });

    const teamName = `Strict-${runId}`;
    const teamRes = await adminApi.post('/api/v1/teams', { data: { name: teamName } });
    expect(teamRes.status()).toBe(201);
    const teamId = ((await teamRes.json()) as { id: number }).id;

    const u1Email = addr('created-one');
    const u1Password = newPassword();
    const u1Api = await test.step('3. create user in the UI: notice, «Not set» + «Resend link», mail, set password, team member, «Set»', async () => {
      await skipNewUserNudge(page);
      await loginViaUi(page, adminEmail, adminPassword);
      await page.goto('/#/admin?tab=all-users');
      await expect(userRow(adminEmail)).toBeVisible({ timeout: 15_000 });

      await page.getByRole('button', { name: '+ Create user' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Create user', { exact: true })).toBeVisible();
      await dialog.getByLabel('Email').fill(u1Email);
      await dialog.getByLabel('Role').selectOption('user');
      await dialog.getByLabel('Team').selectOption({ label: teamName });
      const created = page.waitForResponse(
        (res) => res.url().endsWith('/api/v1/admin/users') && res.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Create & send' }).click();
      const createdRes = await created;
      expect(createdRes.status()).toBe(201);
      expect((await createdRes.json()) as CreateResult).toMatchObject({
        email: u1Email,
        role: 'user',
        teamId,
        email_delivery: 'sent',
      });
      await expect(page.getByTestId('admin-users-notice')).toContainText(`Set-password link sent to ${u1Email}`);
      await expect(userRow(u1Email).getByText('Not set', { exact: true })).toBeVisible();
      // The link just went out, so «Resend link» waits out the 60 s cooldown — also after a reload.
      await expect(userRow(u1Email).getByRole('button', { name: /Resend link \(\d+s\)/ })).toBeDisabled();
      await page.reload();
      await expect(userRow(u1Email).getByRole('button', { name: /Resend link \(\d+s\)/ })).toBeDisabled({
        timeout: 15_000,
      });

      const { url } = await latestLink(u1Email, SET_PASSWORD_SUBJECT, 1);
      expect(url).toContain('purpose=set');
      const other = await browser.newContext({ baseURL: stand.url });
      try {
        const otherPage = await other.newPage();
        await otherPage.goto(url);
        await expect(otherPage.getByText('Set your password', { exact: true })).toBeVisible({ timeout: 15_000 });
        expect((await submitPasswordForm(otherPage, u1Password, 'Set password')).status()).toBe(200);
        await expectPasswordSetThenLogin(otherPage);
      } finally {
        await other.close();
      }

      const ctx = track(await sessionOf(stand.url, u1Email, u1Password));
      const u1Id = await userIdOf(db, u1Email);
      const { rows } = await db.query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, u1Id]);
      expect(rows, `${u1Email} is a member of ${teamName}`).toHaveLength(1);

      await page.reload();
      await expect(userRow(u1Email).getByText('Set', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(userRow(u1Email).getByRole('button', { name: /Resend link/ })).toHaveCount(0);
      return ctx;
    });

    const u2Email = addr('created-two');
    const u2Id = await test.step('4. resend and refusals: 429 in 60 s, old link refused, 409s, 403 for a user, legacy route 404', async () => {
      const create = await adminApi.post('/api/v1/admin/users', { data: { email: u2Email } });
      expect(create.status()).toBe(201);
      const created = (await create.json()) as CreateResult;
      expect(created).toMatchObject({ email: u2Email, role: 'user', teamId: null, email_delivery: 'sent' });
      const first = await latestLink(u2Email, SET_PASSWORD_SUBJECT, 1);

      const early = await adminApi.post(`/api/v1/admin/users/${created.id}/password-link`);
      expect(early.status(), 'resend within 60 s').toBe(429);
      expect(Number(early.headers()['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await emailsWithSubject(u2Email, SET_PASSWORD_SUBJECT)).toHaveLength(1);

      await endCooldown(db, created.id);
      const resend = await adminApi.post(`/api/v1/admin/users/${created.id}/password-link`);
      expect(resend.status()).toBe(200);
      expect(await resend.json()).toEqual({ email_delivery: 'sent' });
      const second = await latestLink(u2Email, SET_PASSWORD_SUBJECT, 2);
      expect(second.token).not.toBe(first.token);

      const password = newPassword();
      expect((await setPasswordViaApi(api, first.token, password)).status(), 'the old link is retired').toBe(409);
      expect((await setPasswordViaApi(api, second.token, password)).status(), 'the new link works').toBe(200);

      const already = await adminApi.post(`/api/v1/admin/users/${created.id}/password-link`);
      expect(already.status()).toBe(409);
      expect(await already.json()).toMatchObject({ error: 'password_already_set' });

      const duplicate = await adminApi.post('/api/v1/admin/users', { data: { email: u2Email.toUpperCase() } });
      expect(duplicate.status()).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: 'email_already_registered' });
      expect(await emailsWithSubject(u2Email, SET_PASSWORD_SUBJECT)).toHaveLength(2);

      // A plain user: AdminGuard answers 403 before anything else (and before the email limiter).
      expect((await u1Api.post('/api/v1/admin/users', { data: { email: addr('by-user') } })).status()).toBe(403);
      expect((await u1Api.post(`/api/v1/admin/users/${created.id}/password-link`)).status()).toBe(403);

      // The copyable reset link of the other modes is off in strict-managed.
      expect((await adminApi.post(`/api/v1/users/${created.id}/reset-password-link`)).status()).toBe(404);
      return created.id;
    });

    const u3Email = addr('passwordless');
    await test.step('5. forgot: same 200 for a user, an unknown email, a password-less user and a cooldown; the admin link survives', async () => {
      const create = await adminApi.post('/api/v1/admin/users', { data: { email: u3Email } });
      expect(create.status()).toBe(201);
      const u3Id = ((await create.json()) as CreateResult).id;
      const adminLink = await latestLink(u3Email, SET_PASSWORD_SUBJECT, 1);
      await endCooldown(db, u2Id);
      await endCooldown(db, u3Id);

      const unknown = addr('nobody');
      const bodies: unknown[] = [];
      // The second u2 call falls in u2's 60 s cooldown: it must answer exactly like the others,
      // or the status would tell that the account exists.
      for (const email of [u2Email, unknown, u3Email, u2Email]) {
        const res = await anonZ.post('/api/v1/auth/forgot-password', { email });
        expect(res.status, `forgot ${email}`).toBe(200);
        bodies.push(res.body);
      }
      for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);

      expect(await emailsWithSubject(u2Email, RESET_SUBJECT, 1)).toHaveLength(1);
      expect(await listEmailsTo(unknown)).toHaveLength(0);
      // A password-less account gets the «set» wording, with the 1 h lifetime of a forgot link.
      const forgot = await latestLink(u3Email, SET_PASSWORD_SUBJECT, 2);
      expect(forgot.token).not.toBe(adminLink.token);
      expect(forgot.url).toContain('purpose=set');
      const [forgotMail] = await emailsWithSubject(u3Email, SET_PASSWORD_SUBJECT, 2);
      expect(forgotMail.text).toContain('valid for 1 hour');

      // The anonymous request did not cancel the administrator's 24 h link; using it retires the rest.
      const password = newPassword();
      expect((await setPasswordViaApi(api, adminLink.token, password)).status(), 'the admin link').toBe(200);
      expect((await setPasswordViaApi(api, forgot.token, newPassword())).status(), 'the forgot link').toBe(409);
      track(await sessionOf(stand.url, u3Email, password));
    });

    const u5Email = addr('expired');
    const u5Id = await test.step('6. lifetimes: 23 h old works, 24 h old refused (UI text, 410), forgot 1 h old refused, used refused', async () => {
      const u4Email = addr('almost-expired');
      const c4 = await adminApi.post('/api/v1/admin/users', { data: { email: u4Email } });
      expect(c4.status()).toBe(201);
      const u4Id = ((await c4.json()) as CreateResult).id;
      const l4 = await latestLink(u4Email, SET_PASSWORD_SUBJECT, 1);
      await ageToken(db, l4.token, '23 hours');
      const u4Password = newPassword();
      expect((await setPasswordViaApi(api, l4.token, u4Password)).status(), 'a set-password link lives 24 h').toBe(200);
      expect((await setPasswordViaApi(api, l4.token, newPassword())).status(), 'a used link').toBe(409);

      const c5 = await adminApi.post('/api/v1/admin/users', { data: { email: u5Email } });
      expect(c5.status()).toBe(201);
      const id5 = ((await c5.json()) as CreateResult).id;
      const l5 = await latestLink(u5Email, SET_PASSWORD_SUBJECT, 1);
      await ageToken(db, l5.token, '24 hours');
      const other = await browser.newContext({ baseURL: stand.url });
      try {
        const otherPage = await other.newPage();
        await otherPage.goto(l5.url);
        await expect(otherPage.getByText('Set your password', { exact: true })).toBeVisible({ timeout: 15_000 });
        expect((await submitPasswordForm(otherPage, newPassword(), 'Set password')).status()).toBe(410);
        await expect(otherPage.getByText(INVALID_LINK_TEXT)).toBeVisible();
        await expect(otherPage).toHaveURL(/#\/reset-password/);
      } finally {
        await other.close();
      }
      expect((await setPasswordViaApi(api, l5.token, newPassword())).status()).toBe(410);

      await endCooldown(db, u4Id);
      expect((await anonZ.post('/api/v1/auth/forgot-password', { email: u4Email })).status).toBe(200);
      const forgot = await latestLink(u4Email, RESET_SUBJECT, 1);
      await ageToken(db, forgot.token, '1 hour');
      expect((await setPasswordViaApi(api, forgot.token, newPassword())).status(), 'a forgot link lives 1 h').toBe(410);
      return id5;
    });

    await test.step('7. no password, no key: login 401, POST /api-keys without a session 401, key after the password', async () => {
      // From Z, not 127.0.0.1: a failed login feeds the per-IP login backoff.
      for (const password of [newPassword(), newPassword()]) {
        const res = await anonZ.post('/api/v1/auth/login', { email: u5Email, password });
        expect(res.status, 'login of a password-less user').toBe(401);
      }
      expect((await anonZ.post('/api/v1/api-keys', { name: `no-session-${runId}` })).status).toBe(401);

      // An anonymous forgot request does not hold up the administrator: «Resend link» right after
      // it is answered 200, not 429 (the cooldown counts only admin-issued links).
      await endCooldown(db, u5Id);
      expect((await anonZ.post('/api/v1/auth/forgot-password', { email: u5Email })).status).toBe(200);
      await latestLink(u5Email, SET_PASSWORD_SUBJECT, 2);
      const resend = await adminApi.post(`/api/v1/admin/users/${u5Id}/password-link`);
      expect(resend.status(), 'resend right after a forgot request').toBe(200);
      const { token } = await latestLink(u5Email, SET_PASSWORD_SUBJECT, 3);
      const password = newPassword();
      expect((await setPasswordViaApi(api, token, password)).status()).toBe(200);
      const ctx = track(await sessionOf(stand.url, u5Email, password));
      const key = await ctx.post('/api/v1/api-keys', { data: { name: `after-password-${runId}` } });
      expect(key.status()).toBe(201);
      expect(((await key.json()) as { key?: string }).key).toBeTruthy();
    });

    await test.step('8. email limit: 20 forgot calls from X → 200, the 21st → 429 + Retry-After and no mail; Y → 200', async () => {
      const clientX = loopbackClient(stand.url, addrX);
      for (let i = 1; i <= EMAIL_LIMIT_PER_HOUR; i += 1) {
        const res = await clientX.post('/api/v1/auth/forgot-password', { email: addr(`limit-${i}`) });
        expect(res.status, `forgot call ${i} from ${addrX}`).toBe(200);
      }
      // The 21st names a real account whose cooldown is over: without the limit it would be emailed.
      await endCooldown(db, u2Id);
      const before = (await emailsWithSubject(u2Email, RESET_SUBJECT)).length;
      const limited = await clientX.post('/api/v1/auth/forgot-password', { email: u2Email });
      expect(limited.status, `the 21st email-sending call from ${addrX}`).toBe(429);
      expect(retryAfterSeconds(limited)).toBeGreaterThanOrEqual(1);
      expect(await emailsWithSubject(u2Email, RESET_SUBJECT)).toHaveLength(before);

      const clientY = loopbackClient(stand.url, addrY);
      expect((await clientY.post('/api/v1/auth/forgot-password', { email: addr('limit-y') })).status).toBe(200);
    });

    await test.step('9. a mailbox that is not proven: session refused, login 403, forgot proves it; Members tab refuses an email with no account', async () => {
      // An account left unconfirmed (e.g. a sign-up from an earlier auth mode) counts for nothing
      // until a link mailed to it is used — neither an old session nor the right password lets it in.
      const u1Id = await userIdOf(db, u1Email);
      await db.query('UPDATE users SET email_confirmed_at = NULL WHERE id = $1', [u1Id]);
      expect((await u1Api.get('/api/v1/auth/me')).status(), 'the old session').toBe(401);
      const login = await anonZ.post('/api/v1/auth/login', { email: u1Email, password: u1Password });
      expect(login.status).toBe(403);
      expect(login.body).toMatchObject({ error: 'email_not_verified' });

      await endCooldown(db, u1Id);
      expect((await anonZ.post('/api/v1/auth/forgot-password', { email: u1Email })).status).toBe(200);
      const { token } = await latestLink(u1Email, RESET_SUBJECT, 1);
      const password = newPassword();
      expect((await setPasswordViaApi(api, token, password)).status()).toBe(200);
      track(await sessionOf(stand.url, u1Email, password));

      // Rename: an admin cannot rename themselves here (a typo would lock them out); renaming u3
      // clears its password and confirmation, so the new mailbox has to prove itself.
      const adminId = await userIdOf(db, adminEmail);
      const self = await adminApi.patch(`/api/v1/admin/users/${adminId}/email`, {
        data: { email: addr('admin-typo') },
      });
      expect(self.status()).toBe(400);
      expect(await self.json()).toMatchObject({ error: 'cannot_rename_self' });
      const u3Id = await userIdOf(db, u3Email);
      const renamedEmail = addr('renamed');
      const rename = await adminApi.patch(`/api/v1/admin/users/${u3Id}/email`, { data: { email: renamedEmail } });
      expect(rename.status()).toBe(200);
      const { rows: renamedRows } = await db.query<{ no_password: boolean; unverified: boolean }>(
        'SELECT password_hash IS NULL AS no_password, email_confirmed_at IS NULL AS unverified FROM users WHERE id = $1',
        [u3Id],
      );
      expect(renamedRows[0]).toEqual({ no_password: true, unverified: true });

      // The team owner (the admin) tries to add an email that has no account: a refusal that says
      // where accounts are made, and no "add them anyway" dialog (the server would refuse it).
      await page.goto(`/#/teams/${teamId}`);
      await page.getByPlaceholder('Email address').fill(addr('no-account'));
      await page.getByRole('button', { name: 'Invite', exact: true }).click();
      await expect(page.getByText(/no account yet — create it in Admin Panel → Users first/)).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  } finally {
    await Promise.all(contexts.map((c) => c.dispose()));
  }
});
