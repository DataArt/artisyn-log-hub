// S-AUTH-01. A new person signs up, confirms the e-mail from the letter and logs in
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-01; mode B, needs Mailpit).
//
// Owner decision (2026-10-13, bug K): in password-confirm, signup opens NO session — the person
// only sees «Check your email», `GET /auth/me` is 401 and the app sends them to the login page.
//
// Replaces:
//   - tests/e2e/email-confirmation-mailpit.spec.ts (1)
//   - server/test/auth-email-confirmation.e2e-spec.ts (12: unconfirmed cannot log in, 400/410/409,
//     resend invalidates, cooldown, no account enumeration; the two-confirm race stays a unit)
//   - client/src/viewer/__tests__/components/confirm-email-page.test.tsx (5)
//   - client/src/viewer/__tests__/components/signup-page.test.tsx (7, except «client does not
//     enforce minLength»)
//   - server/test/auth.e2e-spec.ts, signup block (≈8: success, case-insensitive duplicate,
//     mismatch, too long, empty fields, already authenticated — the last four in S-AUTH-03)
import { randomBytes } from 'crypto';
import { request as pwRequest } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { extractLinkFromEmailBody, extractTokenFromEmailBody, listEmailsTo } from '../helpers/mailpit';
import { loginViaUi } from '../helpers/ui-auth';

const PASSWORD = 'Str0ng!Passw0rd#1';

test('@S-AUTH-01 a new person signs up, confirms the e-mail from the letter and logs in @mode-b', async ({
  stand,
  db,
  api,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const runId = randomBytes(4).toString('hex');
  const email = `new-${runId}@${SCENARIO_EMAIL_DOMAIN}`;

  await test.step('precondition: an admin already exists, so the newcomer is a plain user', async () => {
    await users.user('admin');
  });

  const usersCount = async () => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM users')).rows[0].n);
  const signupCalls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/auth/signup')) signupCalls.push(req.method());
  });

  await test.step('1. UI: /#/signup with a typo in «Confirm password» → «Passwords do not match.», nothing sent', async () => {
    const before = await usersCount();
    await page.goto('/#/signup');
    await page.getByPlaceholder('Email', { exact: true }).fill(email);
    await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
    await page.getByPlaceholder('Confirm password', { exact: true }).fill(`${PASSWORD}x`);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByText('Passwords do not match.')).toBeVisible();
    expect(signupCalls).toEqual([]);
    expect(await usersCount()).toBe(before);
  });

  await test.step('2–3. UI: fix the confirmation, «Sign up» → «Check your email to confirm your account.»', async () => {
    await page.getByPlaceholder('Confirm password', { exact: true }).fill(PASSWORD);
    const signupResponse = page.waitForResponse((r) => r.url().includes('/api/v1/auth/signup'));
    await page.getByRole('button', { name: 'Sign up' }).click();
    const res = await signupResponse;
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ email, role: 'user', email_delivery: 'sent' });
    await expect(page.getByText('Check your email to confirm your account.')).toBeVisible();
  });

  await test.step('4. no session after signup: /auth/me is 401, the app sends the person to the login page', async () => {
    // The browser that just signed up holds no authenticated session (bug K, fixed in Chunk 5).
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    const fresh = await pwRequest.newContext({ baseURL: stand.url });
    try {
      expect((await fresh.get('/api/v1/auth/me')).status()).toBe(401);
    } finally {
      await fresh.dispose();
    }
    await page.goto('/#/main');
    await page.reload();
    await expect(page).toHaveURL(/#\/login/);
  });

  await test.step('4. API: login with the right password before confirming → 403 email_not_confirmed', async () => {
    const res = await api.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'email_not_confirmed' });
  });

  const tokens = await test.step('5. API: resend twice → 200 sent, then 429 with Retry-After; Mailpit holds exactly 2 letters', async () => {
    // Signup itself issued a token, so the 60 s per-account cooldown runs from it; move it into
    // the past instead of waiting a real minute.
    await db.query(
      `UPDATE email_confirmation_tokens SET created_at = now() - interval '61 seconds'
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
    const first = await api.post('/api/v1/auth/resend-confirmation', { data: { email } });
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ email_delivery: 'sent' });

    const second = await api.post('/api/v1/auth/resend-confirmation', { data: { email } });
    expect(second.status()).toBe(429);
    const retryAfter = Number(second.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const letters = await listEmailsTo(email, { atLeast: 2 });
    expect(letters).toHaveLength(2);
    for (const letter of letters) expect(letter.subject).toBe('Confirm your email address');
    // Mailpit lists newest first: [resend, signup].
    return { fromResend: extractTokenFromEmailBody(letters[0].text), fromSignup: extractTokenFromEmailBody(letters[1].text), letters };
  });

  await test.step('5. resend for an address nobody registered answers the same and sends nothing', async () => {
    const nobody = `nobody-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
    const res = await api.post('/api/v1/auth/resend-confirmation', { data: { email: nobody } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ email_delivery: 'sent' });
    expect(await listEmailsTo(nobody)).toHaveLength(0);
  });

  const link = await test.step('6. the link in the letter points at the stand origin and carries #/', async () => {
    const url = extractLinkFromEmailBody(tokens.letters[0].text, '/#/confirm-email?token=');
    expect(url.startsWith(`${stand.url}/#/confirm-email?token=`)).toBe(true);
    expect(url).not.toContain('localhost:5173');
    return url;
  });

  await test.step('5. the letter from before the resend no longer works (its token was invalidated)', async () => {
    const res = await api.post('/api/v1/auth/confirm-email', { data: { token: tokens.fromSignup } });
    expect(res.status()).toBe(409);
  });

  await test.step('extra: an expired confirmation token → 410 and «This confirmation link has expired…»', async () => {
    const expired = `expired-${randomBytes(16).toString('hex')}`;
    await db.query(
      `INSERT INTO email_confirmation_tokens (user_id, token, expires_at)
       VALUES ((SELECT id FROM users WHERE lower(email) = lower($1)), $2, now() - interval '1 hour')`,
      [email, expired],
    );
    const res = await api.post('/api/v1/auth/confirm-email', { data: { token: expired } });
    expect(res.status()).toBe(410);
    await page.goto(`/#/confirm-email?token=${expired}`);
    await expect(page.getByText('This confirmation link has expired. Please request a new one.')).toBeVisible();
  });

  await test.step('7. UI: open the link from the letter → confirmed; email_confirmed_at is set', async () => {
    // «Confirming your email…» is shown only while the request is in flight, too briefly to
    // assert reliably; the outcome is what the person reads.
    await page.goto(link);
    await expect(page.getByText('Your email has been confirmed. You can now log in.')).toBeVisible();
    const { rows } = await db.query<{ confirmed: Date | null }>(
      'SELECT email_confirmed_at AS confirmed FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    expect(rows[0].confirmed).not.toBeNull();
  });

  await test.step('8. UI: the same link again → «This email address has already been confirmed.» (API 409)', async () => {
    await page.goto('/#/main');
    await page.goto(link);
    await expect(page.getByText('This email address has already been confirmed.')).toBeVisible();
    const res = await api.post('/api/v1/auth/confirm-email', { data: { token: tokens.fromResend } });
    expect(res.status()).toBe(409);
  });

  await test.step('9. UI: a garbage token and no token → «This confirmation link is invalid.» (API 400)', async () => {
    for (const path of ['/#/confirm-email?token=garbage', '/#/confirm-email']) {
      await page.goto('/#/main');
      await page.goto(path);
      await expect(page.getByText('Confirm your email', { exact: true })).toBeVisible();
      await expect(page.getByText('This confirmation link is invalid.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back to log in' })).toBeVisible();
    }
    const res = await api.post('/api/v1/auth/confirm-email', { data: { token: 'garbage' } });
    expect(res.status()).toBe(400);
  });

  await test.step('10. UI: log in with the e-mail and password → off /login, the e-mail is in the top bar', async () => {
    await page.goto('/#/login');
    await loginViaUi(page, email, PASSWORD);
    await expect(page).not.toHaveURL(/#\/login/);
    // A brand-new account has not accepted the data-collection notice yet (S-AUTH-02).
    await page.getByRole('button', { name: 'I understand and accept' }).click();
    await expect(page.getByRole('button', { name: email })).toBeVisible();
    const me = await page.request.get('/api/v1/auth/me');
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ email, role: 'user' });
  });

  await test.step('11. API: signup with the same e-mail in another case → 409', async () => {
    const shouted = email.toUpperCase().replace(`@${SCENARIO_EMAIL_DOMAIN.toUpperCase()}`, '@Arrakis.Test');
    const res = await api.post('/api/v1/auth/signup', {
      data: { email: shouted, password: PASSWORD, passwordConfirm: PASSWORD },
    });
    expect(res.status()).toBe(409);
  });
});
