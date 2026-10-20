// S-AUTH-06. Password guessing runs into a growing delay
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-06; mode B — the backoff is off
// under NODE_ENV=test — on the separate @backoff stand of impl-plan DD C2).
//
// The backoff (server/src/auth/login-backoff.service.ts) counts per account and per source IP;
// the applied delay is max(account, ip), and the n-th failure blocks for n-1 seconds. To measure
// the schedule exactly, the API steps run from loopback addresses nobody else uses
// (helpers/loopback-client.ts): X is the attacker, Z and Y are fresh addresses that isolate the
// account dimension. Only the UI step 9 uses 127.0.0.1, and it only needs «some» delay.
//
// Code fact that differs from the design text: the 429 body is `{ statusCode, message }`; the
// wait is carried by the `Retry-After` header only.
//
// Replaces:
//   (server/src/auth/login-backoff.service.spec.ts was folded into the login-backoff table test:
//   docs/knowledgebase/algorithms/login-backoff.md, login-backoff.service.algo.spec.ts)
//   - client/src/viewer/__tests__/components/login-page.test.tsx, the 429 part (≈3)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { loopbackClient, retryAfterSeconds, type LoopbackResponse } from '../helpers/loopback-client';
import { submitLoginForm } from '../helpers/ui-auth';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits out a `Retry-After` with a small margin. */
const waitOut = (seconds: number) => sleep(seconds * 1000 + 300);

test('@S-AUTH-06 password guessing runs into a growing delay @mode-b @backoff', async ({ stand, users, page }) => {
  test.setTimeout(120_000);
  const v = await users.user('user', { label: 'victim' });
  const w = await users.user('user', { label: 'witness' });
  const u = await users.user('user', { label: 'ui-guess' });
  const x = loopbackClient(stand.url);
  const login = (client: ReturnType<typeof loopbackClient>, email: string, password: string) =>
    client.post('/api/v1/auth/login', { email, password });
  const wrong = `${v.password}-wrong`;
  const expect429 = (res: LoopbackResponse, seconds?: number) => {
    expect(res.status).toBe(429);
    if (seconds === undefined) expect(retryAfterSeconds(res)).toBeGreaterThanOrEqual(1);
    else expect(retryAfterSeconds(res)).toBe(seconds);
  };

  await test.step('1–2. two wrong passwords for V: both 401, the 1st costs nothing, the 2nd sets 1 s', async () => {
    expect((await login(x, v.email, wrong)).status).toBe(401);
    expect((await login(x, v.email, wrong)).status).toBe(401);
  });

  await test.step('3. the right password at once → 429 with Retry-After: 1 (checked before the password)', async () => {
    expect429(await login(x, v.email, v.password), 1);
  });

  await test.step('4. another case and spaces from a fresh address → still 429; a blocked try does not extend the wait', async () => {
    const z = loopbackClient(stand.url);
    const shouted = `  ${v.email.toUpperCase()} `;
    const first = await login(z, shouted, wrong);
    expect429(first);
    const second = await login(z, shouted, wrong);
    expect429(second);
    expect(retryAfterSeconds(second)).toBeLessThanOrEqual(retryAfterSeconds(first));
  });

  await test.step('5. after the wait the 3rd wrong password → 401, then at once → 429 with Retry-After: 2', async () => {
    await waitOut(1);
    expect((await login(x, v.email, wrong)).status).toBe(401);
    expect429(await login(x, v.email, wrong), 2);
  });

  await test.step('6. after the wait the right password → 200, and V’s account counter starts over', async () => {
    await waitOut(2);
    expect((await login(x, v.email, v.password)).status).toBe(200);
    // From a fresh address only the account dimension can block: two wrong passwords in a row
    // both reach the password check (401), which means the account counter is back at zero.
    const y = loopbackClient(stand.url);
    expect((await login(y, v.email, wrong)).status).toBe(401);
    expect((await login(y, v.email, wrong)).status).toBe(401);
  });

  const ipWait = await test.step('7. V’s success did not reset X’s IP counter: one more failure there blocks W, another account', async () => {
    // X already has 3 failures; a 4th (for an address nobody registered, so no account delay)
    // puts a 3 s delay on X alone. Had V's success cleared the IP counter, it would cost nothing.
    const nobody = `nobody-${randomBytes(4).toString('hex')}@${SCENARIO_EMAIL_DOMAIN}`;
    expect((await login(x, nobody, wrong)).status).toBe(401);
    const blocked = await login(x, w.email, w.password);
    expect429(blocked, 3);
    return retryAfterSeconds(blocked);
  });

  await test.step('8. once the IP delay is over, W logs in from X', async () => {
    await waitOut(ipWait);
    expect((await login(x, w.email, w.password)).status).toBe(200);
  });

  await test.step('9. UI: wrong passwords on /#/login → «Too many attempts», the button waits Retry-After seconds', async () => {
    await page.goto('/#/login');
    const banner = page.getByRole('alert').filter({ hasText: 'Too many attempts' });
    const button = page.getByRole('button', { name: 'Log in', exact: true });
    // The 2nd wrong password at the latest (earlier if 127.0.0.1 already carries failures) is
    // answered 429 on the next try.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = page.waitForResponse((r) => r.url().includes('/api/v1/auth/login'));
      await submitLoginForm(page, u.email, `${u.password}-wrong`);
      if ((await response).status() === 429) break;
    }
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Please wait \d+s before trying again\./);
    await expect(button).toBeDisabled();
    await expect(button).toBeEnabled({ timeout: 15_000 });
    await expect(banner).toHaveCount(0);
  });
});
