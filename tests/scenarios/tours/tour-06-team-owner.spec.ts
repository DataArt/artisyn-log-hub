// Tour 6 — team owner (a plain user, not admin): teams, team detail, the team repository and the
// «Installed Hooks» menu (impl-plan DD G5; docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3
// story 6, §1.1; checks per screen §2.2).
//
// The point of the story: in a RESTRICTED team the non-admin owner still has Analytics, Reports
// and Settings on the team repository (`canSeeTeamWideTabs`). The team detail tabs live in
// component state (no URL), so they are reached by clicks; the team and repository tab bars are
// compared with the registry (06 §2.4, layer B).
//
// Data: the owner's session (with a hook-status line, so the repository is in «Installed Hooks»),
// a restricted team holding that repository, one accepted member and one pending invitation.
//
// Replaces:
//   - client/src/viewer/__tests__/components/TeamDetailPage*.test.tsx («renders» cases)
//   - client/src/viewer/__tests__/components/AppLeftNav.test.tsx («Installed Hooks» renders)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, invite, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';
import { TourWalker, expectTabsOnScreen, registryTabIds } from './tour-kit';
import { uploadHookStatusSession } from './tour-seed';

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-06 team owner: teams tour @mode-a', async ({ stand, api, db, users, page }) => {
  test.setTimeout(150_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'tour06-teamowner' });
  const member = await users.user('user', { label: 'tour06-member' });
  const pending = await users.user('user', { label: 'tour06-pending' });
  const repoUrl = `https://git.arrakis.test/tours/${run}/team-repo`;
  const firstPrompt = `team owner session ${run}`;
  const teamName = `Tour06 ${run}`;

  const params = await test.step('setup: owner session with hook status; restricted team, member, pending invite', async () => {
    const key = await createApiKey(owner.api);
    await uploadHookStatusSession(api, key.key, { sessionId: `tour06-${run}`, prompt: firstPrompt, repoUrl }, { db, userId: owner.id });
    const teamId = await createTeam(owner, teamName);
    await inviteAndAccept(owner, member, teamId, 'restricted');
    await invite(owner, teamId, pending.email);
    await addTeamRepo(owner, teamId, repoUrl);
    return {
      teamId,
      repoId: await ownRepoId(owner.api, repoUrl),
      teamName,
      memberEmail: member.email,
      pendingEmail: pending.email,
      repoUrl,
      firstPrompt,
    };
  });

  const walker = new TourWalker({ story: 'tour-06', mode: stand.mode, params });
  walker.attach(page);
  await skipNewUserNudge(page);
  await owner.signIn(page);

  await walker.screen(page, 'teams.list');
  await walker.screen(page, 'team.members', {
    go: async () => {
      await page.getByText(teamName, { exact: true }).filter({ visible: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`#/teams/${params.teamId}$`));
    },
    check: () => expectTabsOnScreen(page, 'team', registryTabIds(walker, 'team')),
  });
  for (const id of ['repositories', 'invitations']) {
    await walker.screen(page, `team.${id}`, {
      go: async () => {
        await page.getByTestId(`tab-team-${id}`).click();
      },
    });
  }

  await walker.screen(page, 'team-repo.sessions');
  await walker.screen(page, 'team-repo.owner-sees-team-wide-tabs', {
    check: async () => {
      await expectTabsOnScreen(page, 'repo', ['sessions', 'analytics', 'reports', 'okf', 'settings']);
      await expect(page.getByTestId('restricted-sessions-notice')).toHaveCount(0);
    },
  });

  await walker.screen(page, 'nav.installed-hooks', {
    go: async () => {
      await page.goto('/#/main');
      await page.getByRole('button', { name: 'Installed Hooks' }).waitFor();
      await page.getByTitle(repoUrl, { exact: true }).filter({ visible: true }).last().click();
      await expect(page).toHaveURL(new RegExp(`#/repos/${params.repoId}/hook-state$`));
    },
  });

  walker.finish();
});
