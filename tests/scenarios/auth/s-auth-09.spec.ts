// S-AUTH-09. A person deletes their account: everything of theirs goes, other people's data stays
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-AUTH-09).
//
// Modes B and C instead of the design's A and B: in mode A (`none`) the top bar has no account
// menu — MainNav renders «Edit email» instead of UserMenu — so there is no «Delete account» to
// click, and a dead cookie on `/auth/me` is silently re-identified by AutoIdentifyGuard. B keeps
// the design's "session after deletion" check; C runs the same flow without mail.
// The deleted person's login attempt goes out through helpers/loopback-client.ts, so in mode B it
// does not feed the per-IP login backoff of 127.0.0.1.
//
// Code facts that differ from the design text:
//   - step 8: an admin route call by an admin can never hit the last-admin rule (the caller is an
//     admin too), so the admin route is checked on the caller's own id, which the route refuses
//     («Cannot delete your own account here», 400); the last-admin rule itself is step 7.
//
// Replaces:
//   - server/test/account-deletion.e2e-spec.ts (11)
//   - client/src/viewer/__tests__/components/delete-account-dialog.test.tsx (9)
//   - client/src/viewer/__tests__/components/MainNav.test.tsx («Delete account» item, 1)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { loopbackClient } from '../helpers/loopback-client';
import { ownRepoId, postSessionLog, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { openUserMenu } from '../helpers/ui-auth';

interface Invitation {
  id: number;
  teamId: number;
  inviterId: number;
  inviteeId: number;
  status: string;
}

test('@S-AUTH-09 deleting one’s own account removes everything of theirs and nothing else @mode-b @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(180_000);
  const runId = randomBytes(4).toString('hex');
  const admin = await users.user('admin', { label: 'del-admin' });
  const admin2 = await users.user('admin', { label: 'del-admin2' });
  const d = await users.user('user', { label: 'del-d' });
  const k = await users.user('user', { label: 'del-k' });
  const d2 = await users.user('user', { label: 'del-d2' });

  const r1 = `https://git.arrakis.test/scn/${runId}/r1`;
  const r2 = `https://git.arrakis.test/scn/${runId}/r2-shared`;
  const s = (owner: string, n: number, repoUrl: string): PromptSession => ({
    sessionId: `del-${runId}-${owner}-${n}`,
    prompt: `del ${owner} ${n} ${runId}`,
    repoUrl,
  });
  const dKey = await createApiKey(d.api);
  const kKey = await createApiKey(k.api);

  const fixture = await test.step('setup: D has R1 (2 sessions), R2 shared with K, team T with K, invitations, a key', async () => {
    await uploadPromptSession(api, dKey.key, s('d', 1, r1), { db, userId: d.id });
    await uploadPromptSession(api, dKey.key, s('d', 2, r1), { db, userId: d.id });
    await uploadPromptSession(api, dKey.key, s('d', 3, r2), { db, userId: d.id });
    await uploadPromptSession(api, kKey.key, s('k', 1, r2), { db, userId: k.id });
    const r1Id = await ownRepoId(d.api, r1);
    const kR2Id = await ownRepoId(k.api, r2);

    // Per-user rows the cascade must reach: a favourite and a personal repo config.
    expect((await d.api.post(`/api/v1/repositories/${r1Id}/sessions/${s('d', 1, r1).sessionId}/favorite`, { data: { favorite: true } })).ok()).toBe(true);
    expect((await d.api.put(`/api/v1/repositories/${r1Id}/settings/user`, { data: { config: { fileCategories: [] } } })).ok()).toBe(true);

    const team = async (owner: typeof d, name: string) => {
      const res = await owner.api.post('/api/v1/teams', { data: { name } });
      expect(res.status()).toBe(201);
      return ((await res.json()) as { id: number }).id;
    };
    const invite = async (owner: typeof d, teamId: number, email: string) => {
      const res = await owner.api.post(`/api/v1/teams/${teamId}/invitations`, { data: { email } });
      expect(res.status()).toBe(201);
      return (await res.json()) as Invitation;
    };
    const t = await team(d, `Del-T-${runId}`);
    const t2 = await team(k, `Del-T2-${runId}`);
    const kIntoT = await invite(d, t, k.email);
    expect((await k.api.patch(`/api/v1/invitations/${kIntoT.id}`, { data: { action: 'accept', acknowledgedAccessMode: 'restricted' } })).status()).toBe(200);
    expect((await d.api.post(`/api/v1/teams/${t}/repositories`, { data: { repoUrl: r2 } })).status()).toBe(201);
    const sentByD = await invite(d, t, d2.email);
    const dIntoT2 = await invite(k, t2, d.email);
    const d2IntoT2 = await invite(k, t2, d2.email);
    return { r1Id, kR2Id, t, t2, sentByD, dIntoT2, d2IntoT2 };
  });

  await test.step('9 (before). API (D2): delete-account with { confirm: "Delete" } → 400, the account stays', async () => {
    expect((await d2.api.post('/api/v1/auth/delete-account', { data: { confirm: 'Delete' } })).status()).toBe(400);
    expect((await d2.api.get('/api/v1/auth/me')).status()).toBe(200);
  });

  await test.step('1. UI (D): account menu → Delete account; «Delete», «delete » and «delet» keep the button disabled', async () => {
    await d.signIn(page);
    await page.goto('/#/teams');
    const menu = await openUserMenu(page, d.email);
    await menu.getByRole('menuitem', { name: 'Delete account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Delete your account?')).toBeVisible();
    const input = dialog.getByPlaceholder('Type "delete" to confirm');
    const confirm = dialog.getByRole('button', { name: 'Delete', exact: true });
    await expect(confirm).toBeDisabled();
    for (const typed of ['Delete', 'delete ', 'delet']) {
      await input.fill(typed);
      await expect(confirm, typed).toBeDisabled();
    }
  });

  await test.step('2–3. UI: exactly «delete» → Delete (204) → /#/login; login and the old cookie → 401', async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Type "delete" to confirm').fill('delete');
    const confirm = dialog.getByRole('button', { name: 'Delete', exact: true });
    await expect(confirm).toBeEnabled();
    const deleted = page.waitForResponse((r) => r.url().includes('/api/v1/auth/delete-account'));
    await confirm.click();
    expect((await deleted).status()).toBe(204);
    await expect(page).toHaveURL(/#\/login/);

    const login = await loopbackClient(stand.url).post('/api/v1/auth/login', { email: d.email, password: d.password });
    expect(login.status).toBe(401);
    expect((await d.api.get('/api/v1/auth/me')).status()).toBe(401);
  });

  await test.step('4. API: D’s API key → 401', async () => {
    expect((await postSessionLog(api, s('d', 9, r1), 'artisyn', { 'X-API-Key': dKey.key })).status()).toBe(401);
  });

  await test.step('5. API (ADMIN): D, R1 with its sessions, team T and D’s R2 row are gone', async () => {
    const usersList = (await (await admin.api.get('/api/v1/admin/users')).json()) as Array<{ id: number; email: string }>;
    expect(usersList.map((u) => u.email)).not.toContain(d.email);
    expect(usersList.map((u) => u.email)).toEqual(expect.arrayContaining([k.email, d2.email]));

    const repos = (await (await admin.api.get('/api/v1/admin/repos')).json()) as Array<{ repoUrl: string; ownerEmail: string | null }>;
    expect(repos.filter((r) => r.repoUrl === r1)).toEqual([]);
    expect(repos.filter((r) => r.repoUrl === r2).map((r) => r.ownerEmail)).toEqual([k.email]);

    const teams = (await (await admin.api.get('/api/v1/admin/teams')).json()) as Array<{ id: number }>;
    expect(teams.map((t) => t.id)).not.toContain(fixture.t);
    expect(teams.map((t) => t.id)).toContain(fixture.t2);
  });

  await test.step('6. API (K): own R2 session stays, team T is gone, D’s invitations are gone, K’s own one stays', async () => {
    const sessions = (await (await k.api.get(`/api/v1/repositories/${fixture.kR2Id}/sessions`)).json()) as Array<{ sessionId: string }>;
    expect(sessions.map((x) => x.sessionId)).toEqual([s('k', 1, r2).sessionId]);

    const teams = (await (await k.api.get('/api/v1/teams')).json()) as Array<{ id: number }>;
    expect(teams.map((t) => t.id)).toEqual([fixture.t2]);

    const kInvites = (await (await k.api.get('/api/v1/invitations')).json()) as Invitation[];
    expect(kInvites.map((i) => i.id)).toEqual([fixture.d2IntoT2.id]);
    const d2Invites = (await (await d2.api.get('/api/v1/invitations')).json()) as Invitation[];
    expect(d2Invites.map((i) => i.id)).toEqual([fixture.d2IntoT2.id]);
    expect(d2Invites.map((i) => i.id)).not.toContain(fixture.sentByD.id);
    expect(kInvites.map((i) => i.id)).not.toContain(fixture.dIntoT2.id);
  });

  await test.step('DB: no logs, logs_otel, repo_config, upload_queue, favourites of D; no orphan sessions; K’s session stays', async () => {
    for (const table of ['logs', 'logs_otel', 'repo_config', 'upload_queue', 'user_favorite_sessions', 'api_keys', 'repositories']) {
      const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [d.id]);
      expect(Number(rows[0].n), table).toBe(0);
    }
    const dSessions = [1, 2, 3].map((n) => s('d', n, n === 3 ? r2 : r1).sessionId);
    const { rows: orphans } = await db.query('SELECT session_id FROM sessions WHERE session_id = ANY($1)', [dSessions]);
    expect(orphans).toEqual([]);
    const { rows: kept } = await db.query('SELECT session_id FROM sessions WHERE session_id = $1', [s('k', 1, r2).sessionId]);
    expect(kept).toHaveLength(1);
  });

  await test.step('7. API (ADMIN as the only admin): delete-account → 400, the account stays', async () => {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND id <> $1", [admin.id]);
    const others = rows.map((r) => r.id);
    await db.query("UPDATE users SET role = 'user' WHERE id = ANY($1)", [others]);
    try {
      const res = await admin.api.post('/api/v1/auth/delete-account', { data: { confirm: 'delete' } });
      expect(res.status()).toBe(400);
      expect(await res.text()).toContain('Cannot delete the last admin');
      expect((await admin.api.get('/api/v1/auth/me')).status()).toBe(200);
    } finally {
      await db.query("UPDATE users SET role = 'admin' WHERE id = ANY($1)", [others]);
    }
  });

  await test.step('8. API (ADMIN2): the admin route on one’s own id → 400, the account stays', async () => {
    const res = await admin2.api.post(`/api/v1/admin/users/${admin2.id}/delete`, { data: { confirmEmail: admin2.email } });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('Cannot delete your own account here');
    expect((await admin2.api.get('/api/v1/auth/me')).status()).toBe(200);
  });
});
