// Tour 7 — a plain member of a RESTRICTED team (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 7, §1.2, §1.11; checks per screen §2.2).
//
// The member sees the team repository with the restricted-sessions notice and only their own
// sessions; no Analytics / Reports / Settings tabs (the tab bar is compared with the registry,
// 06 §2.4 layer B), `?mtab=settings` falls back to Sessions, a deep link to the owner's session
// shows neither its prompt nor Raw Logs, and #/admin bounces to #/main.
//
// Data: a restricted team; the owner's session and the member's own session in its repository.
//
// Replaces:
//   - tests/e2e/auth-guard.spec.ts (the member half)
//   - client/src/viewer/__tests__/components/repository-view-restricted*.test.tsx («renders» cases)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';
import { TourWalker, expectTabsOnScreen } from './tour-kit';

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-07 restricted member @mode-a', async ({ stand, api, db, users, page }) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'tour07-teamowner' });
  const member = await users.user('user', { label: 'tour07-member' });
  const repoUrl = `https://git.arrakis.test/tours/${run}/restricted`;
  const teamName = `Tour07 ${run}`;
  const ownerPrompt = `owner only ${run}`;
  const ownPrompt = `member own ${run}`;

  const params = await test.step('setup: restricted team; the owner and the member each upload a session into its repo', async () => {
    const ownerKey = await createApiKey(owner.api);
    const ownerSessionId = `tour07-${run}-owner`;
    await uploadPromptSession(api, ownerKey.key, { sessionId: ownerSessionId, prompt: ownerPrompt, repoUrl }, { db, userId: owner.id });
    const teamId = await createTeam(owner, teamName);
    await inviteAndAccept(owner, member, teamId, 'restricted');
    await addTeamRepo(owner, teamId, repoUrl);
    const memberKey = await createApiKey(member.api);
    await uploadPromptSession(api, memberKey.key, { sessionId: `tour07-${run}-member`, prompt: ownPrompt, repoUrl }, { db, userId: member.id });
    return { teamId, repoId: await ownRepoId(owner.api, repoUrl), teamName, ownerSessionId, ownPrompt, ownerPrompt };
  });

  const walker = new TourWalker({ story: 'tour-07', mode: stand.mode, params });
  walker.attach(page);
  await skipNewUserNudge(page);
  await member.signIn(page);

  await walker.screen(page, 'member.team-detail');
  await walker.screen(page, 'member.team-repo.restricted-notice', {
    check: async () => {
      await expect(page.getByText(ownPrompt).filter({ visible: true }).first()).toBeVisible();
    },
  });
  await walker.screen(page, 'member.team-repo.no-team-wide-tabs', {
    check: () => expectTabsOnScreen(page, 'repo', ['sessions']),
  });
  await walker.screen(page, 'member.team-repo.settings-fallback', {
    check: async () => {
      await expect(page.getByTestId('tab-repo-sessions')).toHaveAttribute('data-state', 'active');
      await expect(page.getByTestId('tab-settings-display')).toHaveCount(0);
    },
  });
  await walker.screen(page, 'member.foreign-session.no-raw-logs', {
    check: async () => {
      await expect(page.getByTestId('tab-session-raw-logs')).toHaveCount(0);
    },
  });
  await walker.screen(page, 'member.admin-redirect');

  walker.finish();
});
