// Scripted Playwright for UI onboarding: headless chromium, one fresh
// context per user with a clipboard mock, signup → (login) → consent, the "Give Me String"
// one-liner, and an API-side role assertion.
import { createApiClient } from './api.mjs';
import { STAND_URL } from './config.mjs';

const UI_TIMEOUT_MS = 20000;
const NAV_TIMEOUT_MS = 30000;
const CONSENT_WAIT_MS = 5000;
const CONSENT_BUTTON = 'I understand and accept';
const CONSENT_SCREEN_TESTID = 'data-collection-consent-screen';
const GIVE_ME_STRING = 'Give Me String';
const AUTH_HASH_RE = /^#\/(login|signup)\b/;

/**
 * Lazily imports `chromium` from the repo-root `@playwright/test` devDependency, so modules
 * that only need the pure helpers (e.g. `parseOneLiner` in unit tests) never load Playwright.
 */
async function loadChromium() {
  const mod = await import('@playwright/test');
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  if (!chromium) throw new Error('@playwright/test does not export chromium');
  return chromium;
}

/** Launches headless chromium. The caller closes it. */
export async function launch({ headless = true } = {}) {
  const chromium = await loadChromium();
  return chromium.launch({ headless });
}

/**
 * A fresh, cookie-less context and page for one user, with `navigator.clipboard` mocked before
 * any navigation (pattern `tests/e2e/api-keys.spec.ts:53-60`): on an http:// origin chromium
 * blocks the real clipboard and the copy buttons would otherwise reject.
 * Returns { context, page }.
 */
export async function newUserContext(browser, { baseURL = STAND_URL } = {}) {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(''),
      },
      configurable: true,
    });
  });
  context.setDefaultTimeout(UI_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const page = await context.newPage();
  return { context, page };
}

function currentHash(page) {
  return new URL(page.url()).hash;
}

async function visibleText(locator) {
  try {
    if ((await locator.count()) === 0) return '';
    return ((await locator.first().textContent()) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Signs up through `#/signup`. In Mode 2 a successful signup logs the user in directly; when the
 * hash is still `#/login`/`#/signup` afterwards, logs in through `#/login`.
 * Returns { hashAfterSignup, loggedInVia: 'signup'|'login' }. Throws on a visible form error or a
 * "check your email" screen (which would mean the stand is not in password mode).
 */
export async function signup(page, { email, password }) {
  await page.goto('/#/signup');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  await page.locator('button[type=submit]').click();

  try {
    await page.waitForFunction(
      () =>
        !window.location.hash.startsWith('#/signup') ||
        document.querySelector('form .text-destructive') !== null ||
        /Check your email|temporary issue sending email/.test(document.body.innerText),
      null,
      { timeout: NAV_TIMEOUT_MS },
    );
  } catch {
    throw new Error(`signup as ${email}: the page never left #/signup (still at ${page.url()})`);
  }

  const hashAfterSignup = currentHash(page);
  if (hashAfterSignup.startsWith('#/signup')) {
    const formError = await visibleText(page.locator('form .text-destructive'));
    const body = await page.locator('body').innerText();
    if (/Check your email|temporary issue sending email/.test(body)) {
      throw new Error(`signup as ${email}: the stand asked for email confirmation — AUTH_MODE is not "password"`);
    }
    throw new Error(`signup as ${email} failed: ${formError || 'unknown form error'}`);
  }

  if (AUTH_HASH_RE.test(hashAfterSignup)) {
    await login(page, { email, password });
    return { hashAfterSignup, loggedInVia: 'login' };
  }
  return { hashAfterSignup, loggedInVia: 'signup' };
}

/** Logs in through `#/login` (pattern `tests/e2e/helpers/auth.ts:37-47`). */
export async function login(page, { email, password }) {
  await page.goto('/#/login');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.locator('button[type=submit]').click();
  try {
    await page.waitForFunction(() => !window.location.hash.startsWith('#/login'), null, {
      timeout: NAV_TIMEOUT_MS,
    });
  } catch {
    const formError = await visibleText(page.locator('form .text-destructive'));
    throw new Error(`login as ${email} failed${formError ? `: ${formError}` : ' (still on #/login)'}`);
  }
}

/**
 * Accepts the data-collection consent gate when it appears. Resolves true when it was shown and
 * accepted, false when no gate appeared. Throws when the gate stays after accepting.
 */
export async function acceptConsent(page, { waitMs = CONSENT_WAIT_MS } = {}) {
  const button = page.getByRole('button', { name: CONSENT_BUTTON });
  try {
    await button.waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    return false;
  }
  await button.click();
  try {
    await page.getByTestId(CONSENT_SCREEN_TESTID).waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
  } catch {
    throw new Error('data-collection consent screen still shown after pressing "I understand and accept"');
  }
  return true;
}

/**
 * Pure parser for the "Full Auto Install" one-liner
 * (`npx "<url>/static/artisyn-hooks-installer.tgz…" install --server-url "<url>" --api-key "<key>"`).
 * Accepts the raw text of the rendered element; the command is the line containing `--api-key`.
 * Returns { serverUrl, apiKey, command }; throws when either flag is missing.
 */
export function parseOneLiner(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('one-liner is empty');
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes('--api-key'));
  if (!line) throw new Error('one-liner has no --api-key flag');
  const flag = (name) => {
    const m = line.match(new RegExp(`--${name}(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|(\\S+))`));
    if (!m) return null;
    const value = m[1] ?? m[2] ?? m[3];
    return value && value.trim() !== '' ? value.trim() : null;
  };
  const serverUrl = flag('server-url');
  const apiKey = flag('api-key');
  if (!serverUrl) throw new Error('one-liner has no --server-url value');
  if (!apiKey) throw new Error('one-liner has no --api-key value');
  if (!/^npx\s/.test(line)) throw new Error(`one-liner does not start with npx: ${redactOneLiner(line)}`);
  return { serverUrl, apiKey, command: line };
}

/** The one-liner with its API key masked, for logs and the report. */
export function redactOneLiner(text) {
  return String(text).replace(/(--api-key(?:\s+|=))("[^"]*"|'[^']*'|\S+)/, '$1<redacted>');
}

/**
 * On `#/api-keys` presses "Give Me String" and reads the one-liner from the first `code`
 * element containing `--api-key` (`client/src/viewer/pages/api-keys/InstallTab.tsx:95-107`).
 * Returns parseOneLiner(text).
 */
export async function getOneLiner(page) {
  await page.goto('/#/api-keys');
  const button = page.getByRole('button', { name: GIVE_ME_STRING });
  await button.waitFor({ state: 'visible' });
  await button.click();
  const code = page.locator('code', { hasText: '--api-key' }).first();
  try {
    await code.waitFor({ state: 'visible' });
  } catch {
    throw new Error('"Give Me String" did not render a one-liner containing --api-key');
  }
  return parseOneLiner(((await code.textContent()) || '').trim());
}

/**
 * Logs in through the REST API and asserts `GET /api/v1/auth/me` → `role`. This doubles as the
 * FR-5 "login works with no verification step" evidence. Returns the profile.
 */
export async function assertRole(email, password, role, { baseUrl = STAND_URL } = {}) {
  const api = createApiClient(baseUrl);
  await api.login(email, password);
  const me = await api.getJson('/api/v1/auth/me');
  if (!me || me.role !== role) {
    throw new Error(`${email}: expected role "${role}", got "${me ? me.role : 'no profile'}"`);
  }
  return me;
}
