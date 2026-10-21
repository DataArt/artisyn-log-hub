// S-TEAM-02. A `restricted` team: who sees what (member, owner, trainer, manager)
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-TEAM-02; any mode → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). Four representative routes stand for
// the analytics/report families (design «Что теряем»: one guard per family lives in the contract
// suite).
//
// Code facts that differ from the design text:
//   - step 8: a non-member asking for the team scope (`?teamId=`) gets 403 on the session list as
//     well — `assertRepoAccess` refuses before any filtering — not an empty list.
//
// Replaces:
//   - server/test/team-access-mode.e2e-spec.ts (≈32 of 46: restricted roles, prompt masking,
//     retroactive trainer, analytics/report gate, personal view)
//   - client/src/viewer/__tests__/components/repository-view.test.tsx (restricted group, ≈15 of 52)
//   - client/src/viewer/__tests__/components/access-mode-badge.test.tsx (13)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept, setMemberRoles } from '../helpers/teams';
import {
  ACCESS_MODE_TOOLTIP_ANALYTICS,
  PROMPT_HIDDEN_LABEL,
  RESTRICTED_SESSIONS_NOTICE,
} from '../../../client/src/viewer/lib/access-mode-copy';

interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  userEmail?: string;
}

test('@S-TEAM-02 restricted team: who sees what (member, owner, trainer, manager) @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  browser,
}) => {
  test.setTimeout(240_000);
  const runId = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${runId}/restricted`;
  const owner = await users.user('user', { label: 'rst-owner' });
  const m1 = await users.user('user', { label: 'rst-m1' });
  const m2 = await users.user('user', { label: 'rst-m2' });
  const tr = await users.user('user', { label: 'rst-tr' });
  const mg = await users.user('user', { label: 'rst-mg' });
  const tm = await users.user('user', { label: 'rst-tm' });
  const x = await users.user('user', { label: 'rst-x' });
  const uploaders: Array<[string, ScenarioUser]> = [
    ['owner', owner],
    ['m1', m1],
    ['m2', m2],
    ['tr', tr],
    ['mg', mg],
  ];
  const sid = (who: string) => `rst-${runId}-${who}`;
  const prompt = (who: string) => `prompt-${who} ${runId}`;
  const range = rangeAround();

  const { teamId, repoId } = await test.step('setup: team «Restricted-<run>», everyone accepted, one session each, roles after upload', async () => {
    const team = await createTeam(owner, `Restricted-${runId}`);
    for (const member of [m1, m2, tr, mg, tm]) await inviteAndAccept(owner, member, team);
    for (const [who, user] of uploaders) {
      const key = await createApiKey(user.api);
      await uploadPromptSession(api, key.key, { sessionId: sid(who), prompt: prompt(who), repoUrl }, { db, userId: user.id });
    }
    await addTeamRepo(owner, team, repoUrl);
    await setMemberRoles(owner, team, tr.id, { isAdlcTrainer: true });
    await setMemberRoles(owner, team, mg.id, { isManager: true });
    await setMemberRoles(owner, team, tm.id, { isAdlcTrainer: true, isManager: true });
    return { teamId: team, repoId: await ownRepoId(owner.api, repoUrl) };
  });

  const base = `/api/v1/repositories/${repoId}`;
  const list = async (user: ScenarioUser) => {
    const res = await user.api.get(`${base}/sessions?teamId=${teamId}`);
    expect(res.status(), `${user.email} session list`).toBe(200);
    return (await res.json()) as SessionRow[];
  };
  const status = async (user: ScenarioUser, path: string) => (await user.api.get(path)).status();
  const logsOf = (who: string) => `${base}/sessions/${sid(who)}/logs?teamId=${teamId}`;
  const perSession = (who: string) => [
    logsOf(who),
    `${base}/sessions/${sid(who)}/contexts?teamId=${teamId}`,
    `${base}/sessions/${sid(who)}/change-surface?teamId=${teamId}`,
    `${base}/sessions/${sid(who)}/change-surface/files?teamId=${teamId}`,
  ];
  const teamWide = [
    `${base}/analytics/timeline?teamId=${teamId}&${range}`,
    `${base}/analytics/active-sessions?teamId=${teamId}&${range}`,
    `${base}/reports/active-sessions?teamId=${teamId}&${range}`,
    `${base}/reports/executive-summary?teamId=${teamId}&${range}`,
  ];
  const everyone = uploaders.map(([who]) => sid(who)).sort();

  await test.step('1. API (M1): the team session list holds only M1’s own session', async () => {
    const rows = await list(m1);
    expect(rows.map((r) => r.sessionId)).toEqual([sid('m1')]);
    expect(rows[0].firstPrompt).toBe(prompt('m1'));
  });

  await test.step('2. UI (M1): only the Sessions tab, the restricted notice, ?mtab=analytics falls back to Sessions', async () => {
    const { context, page } = await browserAs(browser, stand.url, m1, `/#/teams/${teamId}/repos/${repoId}`);
    try {
      await expect(page.getByTestId('restricted-sessions-notice')).toHaveText(RESTRICTED_SESSIONS_NOTICE);
      await expect(page.getByText(prompt('m1'))).toBeVisible();
      await expect(page.getByText(prompt('m2'))).toHaveCount(0);
      await expect(page.locator('[data-testid^="tab-repo-"]')).toHaveCount(1);
      await expect(page.getByTestId('tab-repo-sessions')).toHaveAttribute('data-state', 'active');
      await expect(page.getByTestId('access-mode-badge')).toContainText('Restricted');
      await page.goto(`/#/teams/${teamId}/repos/${repoId}?mtab=analytics`);
      await expect(page.getByTestId('tab-repo-sessions')).toHaveAttribute('data-state', 'active');
      await expect(page.getByTestId('tab-repo-analytics')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('3. API (M1): another member’s logs, contexts, change-surface → 403; own → 200; analytics and reports → 403', async () => {
    for (const path of perSession('m2')) expect(await status(m1, path), path).toBe(403);
    for (const path of perSession('m1')) expect(await status(m1, path), path).toBe(200);
    for (const path of teamWide) expect(await status(m1, path), path).toBe(403);
  });

  await test.step('4. API (OWNER): all five sessions with prompts, M2’s raw logs, analytics with prompts', async () => {
    const rows = await list(owner);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(everyone);
    expect(rows.every((r) => r.firstPrompt !== null)).toBe(true);
    const logs = await owner.api.get(logsOf('m2'));
    expect(logs.status()).toBe(200);
    expect(await logs.text()).toContain(prompt('m2'));
    const timeline = await owner.api.get(teamWide[0]);
    expect(timeline.status()).toBe(200);
    expect(await timeline.text()).toContain(prompt('m2'));
  });

  await test.step('5. UI+API (MG): all five rows, other prompts hidden («Prompt hidden»); analytics 200; raw logs 403', async () => {
    const rows = await list(mg);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(everyone);
    for (const row of rows) expect(row.firstPrompt, row.sessionId).toBe(row.sessionId === sid('mg') ? prompt('mg') : null);
    for (const path of teamWide) expect(await status(mg, path), path).toBe(200);
    expect(await status(mg, logsOf('m2'))).toBe(403);

    const { context, page } = await browserAs(browser, stand.url, mg, `/#/teams/${teamId}/repos/${repoId}`);
    try {
      await expect(page.getByText(prompt('mg'))).toBeVisible();
      await expect(page.getByText(PROMPT_HIDDEN_LABEL, { exact: true })).toHaveCount(4);
      await expect(page.getByTestId('tab-repo-analytics')).toBeVisible();
      await expect(page.getByTestId('restricted-sessions-notice')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('6. API (TR): all five with prompts, raw logs 200; analytics and reports 403', async () => {
    const rows = await list(tr);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(everyone);
    expect(rows.every((r) => r.firstPrompt !== null)).toBe(true);
    expect(await status(tr, logsOf('m2'))).toBe(200);
    for (const path of teamWide) expect(await status(tr, path), path).toBe(403);
  });

  await test.step('7. API (TM, trainer + manager): analytics 200, prompts visible, raw logs 200', async () => {
    for (const path of teamWide) expect(await status(tm, path), path).toBe(200);
    expect((await list(tm)).every((r) => r.firstPrompt !== null)).toBe(true);
    expect(await status(tm, logsOf('m2'))).toBe(200);
  });

  await test.step('8. API (X, not a member): the team scope → 403 for the list and for analytics', async () => {
    expect(await status(x, `${base}/sessions?teamId=${teamId}`)).toBe(403);
    expect(await status(x, teamWide[0])).toBe(403);
  });

  await test.step('9. API: the trainer role given to M1 after the upload opens M2’s existing session at once', async () => {
    expect(await status(m1, logsOf('m2'))).toBe(403);
    await setMemberRoles(owner, teamId, m1.id, { isAdlcTrainer: true });
    expect(await status(m1, logsOf('m2'))).toBe(200);
    expect((await list(m1)).map((r) => r.sessionId).sort()).toEqual(everyone);
  });

  await test.step('10. API: without teamId everyone sees only their own sessions, and analytics is open', async () => {
    for (const [who, user] of uploaders) {
      const own = await ownRepoId(user.api, repoUrl);
      const res = await user.api.get(`/api/v1/repositories/${own}/sessions`);
      expect(res.status()).toBe(200);
      expect(((await res.json()) as SessionRow[]).map((r) => r.sessionId), who).toEqual([sid(who)]);
      expect(await status(user, `/api/v1/repositories/${own}/analytics/timeline?${range}`), who).toBe(200);
    }
  });

  await test.step('11. UI (OWNER): the badge hint names the owner and the trainers, not managers or members', async () => {
    const { context, page } = await browserAs(browser, stand.url, owner, `/#/teams/${teamId}`);
    try {
      await page.getByTestId('access-mode-badge').hover();
      const hint = page.getByTestId('access-mode-badge-tooltip');
      await expect(hint).toContainText(`${owner.email} (owner)`);
      for (const trainer of [tr, tm, m1]) await expect(hint).toContainText(`${trainer.email} (trainer)`);
      await expect(hint).toContainText(ACCESS_MODE_TOOLTIP_ANALYTICS);
      for (const other of [mg, m2]) await expect(hint).not.toContainText(other.email);
    } finally {
      await context.close();
    }
  });

  // The admin role grants no data access and no team powers (2026-10-21-private-repo-visibility).
  const admin = await users.user('admin', { label: 'rst-admin' });

  await test.step('12. API (ADMIN, not a member): no team in GET /teams; team detail, members, repositories, sessions, logs → 403; invite, remove member, unlink → 403', async () => {
    const teams = (await (await admin.api.get('/api/v1/teams')).json()) as Array<{ id: number }>;
    expect(teams.map((t) => t.id)).not.toContain(teamId);
    for (const path of [
      `/api/v1/teams/${teamId}`,
      `/api/v1/teams/${teamId}/members`,
      `/api/v1/teams/${teamId}/repositories`,
      `${base}/sessions?teamId=${teamId}`,
      logsOf('m2'),
      teamWide[0],
    ]) {
      const res = await admin.api.get(path);
      expect(res.status(), path).toBe(403);
      expect(await res.text(), path).not.toContain(prompt('m2'));
    }
    const links = (await (await owner.api.get(`/api/v1/teams/${teamId}/repositories`)).json()) as Array<{ id: number }>;
    expect((await admin.api.post(`/api/v1/teams/${teamId}/invitations`, { data: { email: x.email } })).status()).toBe(403);
    expect((await admin.api.delete(`/api/v1/teams/${teamId}/members/${m2.id}`)).status()).toBe(403);
    expect((await admin.api.delete(`/api/v1/teams/${teamId}/repositories/${links[0].id}/link`)).status()).toBe(403);
    expect((await (await owner.api.get(`/api/v1/teams/${teamId}/repositories`)).json()) as unknown[]).toHaveLength(links.length);
  });

  await test.step('13. UI (ADMIN, not a member): no «Teams as Admin», no «View as Admin», the team page shows no «Viewing as Admin» and no member', async () => {
    const { context, page } = await browserAs(browser, stand.url, admin, '/#/teams');
    try {
      await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
      await expect(page.getByText('Teams as Admin')).toHaveCount(0);
      await expect(page.getByText('View as Admin')).toHaveCount(0);
      await expect(page.getByText(`Restricted-${runId}`)).toHaveCount(0);
      await page.goto(`/#/teams/${teamId}`);
      await expect(page.getByText('Viewing as Admin')).toHaveCount(0);
      await expect(page.getByText(m2.email)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('14. API (ADMIN as a plain member): sees what a plain member sees — only own rows, other prompts and logs closed; no acknowledgement data', async () => {
    await inviteAndAccept(owner, admin, teamId);
    expect(((await (await admin.api.get('/api/v1/teams')).json()) as Array<{ id: number }>).map((t) => t.id)).toContain(teamId);
    expect(await list(admin)).toEqual([]);
    expect((await list(m2)).map((r) => r.sessionId)).toEqual([sid('m2')]);
    for (const path of perSession('m2')) expect(await status(admin, path), path).toBe(403);
    for (const path of teamWide) expect(await status(admin, path), path).toBe(403);
    const members = (await (await admin.api.get(`/api/v1/teams/${teamId}/members`)).json()) as Array<{ disclosureAcknowledgedAt: string | null }>;
    expect(members.length).toBeGreaterThan(1);
    expect(members.every((m) => m.disclosureAcknowledgedAt === null)).toBe(true);
  });
});
