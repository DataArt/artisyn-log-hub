// S-REPO-12. Export and import are refused to anyone who is not the owner
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-12; no mode in the design → A and C,
// DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3).
//
// Code facts that differ from the design text:
//   - step 3: every job route runs `assertRepoOwnerOrTeamOwner` before it looks the job up, so a
//     stranger asking for the owner's job under the owner's repository gets 403; asked under the
//     stranger's own repository the same job id is 404 (`job.repoId` mismatch) — both checked;
//   - step 6: `sessions/export-scope` requires `from` and `to`; without `teamId` it is the
//     personal route, closed to anyone but the repository owner;
//   - «no job file was created»: a refused upload creates no `export_import_jobs` row, which is
//     what the step checks. The multipart body itself is written to the staging directory by the
//     upload interceptor before the handler refuses (Notes, Chunk 15).
//
// Replaces:
//   - tests/e2e/repo-export-import.spec.ts (the «non-owner member» UI test, now on the API)
//   - server/test/session-stats-export.e2e-spec.ts (403 branches, 4)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { createApiKey } from '../helpers/api-key';
import { exportRepo, stageImport, startExport } from '../helpers/export-import';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept } from '../helpers/teams';
import { buildExportZip } from '../helpers/zip';

const DAY_MS = 24 * 60 * 60 * 1000;

test('@S-REPO-12 export and import are refused to anyone but the owner @mode-a @mode-c', async ({ api, db, users }) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/guarded`;
  const strangerUrl = `https://git.arrakis.test/scn/${run}/stranger-own`;
  const owner = await users.user('user', { label: 'r12-owner' });
  const regular = await users.user('user', { label: 'r12-member' });
  const nonowner = await users.user('user', { label: 'r12-stranger' });

  const { repoA, repoN, teamId, ownerJobId } = await test.step('setup: OWNER’s repo A with two sessions in Team-X (REGULAR a member); NONOWNER’s own repo N; one finished export of A', async () => {
    const ownerKey = await createApiKey(owner.api);
    for (const n of [1, 2]) {
      await uploadPromptSession(api, ownerKey.key, { sessionId: `r12-${run}-${n}`, prompt: `guarded ${n} ${run}`, repoUrl }, { db, userId: owner.id });
    }
    const strangerKey = await createApiKey(nonowner.api);
    await uploadPromptSession(api, strangerKey.key, { sessionId: `r12-${run}-n`, prompt: `stranger ${run}`, repoUrl: strangerUrl }, { db, userId: nonowner.id });
    const teamId = await createTeam(owner, `Guarded-${run}`);
    await inviteAndAccept(owner, regular, teamId);
    await addTeamRepo(owner, teamId, repoUrl);
    const repoA = await ownRepoId(owner.api, repoUrl);
    const { jobId } = await exportRepo(owner.api, repoA);
    return { repoA, repoN: await ownRepoId(nonowner.api, strangerUrl), teamId, ownerJobId: jobId };
  });

  const baseA = `/api/v1/repositories/${repoA}`;
  const archive = buildExportZip({
    sourceRepoUrl: repoUrl,
    sessions: [{ sessionId: `r12-${run}-intruder`, prompt: `intruder ${run}`, repoUrl, userEmail: nonowner.email }],
  });
  const attempts = (ctx: APIRequestContext, teamId?: number): Array<[string, () => Promise<APIResponse>]> => {
    const q = teamId !== undefined ? `&teamId=${teamId}` : '';
    return [
      ['POST export', () => startExport(ctx, repoA, { scope: 'all', ...(teamId !== undefined ? { teamId } : {}) })],
      ['GET export-import/scope', () => ctx.get(`${baseA}/export-import/scope?scope=all${q}`)],
      ['POST import/upload', () => stageImport(ctx, repoA, archive, teamId)],
    ];
  };
  const jobRowsOf = async (user: ScenarioUser) =>
    Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM export_import_jobs WHERE user_id = $1', [user.id])).rows[0].n);
  const sessionCountOfA = async () =>
    ((await (await owner.api.get(`${baseA}/summary`)).json()) as { sessionCount: number }).sessionCount;

  await test.step('1. NONOWNER: export, scope preview and import upload → 403 each', async () => {
    for (const [what, call] of attempts(nonowner.api)) expect((await call()).status(), what).toBe(403);
  });

  await test.step('2. REGULAR (member, not the team owner): the same calls with teamId → 403', async () => {
    for (const [what, call] of attempts(regular.api, teamId)) expect((await call()).status(), what).toBe(403);
    // Without teamId the member has no personal access to A at all.
    for (const [what, call] of attempts(regular.api)) expect((await call()).status(), what).toBe(403);
  });

  await test.step('3. NONOWNER: OWNER’s job status and download → 403 under A, 404 under N; the zip does not leak', async () => {
    for (const path of [`export/${ownerJobId}/status`, `export/${ownerJobId}/download`]) {
      const underA = await nonowner.api.get(`${baseA}/${path}`);
      expect(underA.status(), path).toBe(403);
      expect((await underA.body()).subarray(0, 2).toString()).not.toBe('PK');
      const underN = await nonowner.api.get(`/api/v1/repositories/${repoN}/${path}`);
      expect(underN.status(), path).toBe(404);
      expect((await underN.body()).subarray(0, 2).toString()).not.toBe('PK');
    }
  });

  await test.step('4. No cookie: every route → 401', async () => {
    for (const [what, call] of attempts(api)) expect((await call()).status(), what).toBe(401);
    for (const path of [`${baseA}/export/${ownerJobId}/status`, `${baseA}/export/${ownerJobId}/download`]) {
      expect((await api.get(path)).status(), path).toBe(401);
    }
  });

  await test.step('5. OWNER with the id of NONOWNER’s repository → 403', async () => {
    expect((await startExport(owner.api, repoN)).status()).toBe(403);
    expect((await owner.api.get(`/api/v1/repositories/${repoN}/export-import/scope?scope=all`)).status()).toBe(403);
    expect((await stageImport(owner.api, repoN, archive)).status()).toBe(403);
  });

  await test.step('6. Statistics export scope: REGULAR and NONOWNER → 403, the team owner → 200', async () => {
    const from = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const to = new Date(Date.now() + DAY_MS).toISOString();
    const teamScope = `${baseA}/sessions/export-scope?teamId=${teamId}&from=${from}&to=${to}`;
    const personal = `${baseA}/sessions/export-scope?from=${from}&to=${to}`;
    expect((await regular.api.get(teamScope)).status()).toBe(403);
    expect((await regular.api.get(personal)).status()).toBe(403);
    expect((await nonowner.api.get(teamScope)).status()).toBe(403);
    expect((await nonowner.api.get(personal)).status()).toBe(403);
    const ok = await owner.api.get(teamScope);
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as unknown[]).length).toBe(2);
  });

  await test.step('after all attempts: A still has two sessions; REGULAR and NONOWNER own no export/import job', async () => {
    expect(await sessionCountOfA()).toBe(2);
    expect(await jobRowsOf(regular)).toBe(0);
    expect(await jobRowsOf(nonowner)).toBe(0);
    expect(await jobRowsOf(owner)).toBe(1);
  });
});
