// Tour 8 — a user with no relation to the repository or the team (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 8, §1.10; checks per screen §2.2).
//
// Direct URLs to someone else's repository, session, team, team repository and hook state: each
// screen answers with its declared error state (the API's 403/404 are the row's
// `expectedNetwork`), never crashes and never shows the owner's data (`forbidText`: the
// repository URL, the prompt, the team name).
//
// Data: an owner's session (with a hook-status line) in a repository held by the owner's team.
//
// Replaces:
//   - client/src/viewer/__tests__/components/HookStatePage.test.tsx (403 state)
//   - tests/e2e/repo-panel.spec.ts («foreign repository» case)
import { randomBytes } from 'crypto';
import { test } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, skipNewUserNudge } from '../helpers/teams';
import { TourWalker } from './tour-kit';
import { uploadHookStatusSession } from './tour-seed';

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-08 non-member @mode-a', async ({ stand, api, db, users, page }) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'tour08-owner' });
  const outsider = await users.user('user', { label: 'tour08-nonmember' });
  const repoUrl = `https://git.arrakis.test/tours/${run}/private`;
  const firstPrompt = `private session ${run}`;
  const teamName = `Tour08 ${run}`;

  const params = await test.step("setup: the owner's session with hook status, in the owner's team", async () => {
    const key = await createApiKey(owner.api);
    const sessionId = `tour08-${run}`;
    await uploadHookStatusSession(api, key.key, { sessionId, prompt: firstPrompt, repoUrl }, { db, userId: owner.id });
    const teamId = await createTeam(owner, teamName);
    await addTeamRepo(owner, teamId, repoUrl);
    return { teamId, repoId: await ownRepoId(owner.api, repoUrl), sessionId, repoUrl, firstPrompt, teamName };
  });

  const walker = new TourWalker({ story: 'tour-08', mode: stand.mode, params });
  walker.attach(page);
  await skipNewUserNudge(page);
  await outsider.signIn(page);

  for (const row of walker.rows()) await walker.screen(page, row.id);

  walker.finish();
});
