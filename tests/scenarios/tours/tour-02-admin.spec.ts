// Tour 2 — admin: the admin panel (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 2, §1.5; checks per screen §2.2).
//
// The admin opens «Admin Panel» from the left menu and clicks through all nine tabs; the tab bar
// is compared with the registry (06 §2.4, layer B). Then an unknown `?tab=` deep link, and a plain
// user, who has no «Admin Panel» link and is bounced from #/admin to #/main.
//
// Data: a plain user with a repository, and a team owned by a third user, so Repos / Teams /
// Users show concrete rows. REGULAR deliberately owns no team: the left menu shows «Admin Panel»
// to team owners too (`AppLeftNav`: `isAdmin || isTeamOwner`, for the Data Retention view they may
// read), while `AdminGuard` lets only `role = admin` in and bounces a team owner to #/main.
//
// Replaces:
//   - tests/e2e/admin-panel.spec.ts («renders tabs», «shows» per tab, «no console errors»)
//   - client/src/viewer/__tests__/components/Admin*Tab.test.tsx («renders» cases)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadPromptSession } from '../helpers/prompt-session';
import { browserAs, createTeam, skipNewUserNudge } from '../helpers/teams';
import { TourWalker, expectTabsOnScreen, registryTabIds } from './tour-kit';

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-02 admin: admin panel tour @mode-a', async ({ stand, api, db, users, page, browser }) => {
  test.setTimeout(150_000);
  const run = randomBytes(4).toString('hex');
  const admin = await users.user('admin', { label: 'tour02-admin' });
  const regular = await users.user('user', { label: 'tour02-regular' });
  const teamOwner = await users.user('user', { label: 'tour02-teamowner' });
  const repoUrl = `https://git.arrakis.test/tours/${run}/admin-view`;
  const teamName = `Tour02 ${run}`;

  await test.step('setup: REGULAR uploads one session; another user owns a team', async () => {
    const key = await createApiKey(regular.api);
    await uploadPromptSession(api, key.key, { sessionId: `tour02-${run}`, prompt: `tour 02 ${run}`, repoUrl }, { db, userId: regular.id });
    await createTeam(teamOwner, teamName);
  });

  const walker = new TourWalker({ story: 'tour-02', mode: stand.mode, params: { repoUrl, teamName, regularEmail: regular.email } });
  walker.attach(page);
  await skipNewUserNudge(page);
  await admin.signIn(page);
  const adminTabs = registryTabIds(walker, 'admin');

  await walker.screen(page, 'admin.system-info', {
    go: async () => {
      await page.goto('/#/main');
      await page.getByRole('button', { name: 'Admin Panel' }).click();
      await expect(page).toHaveURL(/#\/admin$/);
    },
    check: () => expectTabsOnScreen(page, 'admin', adminTabs),
  });
  for (const id of adminTabs.filter((t) => t !== 'system-info')) {
    await walker.screen(page, `admin.${id}`, {
      go: async () => {
        await page.getByTestId(`tab-admin-${id}`).click();
      },
      check: async () => {
        await expect(page.getByRole('tabpanel').getByText('Loading…')).toHaveCount(0, { timeout: 15_000 });
      },
    });
  }
  await walker.screen(page, 'admin.deep-link.unknown-tab', {
    check: async () => {
      await expect(page.getByTestId('tab-admin-system-info')).toHaveAttribute('data-state', 'active');
    },
  });

  const other = await browserAs(browser, stand.url, regular, '/#/main');
  walker.attach(other.page);
  await walker.screen(other.page, 'admin.hidden-for-regular', {
    go: async (hash) => {
      await expect(other.page.getByRole('button', { name: 'Add Team' })).toBeVisible({ timeout: 15_000 });
      await expect(other.page.getByRole('button', { name: 'Admin Panel' })).toHaveCount(0);
      await other.page.goto(hash);
    },
  });
  await other.context.close();

  walker.finish();
});
