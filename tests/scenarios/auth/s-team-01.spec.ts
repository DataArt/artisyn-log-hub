// S-TEAM-01. An owner creates a team and invites colleagues; a colleague accepts through the bell
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-TEAM-01; any mode → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3).
//
// Code facts that differ from the design text:
//   - the duplicate-invitation error reads «Pending invitation already exists» (409);
//   - the team list labels the caller's role «Owner» under the team name; the access-mode badge
//     sits in the top bar on every team route (`AccessModeBadge`, «<team> — Restricted team»).
//
// Replaces:
//   - server/test/team-invitations.e2e-spec.ts (≈4: accept without / with a wrong / with the right mode)
//   - server/test/access-management.e2e-spec.ts («Team CRUD / membership / GET invitations», ≈14)
//   - client/src/viewer/__tests__/components/NotificationBell.test.tsx (15)
//   - client/src/viewer/__tests__/components/team-disclosure-modal.test.tsx (18)
//   - client/src/viewer/__tests__/components/TeamInvitationsTab.test.tsx (the non-force cases)
import type { Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { browserAs, createTeam, invite, skipNewUserNudge, type TeamInvitation } from '../helpers/teams';
import {
  DISCLOSURE_RESTRICTED_BULLETS,
  DISCLOSURE_RESTRICTED_CHECKBOX,
  RESTRICTED_SESSIONS_NOTICE,
} from '../../../client/src/viewer/lib/access-mode-copy';

const bell = (page: Page) => page.getByRole('button', { name: 'Notifications' });

test('@S-TEAM-01 owner creates a team, invites, a colleague accepts through the bell @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const runId = randomBytes(4).toString('hex');
  const teamName = `Alpha-${runId}`;
  const repoUrl = `https://git.arrakis.test/scn/${runId}/team1`;
  const ownerPrompt = `owner prompt ${runId}`;
  const owner = await users.user('user', { label: 'team1-owner' });
  const m1 = await users.user('user', { label: 'team1-m1' });
  const m2 = await users.user('user', { label: 'team1-m2' });

  const ownerKey = await createApiKey(owner.api);
  await uploadPromptSession(api, ownerKey.key, { sessionId: `team1-${runId}`, prompt: ownerPrompt, repoUrl }, { db, userId: owner.id });
  const ownerRepoId = await ownRepoId(owner.api, repoUrl);

  await skipNewUserNudge(page.context());
  await owner.signIn(page);
  const m1Browser = await browserAs(browser, stand.url, m1);
  const m2Browser = await browserAs(browser, stand.url, m2);
  const m1Page = m1Browser.page;
  const m2Page = m2Browser.page;

  try {
    const teamId = await test.step('1. UI (OWNER): «Add Team» → «Alpha-<run>» → Create opens the team page', async () => {
      await page.goto('/#/teams');
      await page.getByRole('button', { name: 'Add Team' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('New Team')).toBeVisible();
      await dialog.getByPlaceholder('Team name').fill(teamName);
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(page).toHaveURL(/#\/teams\/\d+$/);
      return Number(/#\/teams\/(\d+)$/.exec(page.url())![1]);
    });

    await test.step('2. UI: Members / Repositories / Invitations tabs, OWNER alone; restricted by default; «Owner» in the list', async () => {
      for (const t of ['members', 'repositories', 'invitations']) {
        await expect(page.getByTestId(`tab-team-${t}`)).toBeVisible();
      }
      await expect(page.getByTestId('tab-team-members')).toHaveAttribute('data-state', 'active');
      const members = page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: '@' });
      await expect(members).toHaveCount(1);
      await expect(members).toContainText(owner.email);
      await expect(page.getByTestId('access-mode-badge')).toHaveAccessibleName(`${teamName} — Restricted team`);
      const team = (await (await owner.api.get(`/api/v1/teams/${teamId}`)).json()) as { accessMode: string };
      expect(team.accessMode).toBe('restricted');

      await page.goto('/#/teams');
      await expect(page.getByRole('listitem').filter({ hasText: teamName })).toContainText('Owner');
      await page.goto(`/#/teams/${teamId}`);
    });

    await test.step('3. API (OWNER): POST /teams with the same name → 409', async () => {
      expect((await owner.api.post('/api/v1/teams', { data: { name: teamName } })).status()).toBe(409);
    });

    await test.step('4. UI: Repositories → pick the repository from «My repositories» → listed with 1 session', async () => {
      await page.getByTestId('tab-team-repositories').click();
      await page.getByRole('listitem').filter({ hasText: repoUrl }).getByText('+ Add').click();
      await expect(page.getByRole('row').filter({ hasText: repoUrl }).getByRole('cell', { name: '1', exact: true })).toBeVisible();
      const repos = (await (await owner.api.get(`/api/v1/teams/${teamId}/repositories`)).json()) as Array<{
        repoUrl: string;
        sessionCount: number;
        repositoryId: number;
      }>;
      expect(repos).toEqual([expect.objectContaining({ repoUrl, sessionCount: 1, repositoryId: ownerRepoId })]);
    });

    await test.step('5–6. UI: invite M1 (pending), again → «Pending invitation already exists»; invite M2', async () => {
      await page.getByTestId('tab-team-members').click();
      const inviteBox = page.getByRole('tabpanel').locator('form').filter({ has: page.getByRole('button', { name: 'Invite' }) });
      const send = async (email: string) => {
        const response = page.waitForResponse((r) => r.url().endsWith(`/api/v1/teams/${teamId}/invitations`));
        await inviteBox.getByPlaceholder('Email address').fill(email);
        await inviteBox.getByRole('button', { name: 'Invite' }).click();
        const status = (await response).status();
        // The form clears the field in onSuccess, which can run after Playwright already saw the
        // response — wait for it, or the next fill is wiped and the click submits nothing.
        if (status === 201) await expect(inviteBox.getByPlaceholder('Email address')).toHaveValue('');
        return status;
      };
      expect(await send(m1.email)).toBe(201);
      expect(await send(m1.email)).toBe(409);
      await expect(page.getByText('Pending invitation already exists')).toBeVisible();
      expect(await send(m2.email)).toBe(201);

      await page.getByTestId('tab-team-invitations').click();
      for (const email of [m1.email, m2.email]) {
        await expect(page.getByRole('listitem').filter({ hasText: email })).toContainText('pending');
      }
    });

    await test.step('7. UI (M1): the bell shows «1»; the panel lists the team with «Restricted»; OWNER has no badge', async () => {
      await m1Page.reload();
      await expect(bell(m1Page)).toHaveText('1');
      await bell(m1Page).click();
      await expect(m1Page.getByText('Team invitations')).toBeVisible();
      const item = m1Page.getByRole('listitem').filter({ hasText: teamName });
      await expect(item).toContainText('Restricted');
      await page.reload();
      await expect(bell(page)).toHaveText('');
    });

    await test.step('8. UI (M1): Accept opens the restricted disclosure; «Accept invitation» needs the checkbox; then M1 is a member', async () => {
      await m1Page.getByRole('listitem').filter({ hasText: teamName }).getByRole('button', { name: 'Accept' }).click();
      const modal = m1Page.getByTestId('team-disclosure-modal');
      await expect(modal.getByText(`Before you join ${teamName}`)).toBeVisible();
      await expect(modal.getByRole('listitem')).toHaveText(DISCLOSURE_RESTRICTED_BULLETS);
      const accept = modal.getByRole('button', { name: 'Accept invitation' });
      const checkbox = modal.getByRole('checkbox', { name: DISCLOSURE_RESTRICTED_CHECKBOX });
      await expect(accept).toBeDisabled();
      await checkbox.check();
      await checkbox.uncheck();
      await expect(accept).toBeDisabled();
      await checkbox.check();
      const request = m1Page.waitForRequest((r) => r.url().includes('/api/v1/invitations/') && r.method() === 'PATCH');
      await accept.click();
      expect((await request).postDataJSON()).toEqual({ action: 'accept', acknowledgedAccessMode: 'restricted' });
      await expect(modal).toHaveCount(0);
      await expect(bell(m1Page)).toHaveText('');
    });

    await test.step('9. UI (M2): Decline opens no disclosure; M2 is not a member; the badge is gone', async () => {
      await m2Page.reload();
      await expect(bell(m2Page)).toHaveText('1');
      await bell(m2Page).click();
      const response = m2Page.waitForResponse((r) => r.url().includes('/api/v1/invitations/') && r.request().method() === 'PATCH');
      await m2Page.getByRole('listitem').filter({ hasText: teamName }).getByRole('button', { name: 'Decline' }).click();
      expect((await response).status()).toBe(200);
      await expect(m2Page.getByTestId('team-disclosure-modal')).toHaveCount(0);
      await expect(bell(m2Page)).toHaveText('');
    });

    await test.step('10. UI (OWNER): Members has M1 and not M2; Invitations reads accepted/declined; M2 can be re-invited (201)', async () => {
      await page.reload();
      await page.getByTestId('tab-team-members').click();
      const panel = page.getByRole('tabpanel');
      await expect(panel.getByRole('listitem').filter({ hasText: m1.email })).toContainText('Member');
      await expect(panel.getByRole('listitem').filter({ hasText: m2.email })).toHaveCount(0);
      await page.getByTestId('tab-team-invitations').click();
      await expect(page.getByRole('listitem').filter({ hasText: m1.email })).toContainText('accepted');
      await expect(page.getByRole('listitem').filter({ hasText: m2.email })).toContainText('declined');
      await page.getByPlaceholder('Email address to invite').fill(m2.email);
      const response = page.waitForResponse((r) => r.url().endsWith(`/api/v1/teams/${teamId}/invitations`));
      await page.getByRole('button', { name: 'Send invite' }).click();
      expect((await response).status()).toBe(201);
    });

    await test.step('11. UI (M1): left menu → team → repository; the team and repo are visible, «owner prompt» is not', async () => {
      await m1Page.goto('/#/teams');
      await m1Page.reload();
      const nav = m1Page.locator('nav').filter({ hasText: 'Add Team' });
      await nav.getByRole('button', { name: teamName }).locator('xpath=..').getByRole('button', { name: 'Expand' }).click();
      await nav.getByRole('button', { name: repoUrl }).click();
      await expect(m1Page).toHaveURL(new RegExp(`#/teams/${teamId}/repos/${ownerRepoId}`));
      await expect(m1Page.getByTestId('restricted-sessions-notice')).toHaveText(RESTRICTED_SESSIONS_NOTICE);
      await expect(m1Page.getByText(ownerPrompt)).toHaveCount(0);
      const sessions = (await (await m1.api.get(`/api/v1/repositories/${ownerRepoId}/sessions?teamId=${teamId}`)).json()) as unknown[];
      expect(sessions).toEqual([]);
    });

    await test.step('API: accept needs the right acknowledged mode; someone else’s invitation → 403; GET /invitations both ways', async () => {
      const m2Invites = (await (await m2.api.get('/api/v1/invitations')).json()) as TeamInvitation[];
      const pending = m2Invites.find((i) => i.teamId === teamId && i.status === 'pending');
      expect(pending).toBeDefined();
      const respond = (who: typeof m1, data: Record<string, unknown>) =>
        who.api.patch(`/api/v1/invitations/${pending!.id}`, { data });
      expect((await respond(m2, { action: 'accept' })).status()).toBe(400);
      expect((await respond(m2, { action: 'accept', acknowledgedAccessMode: 'transparent' })).status()).toBe(400);
      const foreign = await respond(m1, { action: 'decline' });
      expect(foreign.status()).toBe(403);
      expect(await foreign.text()).toContain('Not your invitation');
      const members = (await (await owner.api.get(`/api/v1/teams/${teamId}/members`)).json()) as Array<{ userId: number }>;
      expect(members.map((m) => m.userId)).not.toContain(m2.id);

      // OWNER sees both directions: what they sent and what was sent to them.
      const otherTeam = await createTeam(m2, `Beta-${runId}`);
      const toOwner = await invite(m2, otherTeam, owner.email);
      const ownerInvites = (await (await owner.api.get('/api/v1/invitations')).json()) as TeamInvitation[];
      expect(ownerInvites.filter((i) => i.inviterId === owner.id).length).toBeGreaterThanOrEqual(3);
      expect(ownerInvites.map((i) => i.id)).toContain(toOwner.id);
    });
  } finally {
    await m1Browser.context.close();
    await m2Browser.context.close();
  }
});
