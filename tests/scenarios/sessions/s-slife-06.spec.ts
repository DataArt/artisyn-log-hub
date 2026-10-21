// S-SLIFE-06. The owner removes a session from the UI, someone else cannot, a re-upload is ignored
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-SLIFE-06, formerly S-SESS-06; no mode in
// the design → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3); the re-upload in step 3 is a v2 upload
// too, so «2xx, nothing comes back» is 201 plus an idle queue with no new `logs` rows.
//
// Set-up as the code allows it:
//   - `nonowner` must be able to open the session to look for the Remove button, so `regular`
//     shares repo A through a `transparent` team (every member sees every session there);
//   - there is no `GET /sessions/:id`: «the session answers 404» is the session's logs route,
//     `GET /repositories/:A/sessions/:id/logs`, which is also what the Raw Logs tab reads.
//
// Code facts that differ from the design text:
//   - the repository header (`Sessions: N`) is not refetched by the delete mutation (it only
//     invalidates the session lists), so the header count is checked after a reload; the API
//     summary drops at once.
//
// Replaces:
//   - server/test/session-delete.e2e-spec.ts (owner 204, admin 204, 403, 404 unknown, 404 repeated,
//     re-upload ignored, 401, «no longer appears in list»: 8 of 12; the tree cases are S-SLIFE-07)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, postSessionLog, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';

const REMOVE_MESSAGE =
  'This will permanently delete all logs and data for this session. This action cannot be undone.';

test('@S-SLIFE-06 the owner removes a session from the UI, another user cannot, a re-upload is ignored @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/slife06`;
  const admin = await users.user('admin', { label: 'sl06-admin' });
  const regular = await users.user('user', { label: 'sl06-regular' });
  const nonowner = await users.user('user', { label: 'sl06-nonowner' });
  const keep: PromptSession = { sessionId: `sl06-${run}-keep`, prompt: `Keep me ${run}`, repoUrl };
  const drop: PromptSession = { sessionId: `sl06-${run}-drop`, prompt: `Delete me ${run}`, repoUrl };

  const { key, repoId, teamId } = await test.step('setup: REGULAR uploads «Keep me» and «Delete me» into A; A is shared with NONOWNER through a transparent team', async () => {
    const key = await createApiKey(regular.api);
    for (const s of [keep, drop]) await uploadPromptSession(api, key.key, s, { db, userId: regular.id });
    const teamId = await createTeam(regular, `Open-${run}`);
    expect((await regular.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await inviteAndAccept(regular, nonowner, teamId, 'transparent');
    await addTeamRepo(regular, teamId, repoUrl);
    return { key, repoId: await ownRepoId(regular.api, repoUrl), teamId };
  });

  const base = `/api/v1/repositories/${repoId}`;
  const logsPath = (s: PromptSession) => `${base}/sessions/${encodeURIComponent(s.sessionId)}/logs`;
  const listed = async () =>
    ((await (await regular.api.get(`${base}/sessions`)).json()) as Array<{ sessionId: string }>).map((r) => r.sessionId);
  const sessionCount = async () => ((await (await regular.api.get(`${base}/summary`)).json()) as { sessionCount: number }).sessionCount;
  const logRows = async (s: PromptSession) =>
    Number(
      (
        await db.query<{ n: string }>(
          'SELECT count(*) AS n FROM logs l JOIN sessions s ON s.id = l.session_id WHERE s.session_id = $1',
          [s.sessionId],
        )
      ).rows[0].n,
    );
  const sessionItem = (prompt: string) => page.getByTestId('session-item').filter({ hasText: prompt });
  const dialog = page.getByRole('dialog');

  expect(await sessionCount()).toBe(2);
  await skipNewUserNudge(page.context());
  await regular.signIn(page);

  await test.step('1. UI (REGULAR): «Remove» on «Delete me» opens «Remove Session?» with the warning; «Cancel» deletes nothing', async () => {
    await page.goto(`/#/repos/${repoId}`);
    await sessionItem(drop.prompt).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog.getByText('Remove Session?')).toBeVisible();
    await expect(dialog.getByText(REMOVE_MESSAGE)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await listed()).toContain(drop.sessionId);
  });

  await test.step('2. UI+API: «Remove» → «Delete»: gone from the list, selection cleared, summary −1, logs 404; the header shows 1 after a reload', async () => {
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    const response = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/v1/sessions/'));
    await dialog.getByRole('button', { name: 'Delete' }).click();
    expect((await response).status()).toBe(204);
    await expect(page.getByText('Session removed.')).toBeVisible();
    await expect(sessionItem(drop.prompt)).toHaveCount(0);
    await expect(sessionItem(keep.prompt)).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]session=/);
    expect(await listed()).toEqual([keep.sessionId]);
    expect(await sessionCount()).toBe(1);
    expect((await regular.api.get(logsPath(drop))).status()).toBe(404);
    expect(await logRows(drop)).toBe(0);
    await page.reload();
    await expect(page.getByText('Sessions: 1', { exact: false })).toBeVisible();
  });

  await test.step('3. API: the same API key re-uploads «Delete me» → 201, but nothing comes back (no list entry, no logs rows)', async () => {
    for (const type of ['artisyn', 'claude'] as const) {
      expect((await postSessionLog(api, drop, type, { 'X-API-Key': key.key })).status(), type).toBe(201);
    }
    await waitForQueueIdle(db, regular.id);
    expect(await listed()).toEqual([keep.sessionId]);
    expect(await logRows(drop)).toBe(0);
    expect((await regular.api.get(logsPath(drop))).status()).toBe(404);
  });

  await test.step('4. API: DELETE again → 404; an unknown id → 404; no cookie → 401', async () => {
    expect((await regular.api.delete(`/api/v1/sessions/${drop.sessionId}`)).status()).toBe(404);
    expect((await regular.api.delete(`/api/v1/sessions/sl06-${run}-never-uploaded`)).status()).toBe(404);
    expect((await api.delete(`/api/v1/sessions/${keep.sessionId}`)).status()).toBe(401);
  });

  await test.step('5. NONOWNER (sees A through the team): DELETE «Keep me» → 403 and no «Remove» button in the UI', async () => {
    expect((await nonowner.api.delete(`/api/v1/sessions/${keep.sessionId}`)).status()).toBe(403);
    expect(await listed()).toEqual([keep.sessionId]);
    const { context, page: other } = await browserAs(browser, stand.url, nonowner, `/#/teams/${teamId}/repos/${repoId}`);
    try {
      await other.getByTestId('session-item').filter({ hasText: keep.prompt }).click();
      await expect(other.getByTestId('tab-session-summary')).toBeVisible();
      await expect(other.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('6. ADMIN: DELETE «Keep me» → 403 (deleting is owner-only); REGULAR still has it', async () => {
    expect((await admin.api.delete(`/api/v1/sessions/${keep.sessionId}`)).status()).toBe(403);
    expect(await listed()).toEqual([keep.sessionId]);
  });
});
