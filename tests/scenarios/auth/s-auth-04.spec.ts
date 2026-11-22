// S-AUTH-04. Forgot password: the letter, a new password, reused and expired links
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-04; mode B, needs Mailpit).
//
// The wrong-password login of step 6 is sent from a loopback address of its own
// (helpers/loopback-client.ts), so it does not feed the per-IP backoff of 127.0.0.1 that every
// other mode-B scenario logs in from.
//
// A weak or mismatched new password does NOT burn the reset token: the server checks the token,
// then the passwords, and only then uses the token up (step 8).
//
// Replaces:
//   - tests/e2e/password-reset.spec.ts (1)
//   - tests/e2e/password-reset-mailpit.spec.ts (1)
//   - server/test/password-reset.e2e-spec.ts (14)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { extractLinkFromEmailBody, extractTokenFromEmailBody, listEmailsTo } from '../helpers/mailpit';
import { loopbackClient } from '../helpers/loopback-client';
import { seedResetToken } from '../helpers/reset-tokens';

const NEW_PASSWORD = 'New!Passw0rd#5678';
const FORGOT_INTRO = /send you a link to reset your password/;

test('@S-AUTH-04 forgot password: the letter, a new password, reused and expired links @mode-b', async ({
  stand,
  db,
  api,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const r = await users.user('user', { label: 'reset' });
  const runId = randomBytes(4).toString('hex');
  const resetLetters = async (opts?: { atLeast?: number }) =>
    (await listEmailsTo(r.email, opts)).filter((m) => m.subject === 'Reset your password');

  await test.step('1. UI: «Forgot password?» → e-mail → the neutral message; exactly one letter', async () => {
    await page.goto('/#/login');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/#\/forgot-password/);
    // The page is lazy-loaded: wait for it, or the fill can still hit the login form's Email field.
    await expect(page.getByText(FORGOT_INTRO)).toBeVisible();
    await page.getByPlaceholder('Email', { exact: true }).fill(r.email);
    const response = page.waitForResponse((res) => res.url().includes('/api/v1/auth/forgot-password'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByText('If that email is registered, a reset link has been sent.')).toBeVisible();
    expect(await resetLetters({ atLeast: 1 })).toHaveLength(1);
  });

  await test.step('2. UI: asking again at once → the same 200 as for any email (the cooldown is not revealed), the same message, no second letter', async () => {
    await page.goto('/#/login');
    await page.goto('/#/forgot-password');
    await expect(page.getByText(FORGOT_INTRO)).toBeVisible();
    await page.getByPlaceholder('Email', { exact: true }).fill(r.email);
    const response = page.waitForResponse((res) => res.url().includes('/api/v1/auth/forgot-password'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const res = await response;
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ email_delivery: 'sent' });
    await expect(page.getByText('If that email is registered, a reset link has been sent.')).toBeVisible();
    expect(await resetLetters()).toHaveLength(1);
  });

  await test.step('3. API: an unknown address gets the same 200 and no letter', async () => {
    const nobody = `nobody-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
    const res = await api.post('/api/v1/auth/forgot-password', { data: { email: nobody } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ email_delivery: 'sent' });
    expect(await listEmailsTo(nobody)).toHaveLength(0);
  });

  const { link, token: t1 } = await test.step('4. Mailpit: the link is built from the stand origin with #/reset-password?token=', async () => {
    const [letter] = await resetLetters({ atLeast: 1 });
    const url = extractLinkFromEmailBody(letter.text, '/#/reset-password?token=');
    expect(url.startsWith(`${stand.url}/#/reset-password?token=`)).toBe(true);
    return { link: url, token: extractTokenFromEmailBody(letter.text) };
  });

  await test.step('5. UI: a mismatched confirmation is refused, the right one resets, says so and leads to /#/login', async () => {
    await page.goto(link);
    await page.getByPlaceholder('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByPlaceholder('Confirm new password', { exact: true }).fill(`${NEW_PASSWORD}x`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText('Passwords do not match.')).toBeVisible();

    await page.getByPlaceholder('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
    const response = page.waitForResponse((res) => res.url().includes('/api/v1/auth/reset-password'));
    await page.getByRole('button', { name: 'Reset password' }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('status')).toContainText('Your password was changed.');
    await page.getByRole('button', { name: 'Go to log in' }).click();
    await expect(page).toHaveURL(/#\/login/);
  });

  await test.step('6. API: the old password is refused (401), the new one works (200)', async () => {
    const client = loopbackClient(stand.url);
    expect((await client.post('/api/v1/auth/login', { email: r.email, password: r.password })).status).toBe(401);
    expect((await client.post('/api/v1/auth/login', { email: r.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  await test.step('7. API: the used token again → 409', async () => {
    const res = await api.post('/api/v1/auth/reset-password', {
      data: { token: t1, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD },
    });
    expect(res.status()).toBe(409);
  });

  await test.step('8. API: unknown token 400; weak password 400 weak_password; mismatch 400 password_mismatch', async () => {
    const unknown = await api.post('/api/v1/auth/reset-password', {
      data: { token: `unknown-${runId}`, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD },
    });
    expect(unknown.status()).toBe(400);
    // A different error than the two password errors below, so the client can tell them apart.
    const unknownError = ((await unknown.json()) as { error?: string }).error;
    expect(['weak_password', 'password_mismatch']).not.toContain(unknownError);

    const weakToken = await seedResetToken(db, r.id, '1 hour');
    const weak = await api.post('/api/v1/auth/reset-password', {
      data: { token: weakToken, password: 'short1234', passwordConfirm: 'short1234' },
    });
    expect(weak.status()).toBe(400);
    expect(await weak.json()).toMatchObject({ error: 'weak_password' });

    const mismatchToken = await seedResetToken(db, r.id, '1 hour');
    const mismatch = await api.post('/api/v1/auth/reset-password', {
      data: { token: mismatchToken, password: NEW_PASSWORD, passwordConfirm: `${NEW_PASSWORD}x` },
    });
    expect(mismatch.status()).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: 'password_mismatch' });

    // The failed attempts did not use the links up: the first retry succeeds, and its success
    // retires every other outstanding link of the account, so the second one answers 409.
    const retry = (token: string) =>
      api.post('/api/v1/auth/reset-password', {
        data: { token, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD },
      });
    expect((await retry(weakToken)).status()).toBe(200);
    expect((await retry(mismatchToken)).status()).toBe(409);
  });

  await test.step('8. UI: a reset link with an unknown token shows an error and stays on the page', async () => {
    await page.goto(`/#/reset-password?token=unknown-${runId}`);
    await page.getByPlaceholder('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByPlaceholder('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.locator('p.text-destructive')).toBeVisible();
    await expect(page).toHaveURL(/#\/reset-password/);
  });

  await test.step('9. DB: a token whose expires_at is in the past → 410', async () => {
    const expired = await seedResetToken(db, r.id, '-1 minute');
    const res = await api.post('/api/v1/auth/reset-password', {
      data: { token: expired, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD },
    });
    expect(res.status()).toBe(410);
  });

  await test.step('10. API: two simultaneous resets with one fresh token → exactly one 200 and one 409', async () => {
    const token = await seedResetToken(db, r.id, '1 hour');
    const body = { token, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD };
    const results = await Promise.all([
      api.post('/api/v1/auth/reset-password', { data: body }),
      api.post('/api/v1/auth/reset-password', { data: body }),
    ]);
    expect(results.map((res) => res.status()).sort()).toEqual([200, 409]);
  });
});
