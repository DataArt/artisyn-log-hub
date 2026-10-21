// S-SESS-12. Raw Logs are for the owner only; the API answers 403 to anyone else
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-12; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-01 uploaded by its owner U1 through POST /api/v2/logs (DD SC3). Team T is `restricted`
// (the default) and owned by TO, who adds the repository URL; U1 is a member (acknowledged by
// accepting), U2 is a member with the `manager` flag, U3 a plain member; plus an app admin who is
// not in T — the admin role grants no data access (2026-10-21-private-repo-visibility).
//
// Who is «the second user» (design: «участник общей команды, ограниченной по доступу»): in a
// restricted team a plain member does not see other members' sessions at all, so U2 is a manager —
// the one role that lists U1's session (prompt masked) but is refused its logs. That is the only
// place where the session pane opens without the Raw Logs tab.
//
// Code facts that differ from the design text:
//   - the leading rows without a timestamp (`mode`, `permission-mode`, `system-context`) stay at the
//     top; rows without a timestamp further down (`ai-title`, `last-prompt`) inherit their
//     neighbour's position, so «without timestamp first» holds for the leading block only.
//   - GS-01's usage is the legacy shape without `cache_creation`, so the expanded assistant row shows
//     Input/Output/Cache read/Cache write, without TTL buckets.
//   - there is no type filter or sort control on the tab; the rows are read in their order.
//
// Replaces:
//   - tests/e2e/raw-logs-owner-api.spec.ts (5)
//   - tests/e2e/session-raw-logs.spec.ts (13)
//   - client/src/viewer/__tests__/components/RawLogsTab.test.tsx (19)
//   - client/src/viewer/__tests__/unit/raw-logs.test.ts (38, part ≈ 18)
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { loadExpected } from '../helpers/golden';
import { openSession, uploadGoldenRepo } from '../helpers/session-view';
import { addTeamRepo, createTeam, inviteAndAccept, setMemberRoles } from '../helpers/teams';

const FIRST_PROMPT = 'Add a /health endpoint to the app and document it';

function rawLogRows(page: Page): Locator {
  return page.locator('table', { has: page.locator('th', { hasText: 'Type' }) }).locator('tbody > tr.cursor-pointer');
}

async function rowTypes(page: Page): Promise<string[]> {
  return (await rawLogRows(page).locator('td:nth-child(2)').allInnerTexts()).map((t) => t.trim());
}

test('@S-SESS-12 Raw Logs only for the owner; anyone else gets 403 @mode-a @mode-c', async ({ api, db, users, page, browser, stand }) => {
  test.setTimeout(180_000);
  const E = loadExpected('gs-01').roots[0];
  const u1 = await users.user('user', { label: 'ss12-owner' });
  const teamOwner = await users.user('user', { label: 'ss12-teamowner' });
  const u2 = await users.user('user', { label: 'ss12-manager' });
  const u3 = await users.user('user', { label: 'ss12-member' });
  const admin = await users.user('admin', { label: 'ss12-admin' });

  const { repo, teamId } = await test.step('setup: GS-01 by U1; restricted team T (owner TO) with U1, U2 (manager), U3; the repo in T', async () => {
    const repo = await uploadGoldenRepo(api, db, u1, ['gs-01']);
    const teamId = await createTeam(teamOwner, `ss12-${repo.runId}`);
    for (const m of [u1, u2, u3]) await inviteAndAccept(teamOwner, m, teamId, 'restricted');
    await setMemberRoles(teamOwner, teamId, u2.id, { isManager: true });
    await addTeamRepo(teamOwner, teamId, repo.repoUrl);
    return { repo, teamId };
  });
  const sid = repo.rootId('gs-01');
  const logsPath = (teamParam?: number) =>
    `/api/v1/repositories/${repo.repoId}/sessions/${encodeURIComponent(sid)}/logs${teamParam !== undefined ? `?teamId=${teamParam}` : ''}`;

  await test.step('1. U1 opens GS-01: the Raw Logs tab carries the lock hint «Only visible to you»', async () => {
    await openSession(page, u1, repo.repoId, sid);
    const tab = page.getByTestId('tab-session-raw-logs');
    await expect(tab).toBeVisible();
    await tab.hover();
    await expect(page.getByText('Only visible to you')).toBeVisible();
    await tab.click();
    await expect(page).toHaveURL(/tab=raw-logs/);
  });

  await test.step('2. the rows: every service type of the transcript, leading rows without timestamp first; assistant row expands', async () => {
    await expect(rawLogRows(page).first()).toBeVisible();
    const types = await rowTypes(page);
    for (const t of E.rawLogServiceLines as string[]) expect(types, t).toContain(t);
    const timestamps = (await rawLogRows(page).locator('td:nth-child(1)').allInnerTexts()).map((t) => t.trim());
    const firstTimed = timestamps.findIndex((t) => t !== '—');
    expect(firstTimed).toBeGreaterThan(0);
    expect(types.slice(0, firstTimed).sort()).toEqual(['mode', 'permission-mode', 'system-context']);

    const assistant = rawLogRows(page).filter({ has: page.locator('td:nth-child(2)', { hasText: /^\s*assistant\s*$/ }) }).first();
    await assistant.click();
    const details = assistant.locator('xpath=following-sibling::tr[1]');
    await expect(details).toContainText('Model');
    await expect(details).toContainText(E.model);
    await expect(details).toContainText('Stop reason');
    await expect(details).toContainText('Input tokens');
    await expect(details).toContainText('Cache read');

    for (const t of ['permission-mode', 'ai-title', 'system-context']) {
      const row = rawLogRows(page).filter({ has: page.locator('td:nth-child(2)', { hasText: new RegExp(`^\\s*${t}\\s*$`) }) }).first();
      await row.click();
      await expect(row.locator('xpath=following-sibling::tr[1]'), t).toBeVisible();
    }
  });

  await test.step('3. no `type: artisyn` row is shown, although the API returns the artisyn lines', async () => {
    expect(await rowTypes(page)).not.toContain('artisyn');
    const res = await u1.api.get(logsPath());
    expect(res.status()).toBe(200);
    const { main } = (await res.json()) as { main: Array<{ type?: string }> };
    expect(main.some((e) => e.type === 'artisyn')).toBe(true);
  });

  await test.step('4. U2 (manager in restricted T) opens the session with tab=raw-logs: no Raw Logs tab, back on Summary', async () => {
    const list = await u2.api.get(`/api/v1/repositories/${repo.repoId}/sessions?teamId=${teamId}`);
    expect(list.status()).toBe(200);
    const rows = (await list.json()) as Array<{ sessionId: string; firstPrompt: string | null }>;
    expect(rows.map((r) => r.sessionId)).toEqual([sid]);
    expect(rows[0].firstPrompt, 'a manager sees the session, not its prompt').toBeNull();

    const context = await browser.newContext({ baseURL: stand.url });
    try {
      const other = await context.newPage();
      await openSession(other, u2, repo.repoId, sid, { tab: 'raw-logs', teamId });
      await expect(other.getByTestId('tab-session-summary')).toBeVisible();
      await expect(other).not.toHaveURL(/tab=raw-logs/);
      await expect(other.getByTestId('tab-session-raw-logs')).toHaveCount(0);
      await expect(other.getByText(FIRST_PROMPT)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('5. U2 and U3: GET .../logs → 403 without the prompt text, with and without teamId', async () => {
    for (const [who, user] of [
      ['U2 manager', u2],
      ['U3 member', u3],
    ] as Array<[string, ScenarioUser]>) {
      for (const path of [logsPath(teamId), logsPath()]) {
        const res = await user.api.get(path);
        expect(res.status(), `${who} ${path}`).toBe(403);
        expect(await res.text(), `${who} ${path}`).not.toContain(FIRST_PROMPT);
      }
    }
  });

  await test.step('6. the app admin (not in T) opens the same session: «No access», no Raw Logs tab, no prompt; the API → 403 with and without teamId', async () => {
    const context = await browser.newContext({ baseURL: stand.url });
    try {
      const other = await context.newPage();
      await openSession(other, admin, repo.repoId, sid, { tab: 'raw-logs' });
      await expect(other.getByText('No access')).toBeVisible();
      await expect(other.getByTestId('tab-session-raw-logs')).toHaveCount(0);
      await expect(other.getByText(FIRST_PROMPT)).toHaveCount(0);
    } finally {
      await context.close();
    }
    for (const path of [logsPath(), logsPath(teamId)]) {
      const res = await admin.api.get(path);
      expect(res.status(), path).toBe(403);
      expect(await res.text(), path).not.toContain(FIRST_PROMPT);
    }
  });

  await test.step('7. with ?teamId=: the team owner gets the logs (200), a plain member does not (403)', async () => {
    const res = await teamOwner.api.get(logsPath(teamId));
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(FIRST_PROMPT);
    expect((await u3.api.get(logsPath(teamId))).status()).toBe(403);
  });
});
