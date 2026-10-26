// S-AUTH-07. The mode matrix: what exists in this auth mode and what answers 404
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-07; every mode: A, B, C).
//
// «Exists» means the route got past AuthModeGuard: any status but 404 (an empty body then
// answers 400/401, which is enough — no account is created or logged into). A route the mode does
// not know answers 404 (never 403), with or without a session.
//
// Secrets: the stand's environment is set by the runner, and the only secret value a scenario can
// know is the database URL (`DATABASE_URL`, shared with the `db` fixture); SMTP_PASSWORD and
// AZURE_CLIENT_SECRET are checked too when the runner's environment sets them. The bodies of
// `/auth/config` and `/admin/auth` must contain none of those values (checked by value, not by
// key name).
//
// Replaces:
//   - server/src/auth/guards/auth-mode.guard.spec.ts (3) — partly, see the design «Что теряем»
//   - server/src/auth/auth.controller.spec.ts (5, `GET config` without secrets)
//   - server/src/auth/auth.service.spec.ts (4, partly)
//   - server/test/admin-auth.e2e-spec.ts, «returns the config without secrets» (2)
//   Closes F.1 #2 (identify/azure = 404) and #10 (comparison with the real secret values).
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { DEFAULT_ADMIN_CONTACT_EMAIL, DEFAULT_DATABASE_URL, SCENARIO_EMAIL_DOMAIN, type AuthMode } from '../modes';

type Call = { method: 'GET' | 'POST'; path: string };

const MODE_ROUTES: Record<string, Call> = {
  identify: { method: 'POST', path: '/api/v1/auth/identify' },
  signup: { method: 'POST', path: '/api/v1/auth/signup' },
  login: { method: 'POST', path: '/api/v1/auth/login' },
  'confirm-email': { method: 'POST', path: '/api/v1/auth/confirm-email' },
  'resend-confirmation': { method: 'POST', path: '/api/v1/auth/resend-confirmation' },
  'forgot-password': { method: 'POST', path: '/api/v1/auth/forgot-password' },
  'reset-password': { method: 'POST', path: '/api/v1/auth/reset-password' },
  'change-password': { method: 'POST', path: '/api/v1/auth/change-password' },
  azure: { method: 'GET', path: '/api/v1/auth/azure' },
  'azure-callback': { method: 'GET', path: '/api/auth/callback' },
};

/** Routes that exist in each mode (`@AllowedAuthModes` in auth.controller.ts / azure-callback.controller.ts). */
const EXISTS: Record<AuthMode, readonly string[]> = {
  none: ['identify'],
  password: ['signup', 'login', 'forgot-password', 'reset-password', 'change-password'],
  'password-confirm': [
    'signup',
    'login',
    'confirm-email',
    'resend-confirmation',
    'forgot-password',
    'reset-password',
    'change-password',
  ],
};

/** Routes without `@AllowedAuthModes`: alive in every mode. */
const EVERY_MODE: Call[] = [
  { method: 'GET', path: '/api/v1/auth/config' },
  { method: 'GET', path: '/api/v1/auth/me' },
  { method: 'POST', path: '/api/v1/auth/logout' },
];

function call(ctx: APIRequestContext, { method, path }: Call) {
  return method === 'GET' ? ctx.get(path, { maxRedirects: 0 }) : ctx.post(path, { data: {}, maxRedirects: 0 });
}

/** Secret values the stand really runs with and the scenario can know. */
function knownSecrets(): string[] {
  const values: string[] = [];
  const dbUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  values.push(dbUrl);
  const dbPassword = decodeURIComponent(new URL(dbUrl).password);
  // A two-letter dev password such as the default `pw` would match unrelated text.
  if (dbPassword.length >= 4) values.push(dbPassword);
  for (const name of ['SMTP_PASSWORD', 'AZURE_CLIENT_SECRET']) {
    const value = process.env[name];
    if (value && value.length >= 4) values.push(value);
  }
  return values;
}

test('@S-AUTH-07 mode matrix: what exists in this mode and what answers 404 @mode-a @mode-b @mode-c', async ({
  stand,
  api,
  db,
  users,
}) => {
  const admin = await users.user('admin');
  const member = await users.user('user');
  const secrets = knownSecrets();
  const expectNoSecrets = (text: string, what: string) => {
    for (const secret of secrets) expect(text.includes(secret), `${what} leaks a secret value`).toBe(false);
  };

  await test.step('1. without a cookie: GET /auth/config → 200 with the mode and no secret', async () => {
    const res = await api.get('/api/v1/auth/config');
    expect(res.status()).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.mode).toBe(stand.authMode);
    expect(body).not.toHaveProperty('azure');
    // adminContactEmail belongs to the password modes only, and is present when configured:
    // the runner sets ADMIN_CONTACT_EMAIL in mode B (required there), not in C.
    if (stand.authMode === 'none') {
      expect(body).not.toHaveProperty('adminContactEmail');
    } else if (stand.authMode === 'password-confirm') {
      expect(body.adminContactEmail).toBe(DEFAULT_ADMIN_CONTACT_EMAIL);
    }
    // passwordResetAvailable belongs to the password modes only: B runs with Mailpit as its
    // relay (true), C runs without SMTP_HOST (false, reset unavailable).
    if (stand.authMode === 'none') {
      expect(body).not.toHaveProperty('passwordResetAvailable');
    } else {
      expect(body.passwordResetAvailable).toBe(stand.authMode === 'password-confirm');
    }
    expectNoSecrets(text, 'GET /api/v1/auth/config');
  });

  await test.step('2. every mode-specific route, without and with a session: exists or 404', async () => {
    const exists = new Set(EXISTS[stand.authMode]);
    // A fresh context per call: in mode A an anonymous /auth/me logs the context in (AutoIdentifyGuard).
    for (const [name, route] of Object.entries(MODE_ROUTES)) {
      for (const who of ['anonymous', 'member'] as const) {
        const ctx = who === 'member' ? member.api : await pwRequest.newContext({ baseURL: stand.url });
        try {
          const status = (await call(ctx, route)).status();
          if (exists.has(name)) {
            expect(status, `${name} (${who}) must exist in ${stand.authMode}`).not.toBe(404);
          } else {
            expect(status, `${name} (${who}) must be 404 in ${stand.authMode}`).toBe(404);
          }
        } finally {
          if (who === 'anonymous') await ctx.dispose();
        }
      }
    }
    for (const route of EVERY_MODE) {
      const ctx = await pwRequest.newContext({ baseURL: stand.url });
      try {
        expect((await call(ctx, route)).status(), `${route.path} lives in every mode`).not.toBe(404);
      } finally {
        await ctx.dispose();
      }
    }
  });

  if (stand.authMode === 'none') {
    await test.step('2. mode none: identify from localhost with a new e-mail → 200', async () => {
      const ctx = await pwRequest.newContext({ baseURL: stand.url });
      try {
        const email = `matrix-${randomBytes(4).toString('hex')}@${SCENARIO_EMAIL_DOMAIN}`;
        const res = await ctx.post('/api/v1/auth/identify', { data: { email } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toMatchObject({ email });
      } finally {
        await ctx.dispose();
      }
    });
  }

  await test.step('3–4. ADMIN: GET /admin/auth → the mode and only non-secret fields', async () => {
    const res = await admin.api.get('/api/v1/admin/auth');
    expect(res.status()).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { mode?: string; smtp?: Record<string, unknown>; azure?: unknown };
    expect(body.mode).toBe(stand.authMode);
    expect(body.azure).toBeUndefined();
    // No SMTP card without a relay: mode A never uses SMTP, mode C runs without SMTP_HOST.
    if (stand.authMode !== 'password-confirm') {
      expect(body.smtp).toBeUndefined();
    } else {
      expect(Object.keys(body.smtp ?? {}).sort()).toEqual(['from', 'host', 'port']);
    }
    expectNoSecrets(text, 'GET /api/v1/admin/auth');
  });

  if (stand.authMode === 'password') {
    await test.step('4a. mode password without SMTP: forgot-password → email_delivery «failed», no reset token', async () => {
      const anonymous = await pwRequest.newContext({ baseURL: stand.url });
      try {
        const res = await anonymous.post('/api/v1/auth/forgot-password', { data: { email: member.email } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ email_delivery: 'failed' });
      } finally {
        await anonymous.dispose();
      }
      const { rows } = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM password_reset_tokens WHERE user_id = $1',
        [member.id],
      );
      expect(rows[0].n).toBe('0');
    });
  }

  await test.step('5. public resources answer without a session; /ping needs one', async () => {
    for (const path of ['/health', '/health/version', '/api/v1/model-pricing', '/static/artisyn-hooks-installer.tgz']) {
      expect((await api.get(path)).status(), path).toBe(200);
    }
    const anonymous = await pwRequest.newContext({ baseURL: stand.url });
    try {
      expect((await anonymous.get('/api/v1/ping')).status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
    expect((await member.api.get('/api/v1/ping')).status()).toBe(204);
  });
});
