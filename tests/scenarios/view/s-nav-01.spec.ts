// S-NAV-01. The navigation walk of the UX navigation overhaul (GH-74): Home, the session lenses and
// groups, the Summary hub, the All views map, per-user Recent, pins and the old deep links
// (docs/tasks/todo/2026-11-02-ux-navigation-overhaul/impl-plan.md, Chunk 15; mode A only).
//
// Data: an OWNER (admin, so the map lists the Admin panel), a MEMBER and a FRESH user; one
// restricted team (OWNER owns it, MEMBER accepted). Three repositories:
//   - A — OWNER's personal repository with the golden GS-01 session (lenses, Summary, map);
//   - B — OWNER's personal repository whose session carries a hook-status issue (Needs attention);
//   - C — MEMBER's repository with one prompt session, added to the team (OWNER sees it as a team
//     entry; MEMBER as their own).
//
// Code facts the steps rely on:
//   - Recent visits, the session lens, the group tabs and the map expand state are per user in
//     localStorage (`artisyn:<userId>:<name>`, DD-6); pins are the `home.pins` user setting (DD-17).
//   - The map tree opens the top level on a first visit; a container row toggles on click, a leaf
//     opens its target; a node missing its session is greyed with "choose a session ▸" (DD-10).
import type { Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  expandMapNode,
  expectHomeWidgetFilled,
  homeWidget,
  mapFilter,
  mapNode,
  openMap,
  shortRepoName,
} from '../helpers/nav';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { lensSelect, openSession, selectLens, selectSessionTab, uploadGoldenRepo } from '../helpers/session-view';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';
import { uploadHookStatusSession } from '../tours/tour-seed';

const WIDE = { width: 1280, height: 720 };

/** The tab trigger of the session pane, wherever the bar shows it. */
const sessionTab = (page: Page, id: string) => page.getByTestId(`tab-session-${id}`);

test('@S-NAV-01 navigation walk: Home, one-level session tabs with views, Summary hub, All views map, Recent and pins per user @mode-a', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const runId = randomBytes(4).toString('hex');
  const owner = await users.user('admin', { label: 'nav01-owner' });
  const member = await users.user('user', { label: 'nav01-member' });
  const fresh = await users.user('user', { label: 'nav01-fresh' });
  const urlB = `https://git.arrakis.test/scn/${runId}/nav-hook`;
  const urlC = `https://git.arrakis.test/scn/${runId}/nav-team`;
  const sidB = `nav01-${runId}-b`;
  const sidC = `nav01-${runId}-c`;

  const seed = await test.step('setup: A (GS-01), B (hook-status issue), team with C (MEMBER’s session)', async () => {
    const golden = await uploadGoldenRepo(api, db, owner, ['gs-01']);
    const ownerKey = await createApiKey(owner.api);
    await uploadHookStatusSession(api, ownerKey.key, { sessionId: sidB, prompt: `hook prompt ${runId}`, repoUrl: urlB }, { db, userId: owner.id });
    const teamId = await createTeam(owner, `Nav-${runId}`);
    await inviteAndAccept(owner, member, teamId);
    const memberKey = await createApiKey(member.api);
    await uploadPromptSession(api, memberKey.key, { sessionId: sidC, prompt: `team prompt ${runId}`, repoUrl: urlC }, { db, userId: member.id });
    await addTeamRepo(owner, teamId, urlC);
    return {
      a: golden.repoId,
      urlA: golden.repoUrl,
      sidA: golden.rootId('gs-01'),
      b: await ownRepoId(owner.api, urlB),
      c: await ownRepoId(member.api, urlC),
      teamId,
    };
  });
  const { a, b, c, teamId, sidA } = seed;
  const repoUrls: Record<number, string> = { [a]: seed.urlA, [b]: urlB, [c]: urlC };

  await skipNewUserNudge(page.context());
  await owner.signIn(page);

  // ---------------------------------------------------------------- Home

  await test.step('home 1. OWNER: one entry per visible repository — A and B personal, C through the team', async () => {
    await page.goto('/#/main');
    const entries = homeWidget(page, 'repos').locator('[data-testid^="home-repo-open-"]');
    await expect(entries).toHaveCount(3);
    for (const id of [a, b, c]) {
      await expect(page.getByTestId(`home-repo-open-${id}`)).toHaveText(shortRepoName(repoUrls[id]));
    }
    await expect(page.getByTestId(`home-repo-open-${a}`)).toHaveAttribute('href', new RegExp(`#/repos/${a}$`));
    await expect(page.getByTestId(`home-repo-open-${c}`)).toHaveAttribute('href', new RegExp(`#/teams/${teamId}/repos/${c}$`));
    await expect(page.getByTestId(`home-repo-${c}`)).toContainText(`Nav-${runId}`);
  });

  await test.step('home 2. every widget fills after its placeholder (the week figures wait for a slow summary)', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/reports/executive-summary**', async (route) => {
      await held;
      await route.continue();
    });
    await page.reload();
    const sessionsA = page.getByTestId(`home-repo-sessions-${a}`);
    await expect(sessionsA.locator('[data-slot="skeleton"]'), 'the week figure shows its placeholder first').toBeVisible();
    release();
    await expect(sessionsA.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(sessionsA).toHaveText(/^\d+$/);
    await page.unroute('**/reports/executive-summary**');
    for (const w of ['repos', 'questions', 'attention', 'week', 'pinned', 'recent'] as const) {
      await expectHomeWidgetFilled(page, w);
    }
  });

  await test.step('home 3. Needs attention lists the hook repository B and opens its Hook state', async () => {
    const hooks = page.getByTestId('home-attention-hooks');
    const line = hooks.getByRole('link', { name: new RegExp(`Hook in ${shortRepoName(urlB)}`) });
    await expect(line).toBeVisible();
    await line.click();
    await expect(page).toHaveURL(new RegExp(`#/repos/${b}/hook-state`));
  });

  await test.step('home 4. with no session of A opened yet, "Why was this session expensive?" opens the map filtered by "expensive" (DD-12)', async () => {
    await page.goto('/#/main');
    await page.getByTestId('home-questions-repo').selectOption(`${a}:`);
    await page.getByTestId('home-question-expensive').click();
    await expect(page).toHaveURL(/#\/map\?/);
    await expect(page).toHaveURL(new RegExp(`repoId=${a}`));
    await expect(page).toHaveURL(/q=expensive/);
    await expect(page.getByTestId('map-rail-repo')).toHaveValue(String(a));
  });

  await test.step('home 5. a FRESH user (no repositories, no teams) gets Get started instead of the empty sections', async () => {
    const other = await browserAs(browser, stand.url, fresh, '/#/main');
    try {
      await expect(homeWidget(other.page, 'get-started')).toBeVisible();
      await expect(other.page.getByTestId('home-get-started-install')).toBeVisible();
      await expect(homeWidget(other.page, 'repos')).toHaveCount(0);
      await expect(homeWidget(other.page, 'attention')).toHaveCount(0);
    } finally {
      await other.context.close();
    }
  });

  // ---------------------------------------------------------------- Session

  await test.step('session 1. Home → A → the session: Summary under the default Cost lens', async () => {
    await page.goto('/#/main');
    await page.getByTestId(`home-repo-open-${a}`).click();
    await expect(page).toHaveURL(new RegExp(`#/repos/${a}`));
    await page.getByTestId('session-item').first().click();
    await expect(page).toHaveURL(new RegExp(`session=${sidA}`));
    await expect(page).not.toHaveURL(/tab=/);
    await expect(lensSelect(page)).toHaveValue('cost');
    await expect(sessionTab(page, 'summary')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('summary-executive-band')).toBeVisible();
  });

  await test.step('session 2. every lens opens its default tab (What happened → Summary, Cost → Statistics, Harness → System context, Failed tool → Tools)', async () => {
    const lenses: Array<[string, string]> = [
      ['what-happened', 'summary'],
      ['cost', 'usage'],
      ['harness', 'sysctx'],
      ['failed-tool', 'tools'],
    ];
    for (const [lens, tab] of lenses) {
      await selectLens(page, lens);
      await expect(page).toHaveURL(new RegExp(`lens=${lens}`));
      if (tab === 'summary') await expect(page).not.toHaveURL(/tab=/);
      else await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
      await expect(sessionTab(page, tab), `${lens} → ${tab}`).toHaveAttribute('aria-selected', 'true');
    }
  });

  await test.step('session 3. All tabs: one row of tabs (no group row, no Charts sub-tabs); a chart opens as a tab', async () => {
    await selectLens(page, 'all');
    await expect(sessionTab(page, 'summary')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid^="tab-session-group-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="tab-chart-"]')).toHaveCount(0);
    await selectSessionTab(page, 'call-tree');
    await expect(page).toHaveURL(/tab=call-tree/);
    await expect(page.getByTestId('session-chart-call-tree')).toBeVisible();
    await selectSessionTab(page, 'bash');
    await expect(page).toHaveURL(/tab=bash/);
  });

  await test.step('session 4. narrow viewport: promoted Cost tabs overflow into "More ▾" and open from there', async () => {
    await selectLens(page, 'cost');
    await expect(sessionTab(page, 'usage')).toHaveAttribute('aria-selected', 'true');
    // Advisor is not visible without an advisor result, and Statistics is active (never in More).
    const candidates = ['otel', 'dashboard', 'context-growth', 'call-tree', 'summary'];
    const overflowed = async (): Promise<string | undefined> => {
      for (const t of candidates) if ((await sessionTab(page, t).count()) === 0) return t;
      return undefined;
    };
    let hidden: string | undefined;
    for (const width of [1024, 900, 800, 700, 600]) {
      await page.setViewportSize({ width, height: 800 });
      // The row re-measures on resize (ResizeObserver): give it a moment to settle.
      await expect(async () => {
        hidden = await overflowed();
        expect(hidden).toBeDefined();
      })
        .toPass({ timeout: 2_000 })
        .catch(() => undefined);
      if (hidden !== undefined) break;
    }
    expect(hidden, 'at least one promoted tab overflowed into "More ▾"').toBeDefined();
    await page.getByTestId('session-tabs-more').click();
    await expect(sessionTab(page, hidden!)).toBeVisible();
    await sessionTab(page, hidden!).click();
    // Summary is the default tab, so it is written as no tab= at all.
    if (hidden === 'summary') await expect(page).not.toHaveURL(/tab=/);
    else await expect(page).toHaveURL(new RegExp(`tab=${hidden}`));
    await expect(sessionTab(page, hidden!), 'the active tab is back in the row').toHaveAttribute('aria-selected', 'true');
    await expect(sessionTab(page, hidden!)).toBeVisible();
    await page.setViewportSize(WIDE);
  });

  await test.step('session 5. a Summary card opens its tab; an Explore chip switches the lens', async () => {
    await selectSessionTab(page, 'summary');
    await expect(page.getByTestId('summary-next-cards')).toBeVisible();
    await page.getByTestId('summary-card-info-open').click();
    await expect(page).toHaveURL(/tab=info/);
    await expect(sessionTab(page, 'info')).toHaveAttribute('aria-selected', 'true');
    await selectSessionTab(page, 'summary');
    await page.getByTestId('summary-explore-harness').click();
    await expect(page).toHaveURL(/lens=harness/);
    await expect(page).toHaveURL(/tab=sysctx/);
    await expect(lensSelect(page)).toHaveValue('harness');
    await expect(sessionTab(page, 'sysctx')).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('session 6. Home "Why was this session expensive?" opens the session just visited under the Cost lens, selected in the list in every list mode', async () => {
    await page.goto('/#/main');
    await page.getByTestId('home-questions-repo').selectOption(`${a}:`);
    await page.getByTestId('home-question-expensive').click();
    await expect(page).toHaveURL(new RegExp(`#/repos/${a}\\?`));
    await expect(page).toHaveURL(new RegExp(`session=${sidA}`));
    await expect(page).toHaveURL(/lens=cost/);
    await expect(sessionTab(page, 'usage')).toHaveAttribute('aria-selected', 'true');
    const viewMode = page.getByTestId('session-list-view-mode');
    const original = await viewMode.inputValue();
    try {
      for (const mode of ['branch', 'date', 'user', 'plain']) {
        await viewMode.selectOption(mode);
        // A reload re-opens the deep link: the group holding the session must open by itself.
        await page.reload();
        const selected = page.locator('[data-testid="session-item"][aria-current="true"]');
        await expect(selected, `${mode}: the opened session is selected and visible`).toBeVisible();
        await expect(selected).toBeInViewport();
      }
    } finally {
      await viewMode.selectOption(original);
    }
  });

  // ---------------------------------------------------------------- Map

  const teamSession = `/#/teams/${teamId}/repos/${c}?session=${encodeURIComponent(sidC)}`;

  await test.step('map 1. from a team session the rail shows team / repository / session; Back returns there', async () => {
    await page.goto(teamSession);
    await expect(page.getByTestId('summary-executive-band')).toBeVisible();
    await openMap(page);
    await expect(page.getByTestId('map-rail-team')).toHaveValue(String(teamId));
    await expect(page.getByTestId('map-rail-repo')).toHaveValue(String(c));
    await expect(page.getByTestId('map-rail-session')).toContainText(sidC.slice(0, 6));
    await expect(mapNode(page, 'admin'), 'OWNER is an admin: the Admin panel is listed').toBeVisible();
    await page.getByTestId('map-back').click();
    await expect(page).not.toHaveURL(/#\/map/);
    await expect(page).toHaveURL(new RegExp(`#/teams/${teamId}/repos/${c}\\?session=${sidC}`));
  });

  await test.step('nav. the top-bar Home button opens Home from anywhere and is marked current there', async () => {
    const home = page.getByTestId('nav-home');
    await expect(home).not.toHaveAttribute('aria-current', 'page');
    await home.click();
    await expect(page).toHaveURL(/#\/main$/);
    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(home).toHaveAttribute('aria-current', 'page');
  });

  await test.step('nav. the team page scrolls itself in a short window (the app shell clips its content pane)', async () => {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 320 });
    try {
      await page.goto(`/#/teams/${teamId}`);
      const root = page.getByTestId('team-detail-page');
      await expect(root).toBeVisible();
      await expect
        .poll(() => root.evaluate((el) => el.scrollHeight > el.clientHeight), { message: 'content taller than the window' })
        .toBe(true);
      await root.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect.poll(() => root.evaluate((el) => el.scrollTop), { message: 'the page scrolled' }).toBeGreaterThan(0);
    } finally {
      if (size) await page.setViewportSize(size);
    }
  });

  await test.step('map 2. from Home with an empty Recent the session nodes are greyed; the picker opens the chosen tab', async () => {
    await page.evaluate((key) => localStorage.removeItem(key), `artisyn:${owner.id}:recent-visits`);
    await page.goto('/#/main');
    await page.reload();
    await expect(homeWidget(page, 'recent')).toContainText('Repositories and sessions you open show up here.');
    await page.getByTestId('home-questions-all-views').click();
    await expect(page).toHaveURL(/#\/map$/);
    await expect(page.getByTestId('map-rail-repo')).toHaveValue('');
    await expect(mapNode(page, 'question:expensive')).toHaveAttribute('aria-disabled', 'true');
    for (const id of [`repo:${a}`, `repo:${a}/sessions`, `repo:${a}/session`, `repo:${a}/session/group:overview`]) {
      await expandMapNode(page, id);
    }
    await expect(mapNode(page, `repo:${a}/session`)).toHaveAttribute('aria-disabled', 'true');
    const info = `repo:${a}/session/group:overview/tab:info`;
    await expect(mapNode(page, info)).toHaveAttribute('aria-disabled', 'true');
    // The link sits inside the greyed (`aria-disabled`) row, which Playwright counts as disabled.
    await page.getByTestId(`map-choose-${info}`).click({ force: true });
    const picker = page.getByTestId('map-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId(`map-picker-session-${sidA}`).first().click();
    await expect(page).toHaveURL(new RegExp(`#/repos/${a}\\?`));
    await expect(page).toHaveURL(new RegExp(`session=${sidA}`));
    await expect(page).toHaveURL(/tab=info/);
    await expect(sessionTab(page, 'info')).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('map 3. filter "expensive" hits the question; the other questions are dimmed', async () => {
    await openMap(page);
    await expect(page.getByTestId('map-rail-repo')).toHaveValue(String(a));
    await mapFilter(page).fill('expensive');
    await expect(page).toHaveURL(/q=expensive/);
    const hit = mapNode(page, 'question:expensive');
    await expect(hit).not.toHaveAttribute('aria-disabled', 'true');
    await expect(hit).not.toHaveClass(/opacity-45/);
    await expect(mapNode(page, 'question:hook')).toHaveClass(/opacity-45/);
    await expect(page.getByTestId('map-counter')).toHaveText(/^[1-9]\d* of \d+ views/);
    await mapFilter(page).fill('');
    await expect(page).not.toHaveURL(/q=/);
  });

  await test.step('map 4. keyboard: ←/→ collapse and open, → and ↑/↓ move, ← goes to the parent, Enter opens a leaf', async () => {
    const repos = mapNode(page, 'repos');
    const focused = page.locator('[role="treeitem"]:focus');
    await expandMapNode(page, 'repos');
    await repos.focus();
    await expect(repos).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(repos).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(repos).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(focused).toHaveAttribute('data-testid', /^map-node-repo:\d+$/);
    const first = await focused.getAttribute('data-testid');
    await page.keyboard.press('ArrowDown');
    await expect(focused).not.toHaveAttribute('data-testid', first!);
    await page.keyboard.press('ArrowUp');
    await expect(focused).toHaveAttribute('data-testid', first!);
    // ← on an open repository collapses it first, then the next ← moves to "Repositories".
    if ((await focused.getAttribute('aria-expanded')) === 'true') {
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId(first!)).toHaveAttribute('aria-expanded', 'false');
    }
    await page.keyboard.press('ArrowLeft');
    await expect(repos).toBeFocused();

    await expandMapNode(page, `repo:${a}`);
    const tools = mapNode(page, `repo:${a}/tab:tools`);
    await tools.focus();
    await expect(tools).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/repos/${a}\\?`));
    await expect(page).toHaveURL(/mtab=tools/);
    await expect(page.getByTestId('tab-repo-tools')).toHaveAttribute('data-state', 'active');
  });

  // ---------------------------------------------------------------- Visibility and identity

  await test.step('visibility. MEMBER: no Admin panel, not OWNER’s private A or B on the map or on Home; C is there', async () => {
    const other = await browserAs(browser, stand.url, member, '/#/map');
    try {
      await expect(mapNode(other.page, 'repos')).toBeVisible();
      await expect(mapNode(other.page, `repo:${c}`)).toBeVisible();
      await expect(mapNode(other.page, `team:${teamId}`)).toBeVisible();
      await expect(mapNode(other.page, 'admin')).toHaveCount(0);
      await expect(mapNode(other.page, `repo:${a}`)).toHaveCount(0);
      await expect(mapNode(other.page, `repo:${b}`)).toHaveCount(0);
      // C is MEMBER's own repository, shared with the team: choosing the team keeps it a choice.
      await other.page.getByTestId('map-rail-team').selectOption(String(teamId));
      const railRepo = other.page.getByTestId('map-rail-repo');
      await expect(railRepo).toBeEnabled();
      await railRepo.selectOption(String(c));
      await expect(other.page.getByTestId('map-rail-team')).toHaveValue(String(teamId));
      await expect(other.page).toHaveURL(new RegExp(`teamId=${teamId}`));
      await expect(other.page).toHaveURL(new RegExp(`repoId=${c}`));
      await other.page.goto('/#/main');
      await expect(other.page.getByTestId(`home-repo-open-${c}`)).toBeVisible();
      await expect(homeWidget(other.page, 'repos').locator('[data-testid^="home-repo-open-"]')).toHaveCount(1);
    } finally {
      await other.context.close();
    }
  });

  await test.step('pins. OWNER pins A; another browser of OWNER shows it under Pinned', async () => {
    await page.goto(`/#/repos/${a}`);
    const pin = page.getByTestId('pin-toggle').first();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => {
        const res = await owner.api.get('/api/v1/user-settings');
        const rows = (await res.json()) as Array<{ name: string; value: string | null }>;
        return rows.find((r) => r.name === 'home.pins')?.value ?? '';
      }, { message: 'home.pins saved' })
      .toContain(`"repoId":${a}`);
    const other = await browserAs(browser, stand.url, owner, '/#/main');
    try {
      const items = homeWidget(other.page, 'pinned').getByTestId('home-pinned-item');
      await expect(items).toHaveCount(1);
      await expect(items).toContainText(shortRepoName(seed.urlA));
    } finally {
      await other.context.close();
    }
  });

  await test.step('identity. after switching to MEMBER, Recent holds none of OWNER’s visits; switching back brings them back', async () => {
    await page.goto(teamSession);
    await expect(page.getByTestId('summary-executive-band')).toBeVisible();
    await page.goto('/#/main');
    await page.reload();
    const recent = homeWidget(page, 'recent');
    await expect(recent.getByTestId(`home-recent-session-${sidC}`)).toBeVisible();
    await expect(recent.getByTestId(`home-recent-session-${sidA}`)).toBeVisible();

    // Leave the app before swapping identity: sessions are `rolling`, so a request still in flight
    // from the previous user's page answers with that user's Set-Cookie and overwrites the new one.
    await page.goto('about:blank');
    await page.context().clearCookies();
    await member.signIn(page);
    await page.goto('/#/main');
    await expect(page.getByTestId(`home-repo-open-${a}`)).toHaveCount(0);
    await expect(page.getByTestId(`home-repo-open-${c}`)).toBeVisible();
    await expectHomeWidgetFilled(page, 'recent');
    // C is visible to MEMBER too, so only the per-user key keeps OWNER's visit out.
    await expect(recent.getByTestId(`home-recent-session-${sidC}`)).toHaveCount(0);
    await expect(recent.locator('[data-testid^="home-recent-"]')).toHaveCount(0);

    await page.goto('about:blank');
    await page.context().clearCookies();
    await owner.signIn(page);
    await page.goto('/#/main');
    await expect(page.getByTestId(`home-repo-open-${a}`)).toBeVisible();
    await expect(recent.getByTestId(`home-recent-session-${sidC}`)).toBeVisible();
    await expect(recent.getByTestId(`home-recent-session-${sidA}`)).toBeVisible();
  });

  await test.step('deep links. tab=, mtab=, stab= and admin tab= open the same tabs as before', async () => {
    await page.goto(`/#/repos/${a}?session=${encodeURIComponent(sidA)}&tab=bash`);
    await expect(sessionTab(page, 'bash')).toHaveAttribute('aria-selected', 'true');
    await page.goto(`/#/repos/${a}?mtab=analytics`);
    await expect(page.getByTestId('tab-repo-analytics')).toHaveAttribute('data-state', 'active');
    await page.goto(`/#/repos/${a}?mtab=settings&stab=maintenance`);
    await expect(page.getByTestId('tab-repo-settings')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('tab-settings-maintenance')).toHaveAttribute('data-state', 'active');
    await page.goto('/#/admin?tab=all-users');
    await expect(page.getByTestId('tab-admin-all-users')).toHaveAttribute('data-state', 'active');
  });
});
