// S-TEAM-03. A `transparent` team: everyone sees everyone, the switch locks
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-TEAM-03; any mode → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3).
//
// Code facts that differ from the design text:
//   - step 11: `PATCH /teams/:id` is behind TeamOwnerGuard, so a non-owner gets 403 whatever the
//     body; «No fields to update» (400) is what the owner gets for an empty body;
//   - steps 5–6: the design expects another member's raw logs to stay 403 in a transparent team.
//     The code deliberately opens them («every member sees everything, raw logs included»,
//     server/test/team-cross-member-sessions.e2e-spec.ts and `resolveTeamScope`), so the design
//     text is the error here (task Notes) and the step pins 200 for M1 and the owner alike;
//   - the "roles change nothing in transparent" check covers the session list and analytics.
//
// Replaces:
//   - server/test/team-cross-member-sessions.e2e-spec.ts (16)
//   - server/test/access-management.e2e-spec.ts (transparent switch and its lock, non-owner
//     accessMode change, PATCH with no fields: 4)
//   - client/src/viewer/__tests__/components/TeamMembersTab.test.tsx (24: modes, lock, awaiting label)
//   - client/src/viewer/__tests__/components/repository-view.test.tsx (transparent group and the
//     personal route, ≈6)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import {
  addTeamRepo,
  browserAs,
  createTeam,
  invite,
  inviteAndAccept,
  setMemberRoles,
  skipNewUserNudge,
} from '../helpers/teams';
import {
  DISCLOSURE_TRANSPARENT_BULLETS,
  DISCLOSURE_TRANSPARENT_CHECKBOX,
  RESTRICTED_SESSIONS_NOTICE,
  transparentLockNote,
} from '../../../client/src/viewer/lib/access-mode-copy';

interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
}

test('@S-TEAM-03 transparent team: everyone sees everyone, the switch locks @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const runId = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${runId}/open`;
  const owner = await users.user('user', { label: 'trn-owner' });
  const m1 = await users.user('user', { label: 'trn-m1' });
  const m2 = await users.user('user', { label: 'trn-m2' });
  const sid = (who: string) => `trn-${runId}-${who}`;
  const prompt = (who: string) => `open-${who} ${runId}`;
  const range = rangeAround();
  const everyone = ['owner', 'm1', 'm2'].map(sid).sort();

  const openTeam = await createTeam(owner, `Open-${runId}`);
  const lockedTeam = await createTeam(owner, `Locked-${runId}`);
  await inviteAndAccept(owner, m1, lockedTeam);
  for (const [who, user] of [
    ['owner', owner],
    ['m1', m1],
    ['m2', m2],
  ] as Array<[string, ScenarioUser]>) {
    const key = await createApiKey(user.api);
    await uploadPromptSession(api, key.key, { sessionId: sid(who), prompt: prompt(who), repoUrl }, { db, userId: user.id });
  }
  await addTeamRepo(owner, openTeam, repoUrl);
  const repoId = await ownRepoId(owner.api, repoUrl);
  const base = `/api/v1/repositories/${repoId}`;
  const list = async (user: ScenarioUser) => {
    const res = await user.api.get(`${base}/sessions?teamId=${openTeam}`);
    expect(res.status()).toBe(200);
    return (await res.json()) as SessionRow[];
  };
  const logsOf = (who: string) => `${base}/sessions/${sid(who)}/logs?teamId=${openTeam}`;
  const cards = page.getByTestId('team-access-mode-cards');

  await skipNewUserNudge(page.context());
  await owner.signIn(page);

  await test.step('1. UI (OWNER, «Open»): two cards, Restricted by default; Transparent is selectable while the team is empty', async () => {
    await page.goto(`/#/teams/${openTeam}`);
    await expect(cards.getByRole('radio', { name: 'Restricted' })).toBeChecked();
    await expect(cards.getByText('default', { exact: true })).toBeVisible();
    const response = page.waitForResponse((r) => r.url().endsWith(`/api/v1/teams/${openTeam}`) && r.request().method() === 'PATCH');
    await cards.getByRole('radio', { name: 'Transparent' }).click();
    expect((await response).status()).toBe(200);
    await expect(cards.getByRole('radio', { name: 'Transparent' })).toBeChecked();
    await expect(page.getByTestId('access-mode-badge')).toContainText('Transparent');
  });

  await test.step('2–3. UI (M1): the bell → Accept shows the transparent disclosure; M2 accepts through the API', async () => {
    await invite(owner, openTeam, m1.email);
    const m2Invite = await invite(owner, openTeam, m2.email);
    const { context, page: m1Page } = await browserAs(browser, stand.url, m1);
    try {
      await m1Page.getByRole('button', { name: 'Notifications' }).click();
      await m1Page.getByRole('listitem').filter({ hasText: `Open-${runId}` }).getByRole('button', { name: 'Accept' }).click();
      const modal = m1Page.getByTestId('team-disclosure-modal');
      await expect(modal.getByRole('listitem')).toHaveText(DISCLOSURE_TRANSPARENT_BULLETS);
      await modal.getByRole('checkbox', { name: DISCLOSURE_TRANSPARENT_CHECKBOX }).check();
      const request = m1Page.waitForRequest((r) => r.url().includes('/api/v1/invitations/') && r.method() === 'PATCH');
      await modal.getByRole('button', { name: 'Accept invitation' }).click();
      expect((await request).postDataJSON()).toEqual({ action: 'accept', acknowledgedAccessMode: 'transparent' });
      await expect(modal).toHaveCount(0);
    } finally {
      await context.close();
    }
    const res = await m2.api.patch(`/api/v1/invitations/${m2Invite.id}`, {
      data: { action: 'accept', acknowledgedAccessMode: 'transparent' },
    });
    expect(res.status()).toBe(200);
  });

  await test.step('4. API+UI (M1): every session with prompts; branches, contexts, timeline, work-time span the team; Analytics/Reports tabs', async () => {
    const rows = await list(m1);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(everyone);
    expect(rows.every((r) => r.firstPrompt !== null)).toBe(true);
    expect((await m1.api.get(`${base}/sessions/branches?teamId=${openTeam}`)).status()).toBe(200);
    expect((await m1.api.get(`${base}/contexts?teamId=${openTeam}`)).status()).toBe(200);
    const timeline = await m1.api.get(`${base}/analytics/timeline?teamId=${openTeam}&${range}`);
    expect(timeline.status()).toBe(200);
    expect(await timeline.text()).toContain(prompt('owner'));
    const workTime = await m1.api.get(`${base}/analytics/work-time?teamId=${openTeam}&${range}&groupBy=user`);
    expect(workTime.status()).toBe(200);
    expect(await workTime.text()).toContain(owner.email);

    const { context, page: m1Page } = await browserAs(browser, stand.url, m1, `/#/teams/${openTeam}/repos/${repoId}`);
    try {
      for (const who of ['owner', 'm1', 'm2']) await expect(m1Page.getByText(prompt(who))).toBeVisible();
      await expect(m1Page.getByTestId('tab-repo-analytics')).toBeVisible();
      await expect(m1Page.getByTestId('tab-repo-reports')).toBeVisible();
      await expect(m1Page.getByTestId('access-mode-badge')).toContainText('Transparent');
      await expect(m1Page.getByTestId('restricted-sessions-notice')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('5–6. API: in transparent M1 reads every member’s raw logs, like the owner (200)', async () => {
    for (const who of ['owner', 'm1', 'm2']) {
      const res = await m1.api.get(logsOf(who));
      expect(res.status(), who).toBe(200);
      expect(await res.text(), who).toContain(prompt(who));
    }
    for (const who of ['m1', 'm2']) expect((await owner.api.get(logsOf(who))).status(), who).toBe(200);
  });

  await test.step('roles do not change visibility in transparent: M2 as trainer/manager sees the same list and analytics', async () => {
    const before = (await list(m2)).map((r) => r.sessionId).sort();
    expect((await m2.api.get(`${base}/analytics/timeline?teamId=${openTeam}&${range}`)).status()).toBe(200);
    await setMemberRoles(owner, openTeam, m2.id, { isAdlcTrainer: true, isManager: true });
    expect((await list(m2)).map((r) => r.sessionId).sort()).toEqual(before);
    expect((await m2.api.get(`${base}/analytics/timeline?teamId=${openTeam}&${range}`)).status()).toBe(200);
    await setMemberRoles(owner, openTeam, m2.id, { isAdlcTrainer: false, isManager: false });
  });

  await test.step('7. UI (OWNER, «Locked»): Transparent is disabled and the amber lock note is there up front', async () => {
    await page.goto(`/#/teams/${lockedTeam}`);
    await expect(cards.getByRole('radio', { name: 'Transparent' })).toBeDisabled();
    await expect(page.getByTestId('transparent-lock-note')).toHaveText(transparentLockNote(1));
  });

  await test.step('8. API (OWNER): PATCH «Locked» to transparent → 409', async () => {
    const res = await owner.api.patch(`/api/v1/teams/${lockedTeam}`, { data: { accessMode: 'transparent' } });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('Cannot switch to transparent: the team has members besides the owner');
  });

  await test.step('9. UI (OWNER, «Open»): switching back to Restricted is always allowed', async () => {
    await page.goto(`/#/teams/${openTeam}`);
    await expect(cards.getByRole('radio', { name: 'Transparent' })).toBeChecked();
    const response = page.waitForResponse((r) => r.url().endsWith(`/api/v1/teams/${openTeam}`) && r.request().method() === 'PATCH');
    await cards.getByRole('radio', { name: 'Restricted' }).click();
    expect((await response).status()).toBe(200);
    await expect(cards.getByRole('radio', { name: 'Restricted' })).toBeChecked();
  });

  await test.step('10. UI+API (M1): back in restricted M1 sees only own sessions (others’ raw logs 403), with the notice', async () => {
    expect((await list(m1)).map((r) => r.sessionId)).toEqual([sid('m1')]);
    expect((await m1.api.get(logsOf('owner'))).status()).toBe(403);
    const { context, page: m1Page } = await browserAs(browser, stand.url, m1, `/#/teams/${openTeam}/repos/${repoId}`);
    try {
      await expect(m1Page.getByTestId('restricted-sessions-notice')).toHaveText(RESTRICTED_SESSIONS_NOTICE);
      await expect(m1Page.getByText(prompt('owner'))).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('11. API: a non-owner PATCH → 403; the owner’s PATCH with no fields → 400 «No fields to update»', async () => {
    expect((await m1.api.patch(`/api/v1/teams/${openTeam}`, { data: { accessMode: 'restricted' } })).status()).toBe(403);
    const empty = await owner.api.patch(`/api/v1/teams/${openTeam}`, { data: {} });
    expect(empty.status()).toBe(400);
    expect(await empty.text()).toContain('No fields to update');
  });
});
