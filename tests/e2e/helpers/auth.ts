/**
 * auth.ts — shared authentication helpers for e2e specs.
 *
 * Part of the e2e shared-helper suite.
 *
 *  - login(page, creds)      → the genuine UI login flow (fill + submit + wait).
 *                              Extracted verbatim from the per-spec login(page)
 *                              implementations. Keep this for auth-flow tests and
 *                              the global storageState setup; other specs should
 *                              use a saved storageState instead of logging in.
 *  - ensureUser(request, cr) → idempotent signup + login via the API. Tolerates
 *                              "already exists" / "already authenticated", then
 *                              logs in so the request context carries a session
 *                              cookie. Returns the parsed /login body (user info).
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { isNoAuthMode } from './auth-mode';
import { ROLES, type Creds } from './credentials';
import { getLatestConfirmationTokenForEmail } from './db';

/**
 * Genuine UI login: navigate to the hash-router login route, fill the form,
 * submit, and wait until the router leaves #/login.
 *
 * Still a real UI flow under Mode 1: LoginPage renders `IdentifyForm` (an
 * email-only prompt) instead of the email+password form when the server
 * reports `mode: 'none'`, so the only difference here is that there is no
 * password field to fill.
 *
 * CAVEAT — Mode 1 only, once the DB already has users (i.e. always, on this
 * repo's shared long-lived dev server): do not use this as a bootstrap step
 * for "I just need an authenticated page". `AutoIdentifyGuard` beats this
 * function to the punch — see `establishSession()` above for the full
 * mechanism and why. This helper stays correct and usable for genuine
 * password/password-confirm-mode login-flow tests.
 */
export async function login(page: Page, creds: Creds = ROLES.primary): Promise<void> {
  await page.goto('/#/login');
  await page.fill('input[type="email"]', creds.email);
  if (!isNoAuthMode()) {
    await page.fill('input[type="password"]', creds.password);
  }
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.hash.startsWith('#/login'), {
    timeout: 10_000,
  });
}

/**
 * Establishes an authenticated session on `page` via the API, without driving
 * the UI login/identify form — copies the session cookie `ensureUser()`
 * establishes on `request` straight onto `page.context()`.
 *
 * Use this whenever a test needs an authenticated page but is not itself
 * testing the login/identify form. Under Mode 1 (`AUTH_MODE=none`),
 * `AutoIdentifyGuard` intercepts every unauthenticated localhost request —
 * including the SPA's own unconditional `Bootstrap` → `fetchMe()` call that
 * runs on every page load, `/login` included. The moment that fetch resolves,
 * the guard has already logged the browser in as whichever existing user
 * `autoIdentifyMode1()` picks (the sole user, or `id=1` once more than one
 * exists) — not necessarily the role this call was asked for — and
 * `LoginPage`'s `if (user != null) return <Navigate to="/main"/>` fires
 * before a scripted `page.fill('input[type="email"]', ...)` ever gets a
 * chance to run. This is not a rare race: the local fetch resolves in
 * milliseconds, well inside any locator timeout, so it reproduces every time
 * once the shared dev DB already has users — which it always does outside a
 * from-scratch fresh DB. `login()` below is therefore unreliable as a
 * bootstrap step for any role under Mode 1; establishing the session via the
 * API sidesteps the race entirely and guarantees the correct identity, in
 * every `AUTH_MODE`.
 */
export async function establishSession(
  page: Page,
  request: APIRequestContext,
  creds: Creds,
): Promise<void> {
  await ensureUser(request, creds);
  const { cookies } = await request.storageState();
  await page.context().addCookies(cookies);
}

/**
 * Mode 1 session bootstrap: `POST /auth/identify { email }` opens a session on
 * the given context and creates the account if it does not exist yet. Naturally
 * idempotent — a second call for the same email just re-logs-in the existing
 * user. Localhost-only server-side, which every e2e run is.
 */
export async function identifyUser(
  request: APIRequestContext,
  creds: Creds,
): Promise<Record<string, unknown>> {
  // MUST no-op when this context is already the requested user. A file-level
  // `test.use({ storageState })` is inherited by `pwRequest.newContext()` (see
  // session-raw-logs.spec.ts:123), so seeding contexts routinely arrive holding
  // the role's shared session cookie. Passport regenerates the session inside
  // logIn(), which DELETEs the old sid — re-identifying here would therefore
  // destroy the storageState session that every later spec using that role
  // depends on, and they would all land on the login page.
  //
  // Mode 2 cannot hit this: LocalAuthGuard rejects /auth/login outright on an
  // already-authenticated request, leaving the session untouched. /auth/identify
  // has no such guard, so the equivalent protection lives here.
  const me = await request.get('/api/v1/auth/me');
  if (me.ok()) {
    const profile = (await me.json()) as { email?: string };
    if (
      typeof profile.email === 'string' &&
      profile.email.toLowerCase() === creds.email.toLowerCase()
    ) {
      return profile as Record<string, unknown>;
    }
  }

  const resp = await request.post('/api/v1/auth/identify', {
    data: { email: creds.email },
  });
  if (!resp.ok()) {
    throw new Error(
      `Identify failed for ${creds.email} (${resp.status()}): ${await resp.text()}`,
    );
  }
  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Idempotent signup + login via the API on the given request context.
 *
 * Signup may 400 ("Already authenticated") or 409 ("already exists") on repeat
 * runs — both are tolerated. The subsequent login establishes / refreshes the
 * session cookie on `request`. Auth is cookie-based (SessionAuthGuard), so the
 * returned value is informational; the useful side-effect is the cookie now set
 * on the provided context.
 */
export async function ensureUser(
  request: APIRequestContext,
  creds: Creds,
): Promise<Record<string, unknown>> {
  // Mode 1 has neither signup nor login (both 404 via AuthModeGuard). A single
  // localhost-only /auth/identify call both auto-provisions the account and
  // opens the session, making the whole signup → confirm → login dance below
  // inapplicable rather than merely unnecessary.
  if (isNoAuthMode()) {
    return identifyUser(request, creds);
  }

  // Signup — tolerate "already exists" / "already authenticated".
  const signupResp = await request.post('/api/v1/auth/signup', {
    data: {
      email: creds.email,
      password: creds.password,
      passwordConfirm: creds.password,
    },
  });
  if (!signupResp.ok()) {
    const body = await signupResp.text();
    const tolerated =
      signupResp.status() === 409 ||
      signupResp.status() === 400 ||
      /already/i.test(body);
    if (!tolerated) {
      throw new Error(
        `Signup failed for ${creds.email} (${signupResp.status()}): ${body}`,
      );
    }
  }

  // Under AUTH_MODE=password-confirm, login 403s (email_not_confirmed)
  // until the account is confirmed. DB-read, not Mailpit — this is the
  // generic "get a session" bootstrap, not a test about the email flow
  // itself. No-ops under any other AUTH_MODE, or once the account is
  // already confirmed from a prior run.
  let confirmToken = await getLatestConfirmationTokenForEmail(creds.email);
  if (!confirmToken) {
    // No token at all — either this really is a fresh signup under a
    // non-password-confirm mode (nothing to do), or this is an account that
    // predates email confirmation entirely (created before email_confirmation_tokens
    // existed) and so has no token row despite being unconfirmed. Request
    // one via resend-confirmation, which issues a fresh token for any
    // existing unconfirmed account — a no-op 200 if the account doesn't
    // need confirming at all.
    await request.post('/api/v1/auth/resend-confirmation', {
      data: { email: creds.email },
    });
    confirmToken = await getLatestConfirmationTokenForEmail(creds.email);
  }
  if (confirmToken) {
    await request.post('/api/v1/auth/confirm-email', {
      data: { token: confirmToken },
    });
  }

  // Login — establishes the session cookie on this request context.
  const loginResp = await request.post('/api/v1/auth/login', {
    data: { email: creds.email, password: creds.password },
  });
  if (!loginResp.ok()) {
    const body = await loginResp.text();
    // Signup may have already authenticated this context.
    if (!/already authenticated/i.test(body)) {
      throw new Error(
        `Login failed for ${creds.email} (${loginResp.status()}): ${body}`,
      );
    }
  }

  try {
    return (await loginResp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
