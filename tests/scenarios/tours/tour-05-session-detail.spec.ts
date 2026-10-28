// Tour 5 — session owner: every tab of the session detail and every Charts sub-tab (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 5, §1.3, §1.4; checks per screen §2.2).
//
// Tabs are reached by their `data-testid="tab-session-<id>"` / `tab-chart-<id>` triggers (DD G1)
// and both tab bars are compared with the registry (06 §2.4, layer B). Then the redirects: the
// legacy `tab=call-tree` lands on Charts, `tab=advisor` on a session without an advisor result
// lands on Summary, and `tab=raw-logs` on a team member's session seen by a restricted-team
// MANAGER shows no Raw Logs and falls back.
//
// Data: GS-02 (a root with sub-agents three levels deep, Edit/Write calls) with a submitted
// Turn-End Advisor run posted the way the hook does (`POST /api/v2/turn-end-cost-advisor`), GS-01
// as the session without an advisor result; a restricted team (owned by a third user) holding the
// repository, in which the session owner is a manager and a member uploaded a session of theirs.
//
// Differences from 06, by code:
//   - there is no Token Flow sub-tab any more (see screen-registry.ts), so no admin-only row;
//   - «no Raw Logs for someone else's session» does not hold for a team OWNER: in a team view the
//     tab follows the server's answer (`canSeeRawLogs`), and the owner of a restricted team may
//     read a member's logs. A manager may not, so the negative row uses a manager.
//
// Replaces:
//   - tests/e2e/summary-tab.spec.ts (three «no console errors» + default tab)
//   - tests/e2e/harness-usage-tab.spec.ts (reachable / deep link / fallback: 1 of 6)
//   - tests/e2e/session-log-view.spec.ts, tests/e2e/session-raw-logs.spec.ts («tab opens» cases)
//   - client/src/viewer/__tests__/components/session-*-tab.test.tsx («renders» smoke cases)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadPromptSession } from '../helpers/prompt-session';
import { uploadGoldenRepo } from '../helpers/session-view';
import { addTeamRepo, createTeam, inviteAndAccept, setMemberRoles, skipNewUserNudge } from '../helpers/teams';
import { TourWalker, expectTabsOnScreen, registryTabIds } from './tour-kit';

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-05 session: detail tour @mode-a', async ({ stand, api, db, users, page }) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'tour05-owner' });
  const member = await users.user('user', { label: 'tour05-member' });
  const teamOwner = await users.user('user', { label: 'tour05-teamowner' });
  const advisorSummary = `Tour 05 advisor ${run}: trim the context before delegating`;

  const params = await test.step('setup: GS-02 + its advisor run, GS-01; a team with the repo and a member session', async () => {
    const repo = await uploadGoldenRepo(api, db, owner, ['gs-02', 'gs-01']);
    const sessionId = repo.rootId('gs-02');
    const key = await createApiKey(owner.api);
    const now = Date.now();
    const advisor = await api.post('/api/v2/turn-end-cost-advisor', {
      headers: { 'X-API-Key': key.key },
      data: {
        sessionId,
        startedAt: new Date(now - 60_000).toISOString(),
        finishedAt: new Date(now - 30_000).toISOString(),
        outcome: 'submitted',
        summary: { general: advisorSummary, costFactors: ['Large context re-sent each turn'], harnessAdvice: ['Use a sub-agent for research'] },
        cost: { model: 'claude-haiku-4-5', costUsd: 0.0012, inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    expect(advisor.status(), await advisor.text()).toBe(200);

    // OWNER is a manager (not the owner) of the restricted team: a manager sees a member's session
    // in the list but may not read its logs, which is the Raw Logs negative case.
    const teamId = await createTeam(teamOwner, `Tour05 ${run}`);
    await inviteAndAccept(teamOwner, owner, teamId, 'restricted');
    await inviteAndAccept(teamOwner, member, teamId, 'restricted');
    await setMemberRoles(teamOwner, teamId, owner.id, { isManager: true });
    await addTeamRepo(teamOwner, teamId, repo.repoUrl);
    const memberKey = await createApiKey(member.api);
    const foreignSessionId = `tour05-${run}-member`;
    await uploadPromptSession(
      api,
      memberKey.key,
      { sessionId: foreignSessionId, prompt: `member session ${run}`, repoUrl: repo.repoUrl },
      { db, userId: member.id },
    );
    return {
      repoId: repo.repoId,
      teamId,
      sessionId,
      plainSessionId: repo.rootId('gs-01'),
      foreignSessionId,
      advisorSummary,
    };
  });

  const walker = new TourWalker({ story: 'tour-05', mode: stand.mode, params });
  walker.attach(page);
  await skipNewUserNudge(page);
  await owner.signIn(page);
  const clickTab = (group: string, id: string) => async () => {
    await page.getByTestId(`tab-${group}-${id}`).click();
  };

  await walker.screen(page, 'session.summary', {
    check: () => expectTabsOnScreen(page, 'session', registryTabIds(walker, 'session')),
  });
  for (const id of ['info', 'logs', 'bash', 'advisor', 'usage', 'change-surface', 'harness-usage', 'okf', 'tools', 'raw-logs']) {
    await walker.screen(page, `session.${id}`, { go: clickTab('session', id) });
  }

  await walker.screen(page, 'session.charts', {
    go: async () => {
      // The sub-tab is remembered per browser; the walk starts on the default one.
      await page.evaluate(() => localStorage.removeItem('charts-sub-tab'));
      await page.getByTestId('tab-session-charts').click();
    },
    check: () => expectTabsOnScreen(page, 'chart', registryTabIds(walker, 'chart')),
  });
  for (const id of registryTabIds(walker, 'chart')) {
    await walker.screen(page, `session.charts.${id}`, { go: clickTab('chart', id) });
  }

  await walker.screen(page, 'session.call-tree.redirect');
  await walker.screen(page, 'session.advisor.absent-redirect', {
    check: async () => {
      await expect(page.getByTestId('tab-session-advisor')).toHaveCount(0);
      await expect(page).not.toHaveURL(/tab=advisor/);
    },
  });
  await walker.screen(page, 'session.raw-logs.hidden-for-foreign', {
    check: async () => {
      await expect(page.getByTestId('tab-session-raw-logs')).toHaveCount(0);
      await expect(page).not.toHaveURL(/tab=raw-logs/);
    },
  });

  walker.finish();
});
