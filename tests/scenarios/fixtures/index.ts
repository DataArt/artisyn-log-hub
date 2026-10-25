/**
 * Scenario-suite fixtures (impl-plan DD C2, DD 2). Every spec under tests/scenarios imports
 * `test` / `expect` from here instead of from @playwright/test.
 *
 *  - `stand`  (worker) — the stand run.mjs started: { url, mode, authMode, schema }, from
 *                        STAND_URL / STAND_MODE / STAND_SCHEMA.
 *  - `db`     (worker) — a pg.Pool on DATABASE_URL whose search_path is the stand's schema.
 *  - `api`    (test)   — an anonymous APIRequestContext on the stand.
 *  - `users`  (test)   — `users.user(role)` creates a fresh user the way the mode allows:
 *                        A identify, B signup + Mailpit confirmation + login, C signup + login.
 *                        Users are `<role>-<runId>@arrakis.test`; the data-collection notice is
 *                        accepted for them unless `acceptNotice: false`.
 */
import { test as base, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import {
  DEFAULT_DATABASE_URL,
  MODES,
  SCENARIO_EMAIL_DOMAIN,
  type AuthMode,
  type StandMode,
} from '../modes';
import { timeoutScale } from '../../timeout-scale';
import { standMode } from '../helpers/auth-mode';
import { extractTokenFromEmailBody, findLatestMessageTo } from '../helpers/mailpit';
import { DATA_COLLECTION_NOTICE_SETTING, consentSettingValue } from '../helpers/notice-hash';

export interface Stand {
  url: string;
  mode: StandMode;
  authMode: AuthMode;
  schema: string;
  /**
   * Working dir of the stand process (STAND_RUN_DIR): its UPLOAD_QUEUE_DIR and
   * EXPORT_IMPORT_DIR live under it. Empty when the runner did not pass it.
   */
  runDir: string;
}

export type UserRole = 'admin' | 'user';

export interface ScenarioUser {
  id: number;
  email: string;
  /** Empty in mode A, which has no passwords. */
  password: string;
  role: UserRole;
  /** A request context holding this user's session cookie. */
  api: APIRequestContext;
  /** Copies the session cookie onto `page`'s browser context. */
  signIn(page: Page): Promise<void>;
}

export interface CreateUserOptions {
  /** Local-part prefix instead of the role (still suffixed with the run id). */
  label?: string;
  /**
   * The exact e-mail to register, for a user who must exist under an address known before the
   * account is created (an invitation sent ahead of the first login). Overrides `label`.
   */
  email?: string;
  /** Accept the data-collection notice (default true), so the UI opens past the consent screen. */
  acceptNotice?: boolean;
}

export interface UserFactory {
  user(role?: UserRole, options?: CreateUserOptions): Promise<ScenarioUser>;
}

interface WorkerFixtures {
  stand: Stand;
  db: Pool;
}

interface TestFixtures {
  api: APIRequestContext;
  users: UserFactory;
  /** Auto fixture: scales every test.setTimeout() by LOG_HUB_TEST_TIMEOUT_SCALE. */
  scaleTimeouts: void;
}

const SCHEMA_RE = /^scn_[abc]_[0-9a-f]{8}$/;

function readStand(): Stand {
  const url = process.env.STAND_URL;
  const schema = process.env.STAND_SCHEMA ?? '';
  if (!url) {
    throw new Error('STAND_URL is not set — run the scenario suite through npm run test:scenarios.');
  }
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`STAND_SCHEMA "${schema}" is not a scenario schema — run through npm run test:scenarios.`);
  }
  const mode = standMode();
  return {
    url: url.replace(/\/+$/, ''),
    mode,
    authMode: MODES[mode].authMode,
    schema,
    runDir: process.env.STAND_RUN_DIR ?? '',
  };
}

/** A password every PASSWORD_POLICY accepts (`long`: 14+ chars, digit, punctuation, both cases). */
function scenarioPassword(): string {
  return `Scn-${randomBytes(6).toString('hex')}-Pass1!`;
}

async function expectOk(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string) {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()}): ${await res.text()}`);
}

interface PublicProfile {
  id: number;
  email: string;
  role: UserRole;
}

async function openSession(stand: Stand, ctx: APIRequestContext, email: string, password: string) {
  if (stand.authMode === 'none') {
    await expectOk(await ctx.post('/api/v1/auth/identify', { data: { email } }), `identify ${email}`);
    return;
  }

  // Signup in a throwaway context: in password mode it opens a session there, in
  // password-confirm it must not (bug K); either way the user's own context logs in below.
  const anon = await pwRequest.newContext({ baseURL: stand.url });
  try {
    const signup = await anon.post('/api/v1/auth/signup', {
      data: { email, password, passwordConfirm: password },
    });
    await expectOk(signup, `signup ${email}`);
    if (stand.authMode === 'password-confirm') {
      const token = extractTokenFromEmailBody(await findLatestMessageTo(email));
      await expectOk(await anon.post('/api/v1/auth/confirm-email', { data: { token } }), `confirm-email ${email}`);
    }
  } finally {
    await anon.dispose();
  }
  await expectOk(await loginPastBackoff(ctx, email, password), `login ${email}`);
}

/**
 * `POST /auth/login`, waiting out a login-backoff 429. In mode B the backoff also counts per
 * source IP, and every scenario calls from 127.0.0.1, so a scenario that just entered wrong
 * passwords (tagged `@backoff`) can leave a few seconds of delay on the address. A correct login
 * is never itself counted, so waiting `Retry-After` and retrying is enough.
 */
export async function loginPastBackoff(ctx: APIRequestContext, email: string, password: string) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await ctx.post('/api/v1/auth/login', { data: { email, password } });
    if (res.status() !== 429 || attempt >= 6) return res;
    const retryAfter = Number(res.headers()['retry-after']);
    const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000 + 250;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Specs call test.setTimeout(<ms>) with host timings; in a sandbox (LOG_HUB_TEST_TIMEOUT_SCALE)
  // those are multiplied too, so one variable relaxes every timeout of the suite.
  scaleTimeouts: [
    async ({}, use, testInfo) => {
      const scale = timeoutScale();
      if (scale !== 1) {
        const setTimeout = testInfo.setTimeout.bind(testInfo);
        testInfo.setTimeout = (ms: number) => setTimeout(ms * scale);
      }
      await use();
    },
    { auto: true },
  ],

  stand: [
    async ({}, use) => {
      await use(readStand());
    },
    { scope: 'worker' },
  ],

  db: [
    async ({ stand }, use) => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
        options: `-c search_path=${stand.schema}`,
        max: 4,
      });
      try {
        await use(pool);
      } finally {
        await pool.end();
      }
    },
    { scope: 'worker' },
  ],

  api: async ({ stand }, use) => {
    const ctx = await pwRequest.newContext({ baseURL: stand.url });
    try {
      await use(ctx);
    } finally {
      await ctx.dispose();
    }
  },

  users: async ({ stand, db }, use) => {
    const runId = randomBytes(4).toString('hex');
    const contexts: APIRequestContext[] = [];
    let seq = 0;

    const factory: UserFactory = {
      async user(role = 'user', { label, email: fixedEmail, acceptNotice = true } = {}) {
        seq += 1;
        const email =
          fixedEmail ?? `${label ?? role}-${runId}${seq > 1 ? `-${seq}` : ''}@${SCENARIO_EMAIL_DOMAIN}`;
        const password = stand.authMode === 'none' ? '' : scenarioPassword();
        const ctx = await pwRequest.newContext({ baseURL: stand.url });
        contexts.push(ctx);

        await openSession(stand, ctx, email, password);
        const me = await ctx.get('/api/v1/auth/me');
        await expectOk(me, `GET /auth/me as ${email}`);
        const profile = (await me.json()) as PublicProfile;

        // The first user of a fresh schema becomes admin; every other one is a plain user.
        // Scenarios ask for a role, so align it directly (no public endpoint can grant the first
        // admin, DD 1). Sessions re-read the user row per request, so the cookie stays valid.
        if (profile.role !== role) {
          await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, profile.id]);
        }

        if (acceptNotice) {
          const res = await ctx.put(`/api/v1/user-settings/${DATA_COLLECTION_NOTICE_SETTING}`, {
            data: { value: consentSettingValue() },
          });
          await expectOk(res, `accept data-collection notice for ${email}`);
        }

        return {
          id: profile.id,
          email,
          password,
          role,
          api: ctx,
          async signIn(page: Page) {
            const { cookies } = await ctx.storageState();
            await page.context().addCookies(cookies);
          },
        };
      },
    };

    try {
      await use(factory);
    } finally {
      await Promise.all(contexts.map((c) => c.dispose()));
    }
  },
});

export { expect };
