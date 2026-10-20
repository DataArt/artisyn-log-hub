// S-REPO-05. Until the user accepts the data-collection notice they see neither the app nor any
// repository (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-05; no mode in the design →
// A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). Users are created with
// `acceptNotice: false`, so the consent row is missing exactly as for a person who just signed up.
//
// Code facts the steps pin:
//   - the consent gate is UI-only: `GET /api/v1/repositories` answers 200 before consent (step 4);
//   - the gate replaces the whole shell (`AppLayout` in client/src/main.tsx), so before consent no
//     `<nav>` exists and none of the shell's queries (`/api/v1/repositories`, `/api/v1/teams`) and
//     no repository data request is sent;
//   - step 6 «log out and in again» is a fresh login in a fresh browser (identify in mode A,
//     password login in mode C): consent is a server-side user setting, not browser state.
//
// Replaces:
//   - tests/e2e/data-collection-consent.spec.ts (3)
//   - client/src/viewer/__tests__/components/data-collection-consent-screen.test.tsx (10; one
//     placeholder-substitution unit may stay, design «Заменяет»)
import { randomBytes } from 'crypto';
import { request as pwRequest, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, loginPastBackoff } from '../fixtures';
import type { Stand, ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { skipNewUserNudge } from '../helpers/teams';

const CONSENT = 'data-collection-consent-screen';
const ACCEPT = 'I understand and accept';

/** Records every `/api/` request path the page sends from now on. */
function recordApiRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/')) paths.push(url.pathname);
  });
  return paths;
}

/** A fresh browser context logged in from scratch as `user` (identify in mode A, login otherwise). */
async function freshLogin(stand: Stand, browser: Browser, user: ScenarioUser): Promise<BrowserContext> {
  const ctx = await pwRequest.newContext({ baseURL: stand.url });
  try {
    const res =
      stand.authMode === 'none'
        ? await ctx.post('/api/v1/auth/identify', { data: { email: user.email } })
        : await loginPastBackoff(ctx, user.email, user.password);
    expect(res.ok(), `fresh login of ${user.email}`).toBe(true);
    const context = await browser.newContext({ baseURL: stand.url });
    await skipNewUserNudge(context);
    await context.addCookies((await ctx.storageState()).cookies);
    return context;
  } finally {
    await ctx.dispose();
  }
}

test('@S-REPO-05 without consent there is neither the app nor a repository @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  browser,
}) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/consent`;
  const prompt = `consent session ${run}`;
  const user = await users.user('user', { label: 'consent', acceptNotice: false });
  const key = await createApiKey(user.api);
  await uploadPromptSession(api, key.key, { sessionId: `r05-${run}`, prompt, repoUrl }, { db, userId: user.id });
  const repoId = await ownRepoId(user.api, repoUrl);

  const context = await browser.newContext({ baseURL: stand.url });
  await skipNewUserNudge(context);
  const page = await context.newPage();
  await user.signIn(page);
  const requests = recordApiRequests(page);

  try {
    await test.step('1. Deep link to the repository: the consent screen, no navigation, no data requests', async () => {
      await page.goto(`/#/repos/${repoId}`);
      await expect(page.getByTestId(CONSENT)).toBeVisible();
      await expect(page.locator('nav')).toHaveCount(0);
      await expect(page.getByText('My API Keys')).toHaveCount(0);
      await expect(page.getByText(prompt)).toHaveCount(0);
      expect(requests.filter((p) => p.startsWith('/api/v1/repositories') || p.startsWith('/api/v1/teams'))).toEqual([]);
    });

    await test.step('2. API keys, teams, main and hook-state routes: the same screen', async () => {
      for (const route of ['/#/api-keys', '/#/teams', '/#/main', `/#/repos/${repoId}/hook-state`]) {
        await page.goto(route);
        await expect(page.getByTestId(CONSENT), route).toBeVisible();
        await expect(page.locator('nav'), route).toHaveCount(0);
      }
      expect(requests.filter((p) => p.startsWith('/api/v1/repositories') || p.startsWith('/api/v1/teams'))).toEqual([]);
    });

    await test.step('3. The text names the retention window the API reports and warns about secrets', async () => {
      const res = await user.api.get('/api/v1/sessions/retention-days');
      expect(res.status()).toBe(200);
      const { retentionDays } = (await res.json()) as { retentionDays: number };
      expect(retentionDays).toBe(30);
      const screen = page.getByTestId(CONSENT);
      await expect(screen).toContainText(`Stored session data is purged after ${retentionDays} days`);
      await expect(screen).not.toContainText('{{RETENTION_DAYS}}');
      await expect(screen.getByRole('heading', { name: 'If the assistant handles secrets' })).toBeVisible();
    });

    await test.step('4. The API is not gated: GET /repositories answers 200 with the repository', async () => {
      const res = await user.api.get('/api/v1/repositories');
      expect(res.status()).toBe(200);
      expect(((await res.json()) as Array<{ id: number }>).map((r) => r.id)).toContain(repoId);
    });

    await test.step('5. «I understand and accept»: the screen goes, the repository is in the left panel', async () => {
      await page.goto(`/#/repos/${repoId}`);
      await page.getByRole('button', { name: ACCEPT }).click();
      await expect(page.getByTestId(CONSENT)).toHaveCount(0);
      await expect(page.locator('nav').getByTitle(repoUrl)).toBeVisible();
      await expect(page.getByText(prompt)).toBeVisible();
    });

    await test.step('6. Reload, then a fresh login in a new browser: the screen does not come back', async () => {
      await page.reload();
      await expect(page.locator('nav').getByTitle(repoUrl)).toBeVisible();
      await expect(page.getByTestId(CONSENT)).toHaveCount(0);
      const again = await freshLogin(stand, browser, user);
      try {
        const page2 = await again.newPage();
        await page2.goto(`/#/repos/${repoId}`);
        await expect(page2.getByText(prompt)).toBeVisible();
        await expect(page2.getByTestId(CONSENT)).toHaveCount(0);
      } finally {
        await again.close();
      }
    });
  } finally {
    await context.close();
  }

  await test.step('7. Nudge: a brand-new user without repositories and teams lands on API keys once per browser session', async () => {
    const newcomer = await users.user('user', { label: 'consent-new', acceptNotice: false });
    const fresh = await browser.newContext({ baseURL: stand.url });
    try {
      const p = await fresh.newPage();
      await newcomer.signIn(p);
      await p.goto('/#/main');
      await p.getByRole('button', { name: ACCEPT }).click();
      await expect(p).toHaveURL(/#\/api-keys/);
      await p.goto('/#/main');
      await expect(p.getByText('My API Keys')).toBeVisible();
      await expect(p).toHaveURL(/#\/main/);
    } finally {
      await fresh.close();
    }
  });
});
