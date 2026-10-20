// S-REPO-03. The repository summary is right, and nobody gets into someone else's repository
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-03; no mode in the design → A and C,
// DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3).
//
// Set-up as the code allows it:
//   - the session of a second author (`userCount` 2) comes from importing a hand-made export
//     archive whose author does not exist on the stand: in mode C import creates a placeholder
//     user for it, the way the design describes («импортирована как placeholder-пользователь»);
//     in mode A (`AUTH_MODE=none`, single-user) import has no placeholder authors and reassigns
//     the ghost session to the importer, so A has one author (`userCount` 1);
//   - repository E «without logs» is created by a bootstrap import of an archive with no sessions —
//     the only public path that creates a `repositories` row without an upload.
//
// Replaces:
//   - server/test/repositories.e2e-spec.ts (10)
//   - server/test/repo-details.e2e-spec.ts (access part, ≈6: repo contexts, 403/404)
//   - server/test/repo-settings.e2e-spec.ts («another user cannot access», 1)
//   - server/test/session-stats-export.e2e-spec.ts (403 on a foreign repo, 2)
//   - server/test/sessions.e2e-spec.ts (401/403/404 of /sessions, /sessions/ids, /sessions/branches ≈9;
//     teamId validation 2)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { importZip, bootstrapImport } from '../helpers/export-import';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept } from '../helpers/teams';
import { buildExportZip } from '../helpers/zip';

interface Summary {
  sessionCount: number;
  userCount: number;
}

test('@S-REPO-03 the repository summary is right and a foreign repository is closed @mode-a @mode-c', async ({
  api,
  db,
  stand,
  users,
}) => {
  test.setTimeout(120_000);
  /** Mode A (AUTH_MODE=none): the imported ghost session is reassigned to OWNER, no second author. */
  const singleUser = stand.authMode === 'none';
  /** Authors of A's own repository row: OWNER, plus the placeholder ghost outside mode A. */
  const authorsA = singleUser ? 1 : 2;
  const run = randomBytes(4).toString('hex');
  const urlA = `https://git.arrakis.test/scn/${run}/summary-a`;
  const urlE = `https://git.arrakis.test/scn/${run}/empty-e`;
  const urlF = `https://git.arrakis.test/scn/${run}/not-shared-f`;
  const owner = await users.user('user', { label: 'r03-owner' });
  const regular = await users.user('user', { label: 'r03-member' });
  const nonowner = await users.user('user', { label: 'r03-stranger' });
  const ghostEmail = `ghost-${run}@arrakis.test`;

  const { repoA, repoE, repoF, teamId } = await test.step('setup: A (2 own + 1 imported ghost session), E (no logs), F (not in the team), Team-X', async () => {
    const key = await createApiKey(owner.api);
    const queue = { db, userId: owner.id };
    for (const n of [1, 2]) {
      await uploadPromptSession(api, key.key, { sessionId: `r03-${run}-own${n}`, prompt: `own ${n} ${run}`, repoUrl: urlA }, queue);
    }
    await uploadPromptSession(api, key.key, { sessionId: `r03-${run}-f`, prompt: `f ${run}`, repoUrl: urlF }, queue);
    const repoA = await ownRepoId(owner.api, urlA);
    const ghostArchive = buildExportZip({
      sourceRepoUrl: urlA,
      sessions: [{ sessionId: `r03-${run}-ghost`, prompt: `ghost ${run}`, repoUrl: urlA, userEmail: ghostEmail }],
    });
    await importZip(owner.api, repoA, ghostArchive);
    const { repoId: repoE } = await bootstrapImport(owner.api, buildExportZip({ sourceRepoUrl: urlE, sessions: [] }));
    const teamId = await createTeam(owner, `Summary-${run}`);
    await inviteAndAccept(owner, regular, teamId);
    await addTeamRepo(owner, teamId, urlA);
    return { repoA, repoE, repoF: await ownRepoId(owner.api, urlF), teamId };
  });

  const summaryPath = (repoId: number, query = '') => `/api/v1/repositories/${repoId}/summary${query}`;
  const summaryOf = async (user: ScenarioUser, repoId: number, query = '') => {
    const res = await user.api.get(summaryPath(repoId, query));
    expect(res.status(), `${user.email} summary ${repoId}${query}`).toBe(200);
    return (await res.json()) as Summary;
  };
  const baseA = `/api/v1/repositories/${repoA}`;
  const foreignReads = [
    `${baseA}/summary`,
    `${baseA}/sessions`,
    `${baseA}/sessions/ids`,
    `${baseA}/sessions/branches`,
    `${baseA}/contexts`,
    `${baseA}/settings`,
    `${baseA}/hook-state`,
  ];

  await test.step('1. OWNER: A → sessionCount 3, userCount 2 (the imported author counts; mode A: 1, the session is reassigned to OWNER)', async () => {
    expect(await summaryOf(owner, repoA)).toEqual({ sessionCount: 3, userCount: authorsA });
  });

  await test.step('2. OWNER: E, a repository with no logs → 0 and 0', async () => {
    expect(await summaryOf(owner, repoE)).toEqual({ sessionCount: 0, userCount: 0 });
  });

  await test.step('3. NONOWNER: summary, sessions, contexts, settings, hook-state of A → 403 without repository data', async () => {
    for (const path of foreignReads) {
      const res = await nonowner.api.get(path);
      expect(res.status(), path).toBe(403);
      const text = await res.text();
      expect(text, path).not.toContain(urlA);
      expect(text, path).not.toContain(`own 1 ${run}`);
    }
  });

  await test.step('4. NONOWNER: an id that does not exist → 404', async () => {
    expect((await nonowner.api.get(summaryPath(999_999_999))).status()).toBe(404);
  });

  await test.step('5. OWNER: teamId=0 and teamId=-1 → 400', async () => {
    for (const bad of ['0', '-1']) {
      expect((await owner.api.get(summaryPath(repoA, `?teamId=${bad}`))).status(), bad).toBe(400);
      expect((await owner.api.get(`${baseA}/sessions?teamId=${bad}`)).status(), bad).toBe(400);
    }
  });

  await test.step('6. REGULAR (member): ?teamId=<Team-X> → the whole team’s numbers, through any member’s row; without teamId → 403', async () => {
    expect(await summaryOf(regular, repoA, `?teamId=${teamId}`)).toEqual({ sessionCount: 3, userCount: authorsA });
    expect((await regular.api.get(summaryPath(repoA))).status()).toBe(403);

    // The member uploads two sessions of A into their own repository row: the team view now
    // counts both members' rows (owner 2 + ghost 1 + member 2 sessions; authors owner, ghost and
    // member — in mode A the ghost session belongs to OWNER, so owner and member only),
    // whichever row is opened. Whole-repository counts, not access-mode scoped (Team-X is restricted).
    const key = await createApiKey(regular.api);
    for (const n of [1, 2]) {
      await uploadPromptSession(api, key.key, { sessionId: `r03-${run}-member${n}`, prompt: `member ${n} ${run}`, repoUrl: urlA }, { db, userId: regular.id });
    }
    const regularA = await ownRepoId(regular.api, urlA);
    const team = { sessionCount: 5, userCount: authorsA + 1 };
    expect(await summaryOf(regular, repoA, `?teamId=${teamId}`)).toEqual(team);
    expect(await summaryOf(regular, regularA, `?teamId=${teamId}`)).toEqual(team);
    expect(await summaryOf(owner, repoA, `?teamId=${teamId}`)).toEqual(team);
    // Personal view still counts one repository row alone.
    expect(await summaryOf(owner, repoA)).toEqual({ sessionCount: 3, userCount: authorsA });
    expect(await summaryOf(regular, regularA)).toEqual({ sessionCount: 2, userCount: 1 });
  });

  await test.step('7. NONOWNER (not a member): ?teamId=<Team-X> → 403', async () => {
    expect((await nonowner.api.get(summaryPath(repoA, `?teamId=${teamId}`))).status()).toBe(403);
  });

  await test.step('8. OWNER: ?teamId=<Team-X> on F, which is not in the team → 403', async () => {
    expect((await owner.api.get(summaryPath(repoF, `?teamId=${teamId}`))).status()).toBe(403);
  });

  await test.step('9. No cookie: every request above → 401', async () => {
    for (const path of [...foreignReads, summaryPath(repoA, `?teamId=${teamId}`), '/api/v1/repositories']) {
      expect((await api.get(path)).status(), path).toBe(401);
    }
  });

  await test.step('10. GET /repositories: NONOWNER does not see A; OWNER sees E with its 0 logs', async () => {
    const list = async (user: ScenarioUser) =>
      ((await (await user.api.get('/api/v1/repositories')).json()) as Array<{ id: number }>).map((r) => r.id);
    expect(await list(nonowner)).not.toContain(repoA);
    expect(await list(owner)).toEqual(expect.arrayContaining([repoA, repoE, repoF]));
  });
});
