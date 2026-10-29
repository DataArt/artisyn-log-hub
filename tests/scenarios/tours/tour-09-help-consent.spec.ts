// Tour 9 — help articles, notifications and the two gates (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 9, §1.9, §1.10; checks per screen §2.2).
//
//   - Help: the «Help» button opens the modal; each of the 20 pages of user-docs/nav.json is opened
//     from its sidebar entry and must render its own `# heading` (a SPA fallback that serves
//     index.html instead of a missing .md would show «<!doctype» or «Article not found.»);
//     downloadable ones offer «Download .md». This pass runs with every request that does not go
//     to the stand aborted — the help works offline.
//   - Help navigation: the modal opens on «Your first session», the menu sections follow nav.json,
//     a link to another page switches the article and the highlight, a `page.md#anchor` link
//     scrolls to that heading, external links open in a new tab; an unknown page link only warns
//     and a missing anchor opens the page at its top.
//   - The bell lists a pending team invitation with Accept / Decline (nothing is clicked).
//   - Disclosure gate: a user force-added to a team before registering sees the disclosure modal
//     at first login.
//   - Consent gate: a user who has not accepted the data-collection notice gets only the consent
//     screen on a deep link to #/api-keys — no shell, no page behind it.
//
// Replaces:
//   - tests/e2e/help-modal.spec.ts (open, default article, switching, no console errors: ≈ 5 of 8)
//   - tests/e2e/data-collection-consent.spec.ts (the gate on a deep link only)
//   - client/src/viewer/__tests__/components/NotificationBell.test.tsx («renders» cases)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { createTeam, invite, skipNewUserNudge } from '../helpers/teams';
import { helpNav } from '../helpers/help-nav';
import { TourWalker } from './tour-kit';
import type { Browser, Route } from '@playwright/test';

const DOWNLOADABLE = new Set(helpNav.flatMap((s) => s.articles.filter((a) => a.downloadable).map((a) => a.slug)));
const NAV_TITLE = new Map(helpNav.flatMap((s) => s.articles.map((a) => [a.slug, a.title] as const)));

async function pageAs(browser: Browser, baseURL: string, walker: TourWalker, user: ScenarioUser) {
  const context = await browser.newContext({ baseURL });
  await skipNewUserNudge(context);
  const page = await context.newPage();
  walker.attach(page);
  await user.signIn(page);
  return { context, page };
}

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-09 help, notifications, consent @mode-a', async ({ stand, users, page, browser }) => {
  test.setTimeout(150_000);
  const run = randomBytes(4).toString('hex');
  const regular = await users.user('user', { label: 'tour09-regular' });
  const inviter = await users.user('user', { label: 'tour09-inviter' });
  const teamName = `Tour09 ${run}`;
  const forcedEmail = `tour09-forced-${run}@${SCENARIO_EMAIL_DOMAIN}`;

  const { forced, fresh } = await test.step('setup: a pending invitation for REGULAR; a force-added unregistered e-mail; a user without consent', async () => {
    const teamId = await createTeam(inviter, teamName);
    await invite(inviter, teamId, regular.email);
    const res = await inviter.api.post(`/api/v1/teams/${teamId}/invitations`, { data: { email: forcedEmail, force: true } });
    expect(res.status(), await res.text()).toBe(201);
    const forced = await users.user('user', { email: forcedEmail });
    const fresh = await users.user('user', { label: 'tour09-fresh', acceptNotice: false });
    return { forced, fresh };
  });

  const walker = new TourWalker({ story: 'tour-09', mode: stand.mode, params: { teamName } });
  walker.attach(page);
  await skipNewUserNudge(page);
  await regular.signIn(page);

  // Offline pass: anything that does not go to the stand is aborted while the help is walked.
  const standOrigin = new URL(stand.url).origin;
  const offline = (route: Route) =>
    new URL(route.request().url()).origin === standOrigin ? route.fallback() : route.abort('internetdisconnected');
  await page.context().route('**/*', offline);

  const dialog = page.getByRole('dialog');
  const menu = dialog.getByRole('navigation');
  const menuButton = (slug: string) => menu.getByRole('button', { name: NAV_TITLE.get(slug), exact: true });
  const h1 = (name: string) => dialog.getByRole('heading', { level: 1, name, exact: true });
  const helpRows = walker.rows().filter((r) => r.id.startsWith('help.'));
  for (const [i, row] of helpRows.entries()) {
    const slug = row.id.slice('help.'.length);
    await walker.screen(page, row.id, {
      go: async (hash) => {
        if (i === 0) {
          await page.goto(hash);
          await page.getByRole('button', { name: 'Help' }).click();
          await expect(dialog.getByRole('heading', { name: 'Help', exact: true })).toBeVisible();
        }
        await menuButton(slug).click();
      },
      check: async () => {
        await expect(dialog.getByRole('heading', { level: 1, name: row.expectText, exact: true })).toBeVisible();
        await expect(dialog.getByRole('link', { name: 'Download .md' })).toHaveCount(DOWNLOADABLE.has(slug) ? 1 : 0);
      },
    });
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await test.step('help: opens on «Your first session», menu sections in nav.json order', async () => {
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(h1('Your first session')).toBeVisible();
    await expect(menuButton('getting-started')).toHaveClass(/border-blue-500/);
    await expect(menu.locator('p')).toHaveText(helpNav.map((s) => s.section));
  });

  await test.step('help: a link to another page switches the article and the highlight', async () => {
    await dialog.getByRole('link', { name: 'Install the hook', exact: true }).click();
    await expect(h1('Install Telemetry Hook')).toBeVisible();
    await expect(menuButton('install-hook')).toHaveClass(/border-blue-500/);
    await expect(menuButton('getting-started')).not.toHaveClass(/border-blue-500/);
  });

  await test.step('help: a page.md#anchor link opens that page at the heading', async () => {
    await menuButton('trust-model').click();
    await dialog.getByRole('link', { name: 'What is collected', exact: true }).first().click();
    await expect(h1('Data Collection & Upload')).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2, name: 'What is collected', exact: true })).toBeInViewport();
  });

  await test.step('help: an external link opens in a new tab', async () => {
    await menuButton('install-server').click();
    const external = dialog.locator('a[href^="https://"]').first();
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', /noopener/);
    await expect(external).toContainText('↗');
  });

  await test.step('help: an unknown page link only warns, a missing anchor opens the page at its top', async () => {
    await page.route('**/help/getting-started.md', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        body: [
          '# Your first session',
          '',
          '[Broken page](no-such-page.md)',
          '',
          '[Missing anchor](session-log.md#no-such-anchor)',
          '',
        ].join('\n'),
      }),
    );
    await menuButton('getting-started').click();
    await expect(h1('Your first session')).toBeVisible();
    const [warning] = await Promise.all([
      page.waitForEvent('console', (msg) => msg.type() === 'warning' && msg.text().includes('[help] unknown help page')),
      dialog.getByRole('link', { name: 'Broken page' }).click(),
    ]);
    expect(warning.text()).toContain('no-such-page.md');
    await expect(h1('Your first session')).toBeVisible();
    await expect(menuButton('getting-started')).toHaveClass(/border-blue-500/);

    await dialog.getByRole('link', { name: 'Missing anchor' }).click();
    await expect(h1('Session Log')).toBeInViewport();
    await expect(menuButton('session-log')).toHaveClass(/border-blue-500/);
    await page.unroute('**/help/getting-started.md');
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.context().unroute('**/*', offline);

  await walker.screen(page, 'notifications.bell', {
    go: async (hash) => {
      await page.goto(hash);
      await page.getByRole('button', { name: 'Notifications' }).click();
    },
    check: async () => {
      const item = page.getByRole('listitem').filter({ hasText: teamName });
      await expect(item.getByRole('button', { name: 'Accept' })).toBeVisible();
      await expect(item.getByRole('button', { name: 'Decline' })).toBeVisible();
    },
  });

  const asForced = await pageAs(browser, stand.url, walker, forced);
  await walker.screen(asForced.page, 'team.disclosure-gate', {
    check: async () => {
      await expect(asForced.page.getByTestId('team-disclosure-modal')).toContainText(teamName);
    },
  });
  await asForced.context.close();

  const asFresh = await pageAs(browser, stand.url, walker, fresh);
  await walker.screen(asFresh.page, 'consent.gate', {
    check: async () => {
      await expect(asFresh.page.getByRole('button', { name: 'My API Keys' })).toHaveCount(0);
    },
  });
  await asFresh.context.close();

  walker.finish();
});
