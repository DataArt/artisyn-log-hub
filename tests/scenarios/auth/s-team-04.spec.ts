// S-TEAM-04. Inviting an unregistered e-mail, and the disclosure gate at the first login
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-TEAM-04).
//
// Mode A only. The force-invite creates a password-less placeholder account
// (`findOrCreateAutoProvisioned`); only the identify login (mode A) and Azure claim it. In the
// password modes `POST /auth/signup` answers 409 «Email already registered» for that address and
// login needs a password the placeholder does not have, so the invited person cannot get in at
// all without a reset link — recorded in the task Notes; the design's "B: signup + confirm for
// the invitee" is not reachable in the code as it is.
//
// Code facts that differ from the design text:
//   - step 3: `force: true` for a registered e-mail is ignored — an ordinary pending invitation.
//     The placeholder created by the first force-invite counts as registered, so the second team
//     («Force2») reuses the same user id but gets an ordinary pending invitation (the bell), not a
//     second membership with a pending disclosure;
//   - the gate's button is «Acknowledge» and the dialog has no Cancel / close control.
//
// Replaces:
//   - server/test/team-invitations.e2e-spec.ts (5: force branch, placeholder, reuse, canInvite, auto-accept)
//   - server/test/team-access-mode.e2e-spec.ts (force-invited member before/after acknowledgement,
//     GET /teams/pending-disclosures, POST /:teamId/acknowledge-disclosure: ≈11)
//   - client/src/viewer/__tests__/components/TeamInvitationsTab.test.tsx (2: unregistered e-mail)
//   - the PendingDisclosureGate UI behaviour
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import {
  addTeamRepo,
  browserAs,
  createTeam,
  inviteAndAccept,
  setMemberRoles,
  skipNewUserNudge,
  type TeamInvitation,
} from '../helpers/teams';
import { AWAITING_DISCLOSURE_LABEL } from '../../../client/src/viewer/lib/access-mode-copy';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Member {
  userId: number;
  email: string;
  disclosureAcknowledgedAt: string | null;
}

test('@S-TEAM-04 unregistered e-mail invite and the disclosure gate at first login @mode-a', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const runId = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${runId}/force`;
  const lateEmail = `late-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
  const teamName = `Force-${runId}`;
  const owner = await users.user('user', { label: 'frc-owner' });
  const tr = await users.user('user', { label: 'frc-tr' });
  const mReg = await users.user('user', { label: 'frc-mreg' });
  const outsider = await users.user('user', { label: 'frc-x' });

  const teamId = await createTeam(owner, teamName);
  await inviteAndAccept(owner, tr, teamId);
  await inviteAndAccept(owner, mReg, teamId);
  await setMemberRoles(owner, teamId, tr.id, { isAdlcTrainer: true });
  const ownerKey = await createApiKey(owner.api);
  await uploadPromptSession(api, ownerKey.key, { sessionId: `frc-${runId}-owner`, prompt: `force owner ${runId}`, repoUrl }, { db, userId: owner.id });
  await addTeamRepo(owner, teamId, repoUrl);
  const repoId = await ownRepoId(owner.api, repoUrl);
  const base = `/api/v1/repositories/${repoId}`;
  const lateSession = `frc-${runId}-late`;
  const members = async () =>
    (await (await owner.api.get(`/api/v1/teams/${teamId}/members`)).json()) as Member[];

  await skipNewUserNudge(page.context());
  await owner.signIn(page);

  await test.step('1–2. UI (OWNER): invite late-… → 404 user_not_registered → «Add anyway» → 201; «awaiting disclosure» at once', async () => {
    await page.goto(`/#/teams/${teamId}`);
    const responses: Array<{ status: number; body: string }> = [];
    page.on('response', async (r) => {
      if (r.url().endsWith(`/api/v1/teams/${teamId}/invitations`)) responses.push({ status: r.status(), body: await r.text() });
    });
    const form = page.getByRole('tabpanel').locator('form').filter({ has: page.getByRole('button', { name: 'Invite' }) });
    await form.getByPlaceholder('Email address').fill(lateEmail);
    await form.getByRole('button', { name: 'Invite' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Not registered yet' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Add anyway' }).click();
    const row = page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: lateEmail });
    await expect(row).toContainText(AWAITING_DISCLOSURE_LABEL);
    expect(responses.map((r) => r.status)).toEqual([404, 201]);
    expect(responses[0].body).toContain('user_not_registered');

    await page.getByTestId('tab-team-invitations').click();
    await expect(page.getByRole('listitem').filter({ hasText: lateEmail })).toContainText('pending');
  });

  const { placeholderId, team2 } = await test.step('3. API: the placeholder is a member at once; a second team reuses it; force on a registered e-mail is ignored', async () => {
    const late = (await members()).find((m) => m.email === lateEmail);
    expect(late).toBeDefined();
    expect(late!.disclosureAcknowledgedAt).toBeNull();
    const invitations = (await (await owner.api.get('/api/v1/invitations')).json()) as TeamInvitation[];
    expect(invitations.filter((i) => i.inviteeEmail === lateEmail).map((i) => i.status)).toEqual(['pending']);

    const team2 = await createTeam(owner, `Force2-${runId}`);
    const second = await owner.api.post(`/api/v1/teams/${team2}/invitations`, { data: { email: lateEmail, force: true } });
    expect(second.status()).toBe(201);
    expect(await second.json()).toMatchObject({ inviteeId: late!.userId, status: 'pending' });

    const registered = await owner.api.post(`/api/v1/teams/${team2}/invitations`, { data: { email: mReg.email, force: true } });
    expect(registered.status()).toBe(201);
    expect(((await registered.json()) as TeamInvitation).status).toBe('pending');
    const team2Members = (await (await owner.api.get(`/api/v1/teams/${team2}/members`)).json()) as Member[];
    expect(team2Members.map((m) => m.userId)).not.toContain(mReg.id);
    expect(team2Members.map((m) => m.userId)).not.toContain(late!.userId);
    return { placeholderId: late!.userId, team2 };
  });

  const late = await test.step('4. API (invited): the first login lands in Force without Accept, its disclosure pending; Force2 stays an invitation', async () => {
    const user: ScenarioUser = await users.user('user', { email: lateEmail });
    expect(user.id).toBe(placeholderId);
    const pending = (await (await user.api.get('/api/v1/teams/pending-disclosures')).json()) as Array<{ teamName: string; accessMode: string }>;
    expect(pending).toEqual([expect.objectContaining({ teamName, accessMode: 'restricted' })]);
    const invitations = (await (await user.api.get('/api/v1/invitations')).json()) as TeamInvitation[];
    expect(invitations.find((i) => i.teamId === teamId)?.status).toBe('accepted');
    expect(invitations.find((i) => i.teamId === team2)?.status).toBe('pending');
    return user;
  });

  await test.step('7. API: before acknowledging, the invitee’s session is invisible to OWNER and TR; raw logs 403 even for OWNER', async () => {
    const key = await createApiKey(late.api);
    await uploadPromptSession(api, key.key, { sessionId: lateSession, prompt: `late prompt ${runId}`, repoUrl }, { db, userId: late.id });
    const from = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const to = new Date(Date.now() + DAY_MS).toISOString();
    for (const viewer of [owner, tr]) {
      const list = (await (await viewer.api.get(`${base}/sessions?teamId=${teamId}`)).json()) as Array<{ sessionId: string }>;
      expect(list.map((s) => s.sessionId)).not.toContain(lateSession);
      expect((await viewer.api.get(`${base}/sessions/${lateSession}/logs?teamId=${teamId}`)).status()).toBe(403);
    }
    const scope = (await (await owner.api.get(`${base}/sessions/export-scope?teamId=${teamId}&from=${from}&to=${to}`)).json()) as Array<{ sessionId: string }>;
    expect(scope.map((s) => s.sessionId)).not.toContain(lateSession);
  });

  await test.step('5–6. UI (invited): the gate «You were added to Force-…» covers the app, cannot be dismissed; Acknowledge', async () => {
    const { context, page: latePage } = await browserAs(browser, stand.url, late, '/#/teams');
    try {
      const gate = latePage.getByTestId('team-disclosure-modal');
      await expect(gate.getByText(`You were added to ${teamName}`)).toBeVisible();
      await expect(gate.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(gate.getByRole('button', { name: 'Close' })).toHaveCount(0);
      await latePage.keyboard.press('Escape');
      await expect(gate).toBeVisible();
      const acknowledge = gate.getByRole('button', { name: 'Acknowledge' });
      await expect(acknowledge).toBeDisabled();
      await gate.getByRole('checkbox').check();
      const response = latePage.waitForResponse((r) => r.url().endsWith(`/api/v1/teams/${teamId}/acknowledge-disclosure`));
      await acknowledge.click();
      expect((await response).status()).toBe(200);
      await expect(gate).toHaveCount(0);
      // Force2 waits in the bell as an ordinary invitation.
      await expect(latePage.getByRole('button', { name: 'Notifications' })).toHaveText('1');
    } finally {
      await context.close();
    }
  });

  await test.step('8. API: after acknowledging the session is listed, exported and readable; wrong mode 400; non-member 403', async () => {
    const from = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const to = new Date(Date.now() + DAY_MS).toISOString();
    for (const viewer of [owner, tr]) {
      const list = (await (await viewer.api.get(`${base}/sessions?teamId=${teamId}`)).json()) as Array<{ sessionId: string }>;
      expect(list.map((s) => s.sessionId)).toContain(lateSession);
      expect((await viewer.api.get(`${base}/sessions/${lateSession}/logs?teamId=${teamId}`)).status()).toBe(200);
    }
    const scope = (await (await owner.api.get(`${base}/sessions/export-scope?teamId=${teamId}&from=${from}&to=${to}`)).json()) as Array<{ sessionId: string }>;
    expect(scope.map((s) => s.sessionId)).toContain(lateSession);

    expect(await (await late.api.get('/api/v1/teams/pending-disclosures')).json()).toEqual([]);
    const wrong = await late.api.post(`/api/v1/teams/${teamId}/acknowledge-disclosure`, { data: { acknowledgedAccessMode: 'transparent' } });
    expect(wrong.status()).toBe(400);
    const notMember = await outsider.api.post(`/api/v1/teams/${teamId}/acknowledge-disclosure`, { data: { acknowledgedAccessMode: 'restricted' } });
    expect(notMember.status()).toBe(403);

    await page.reload();
    await page.getByTestId('tab-team-members').click();
    const row = page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: lateEmail });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(AWAITING_DISCLOSURE_LABEL);
  });

  await test.step('9. API: a member without canInvite → 403 on invite, with and without force', async () => {
    const fresh = `fresh-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
    for (const force of [false, true]) {
      const res = await mReg.api.post(`/api/v1/teams/${teamId}/invitations`, { data: { email: fresh, force } });
      expect(res.status(), `force=${force}`).toBe(403);
    }
  });
});
