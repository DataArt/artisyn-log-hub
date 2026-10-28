// S-REPO-09. The owner exports a repository to a zip and imports the archive into another
// repository through the UI (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-09; no mode
// in the design → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3).
//
// Code facts that differ from the design text:
//   - the preview line reads «3 sessions · ~<size>» before an export and after choosing a zip;
//     the job line reads «Export ready — download started.» and «3 sessions imported.»;
//   - KNOWN DEVIATION: the export holds only root sessions (their `claude` and `artisyn` logs);
//     a sub-agent's `claude-subagent` log is not in the zip (`resolveMatchingSessions` /
//     `appendSessionChunk`). On one server B still shows the tree and the same cost because a
//     session is one global row linked to both repositories; moved to another server, the
//     sub-agent's cost would be lost (Notes, Chunk 15). The step pins both facts;
//   - a re-import says «3 sessions imported.» again (the job has no skipped counter); «no
//     duplicates» is the unchanged session count of B;
//   - step 8: a plain member of a `restricted` team sees only the Sessions tab, so Team-X is
//     `transparent` for the member to reach Settings → Import/Export at all.
//
// OKF usage tab (2026-10-27-okf-usage-tab, DD-21, DD-42): the «refactor» session is an OKF
// session tree (helpers/okf.ts) bound to a KB snapshot whose bundle root carries the run id, so
// no other session of the stand shares the snapshot. The export carries `okfSnapshotId` in
// session.json and the `okf-snapshot` line in artisyn.jsonl (step 2); after the import the
// session keeps its binding and its OKF rows (step 5a); deleting it removes its
// `session_okf_access` rows and sweeps the now-orphan `okf_snapshots` row (step 9).
//
// Replaces:
//   - tests/e2e/repo-export-import.spec.ts (4: round trip and three «visibility» tests)
//   - client/src/viewer/__tests__/components/ImportExportSection.test.tsx (3)
//   - server/test/repository-export-import.spec.ts («preserves userId/gitBranch/firstPrompt across a
//     full round trip», 1)
import { randomBytes } from 'crypto';
import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ndjson, postLogs } from '../helpers/ingest';
import { okfSnapshotBody, uploadOkfSessionTree } from '../helpers/okf';
import { ownRepoId, promptSessionBodies, uploadPromptSession, uploadSubagent } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';
import { readZip } from '../helpers/zip';

interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  gitBranch?: string;
  totalCost: number | null;
}

test('@S-REPO-09 owner exports a repository to zip and imports it into another one through the UI @mode-a @mode-c', async ({
  stand,
  api,
  db,
  users,
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const run = randomBytes(4).toString('hex');
  const urlA = `https://git.arrakis.test/scn/${run}/export-a`;
  const urlB = `https://git.arrakis.test/scn/${run}/import-b`;
  const owner = await users.user('user', { label: 'r09-owner' });
  const regular = await users.user('user', { label: 'r09-member' });
  const sid = (n: string) => `r09-${run}-${n}`;
  const prompts = { fix: `Fix login ${run}`, add: `Add export ${run}`, refactor: `Refactor db ${run}`, other: `Other ${run}` };
  const agentId = sid('fix-agent');
  const snapshotId = randomBytes(32).toString('hex');
  const okfKb = `docs/kb-${run}`;
  const okfSnapshot = { bundles: [{ root: okfKb, files: [`${okfKb}/db.md`, `${okfKb}/api.md`] }] };
  const okfSnapshotId = okfSnapshotBody(okfSnapshot).okfSnapshotId;
  /** `session_okf_access` rows of a session (its root node). */
  const okfRows = async (sessionId: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          'SELECT count(*) AS n FROM session_okf_access a JOIN sessions s ON s.id = a.session_id WHERE s.session_id = $1',
          [sessionId],
        )
      ).rows[0].n,
    );
  const boundOkfSnapshot = async (sessionId: string) =>
    (await db.query<{ okf_snapshot_id: string | null }>('SELECT okf_snapshot_id FROM sessions WHERE session_id = $1', [sessionId]))
      .rows[0]?.okf_snapshot_id ?? null;
  const okfSnapshotRows = async () =>
    Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM okf_snapshots WHERE snapshot_id = $1', [okfSnapshotId])).rows[0].n,
    );

  const { repoA, repoB, teamId } = await test.step('setup: A with 3 sessions (main, feat/x, one with a sub-agent), B with 1, transparent Team-X with A', async () => {
    const key = await createApiKey(owner.api);
    const queue = { db, userId: owner.id };
    await uploadPromptSession(api, key.key, { sessionId: sid('fix'), prompt: prompts.fix, repoUrl: urlA, branch: 'main' }, queue);
    await uploadSubagent(api, key.key, { sessionId: agentId, parentSessionId: sid('fix'), prompt: `agent of ${run}` }, queue);
    // DD-14: give one exported session (the one with the sub-agent) a harness snapshot, so step
    // 2 can pin that the export carries a `harness-snapshot` line. The real hook always
    // prepends the snapshot lines to the current session's FULL artisyn body (DD-7), never
    // uploads them alone — doing the same here keeps the session's branch/prompt extraction
    // (re-derived from every upload's own lines) unaffected.
    const snapshotLines = ndjson([
      { type: 'harness-snapshot-ref', snapshotId },
      {
        type: 'harness-snapshot',
        snapshotId,
        schemaVersion: 1,
        perToolDetailSupported: true,
        skills: [],
        agents: [],
        mcpServers: [],
        systemContext: null,
      },
    ]);
    const fixArtisyn = promptSessionBodies({ sessionId: sid('fix'), prompt: prompts.fix, repoUrl: urlA, branch: 'main' }).artisyn;
    const res = await postLogs(
      api,
      key.key,
      { sessionId: sid('fix'), type: 'artisyn', snapshotId, snapshotFull: '1' },
      snapshotLines + fixArtisyn,
    );
    expect(res.status()).toBe(201);
    await waitForQueueIdle(db, owner.id);
    await uploadPromptSession(api, key.key, { sessionId: sid('add'), prompt: prompts.add, repoUrl: urlA, branch: 'feat/x' }, queue);
    // The «refactor» session reads a KB bound to an OKF snapshot (exported with it, step 2).
    const okfTree = await uploadOkfSessionTree(
      api,
      key.key,
      {
        sessionId: sid('refactor'),
        prompt: prompts.refactor,
        repoUrl: urlA,
        branch: 'main',
        snapshot: okfSnapshot,
        actions: [{ read: `${okfKb}/index.md` }, { read: `${okfKb}/db.md`, bytes: 2000 }],
      },
      queue,
    );
    expect(okfTree.okfSnapshotId).toBe(okfSnapshotId);
    expect(await okfRows(sid('refactor')), 'index.md and db.md reads').toBe(2);
    await uploadPromptSession(api, key.key, { sessionId: sid('other'), prompt: prompts.other, repoUrl: urlB }, queue);
    const teamId = await createTeam(owner, `Export-${run}`);
    expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await inviteAndAccept(owner, regular, teamId, 'transparent');
    await addTeamRepo(owner, teamId, urlA);
    return { repoA: await ownRepoId(owner.api, urlA), repoB: await ownRepoId(owner.api, urlB), teamId };
  });

  const sessionsOf = async (repoId: number) => {
    const res = await owner.api.get(`/api/v1/repositories/${repoId}/sessions`);
    expect(res.status()).toBe(200);
    return (await res.json()) as SessionRow[];
  };
  const importExport = (repoId: number, mode = '') =>
    `/#/repos/${repoId}?mtab=settings&stab=import-export${mode ? `&iemode=${mode}` : ''}`;
  const chooseZip = async (p: Page, zipPath: string) => {
    await p.locator('input[type="file"][accept=".zip"]').setInputFiles(zipPath);
  };
  const zipPath = testInfo.outputPath(`repo-a-${run}.zip`);

  await skipNewUserNudge(page.context());
  await owner.signIn(page);

  await test.step('1. OWNER → A → Settings → Import/Export: «All sessions», preview «3 sessions»', async () => {
    await page.goto(importExport(repoA));
    await expect(page.getByTestId('tab-settings-import-export')).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('tab', { name: 'Export session', exact: true })).toHaveAttribute('data-state', 'active');
    await expect(page.getByText('All sessions', { exact: true })).toBeVisible();
    await expect(page.getByText(/^3 sessions · ~/)).toBeVisible();
  });

  await test.step('2. «Start export» → «Export ready», the zip downloads: PK…, meta.json, the three root sessions', async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Start export' }).click();
    await expect(page.getByText('Export ready — download started.')).toBeVisible({ timeout: 30_000 });
    await (await download).saveAs(zipPath);
    const zip = fs.readFileSync(zipPath);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    const entries = readZip(zip);
    const meta = JSON.parse(entries.get('meta.json')!.toString('utf8')) as { sessionCount: number; sourceRepoUrl: string };
    expect(meta).toMatchObject({ sessionCount: 3, sourceRepoUrl: urlA });
    const folders = [...new Set([...entries.keys()].filter((n) => n.startsWith('sessions/')).map((n) => n.split('/')[1]))];
    expect(folders.sort()).toEqual([sid('add'), sid('fix'), sid('refactor')].sort());
    // KNOWN DEVIATION: the sub-agent's log does not travel in the archive.
    expect([...entries.keys()].some((n) => n.includes(agentId))).toBe(false);
    // DD-14: the exported artisyn.jsonl of the snapshot session carries a harness-snapshot line.
    const fixArtisyn = entries.get(`sessions/${sid('fix')}/artisyn.jsonl`)!.toString('utf8');
    expect(fixArtisyn.split('\n').some((l) => l.trim() !== '' && (JSON.parse(l) as { type?: string }).type === 'harness-snapshot')).toBe(true);
    // OKF (DD-21, DD-42): session.json names the bound snapshot, artisyn.jsonl carries its full
    // line once (the original upload's line is not duplicated); a session without one has null.
    const sessionJson = (name: string) =>
      JSON.parse(entries.get(`sessions/${name}/session.json`)!.toString('utf8')) as { okfSnapshotId?: string | null };
    expect(sessionJson(sid('refactor')).okfSnapshotId).toBe(okfSnapshotId);
    expect(sessionJson(sid('add')).okfSnapshotId).toBeNull();
    const okfLines = entries
      .get(`sessions/${sid('refactor')}/artisyn.jsonl`)!
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type?: string; okfSnapshotId?: string })
      .filter((l) => l.type === 'okf-snapshot');
    expect(okfLines.map((l) => l.okfSnapshotId)).toEqual([okfSnapshotId]);
  });

  await test.step('3. B → Import session → choose the zip: preview «3 sessions», from A (personal)', async () => {
    await page.goto(importExport(repoB, 'import'));
    await chooseZip(page, zipPath);
    await expect(page.getByText(/^3 sessions · ~/)).toBeVisible();
    await expect(page.getByText(`From ${urlA} (personal)`, { exact: false })).toBeVisible();
  });

  await test.step('4. «Import» → «3 sessions imported.»', async () => {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('3 sessions imported.')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('5. B now lists 4 sessions with their branches and first prompts', async () => {
    const rows = await sessionsOf(repoB);
    expect(rows.map((r) => r.firstPrompt).sort()).toEqual(Object.values(prompts).sort());
    const branchOf = new Map(rows.map((r) => [r.sessionId, r.gitBranch]));
    expect(branchOf.get(sid('fix'))).toBe('main');
    expect(branchOf.get(sid('add'))).toBe('feat/x');
    // A reload: the import invalidates the session list but not the header's summary query
    // (`repo-summary`), so without one the header keeps the pre-import count (Notes, Chunk 15).
    await page.goto(`/#/repos/${repoB}`);
    await page.reload();
    await expect(page.locator('span', { hasText: /^Sessions:/ })).toHaveText('Sessions: 4');
    await page.getByRole('combobox').selectOption({ label: 'Plain list' });
    for (const prompt of Object.values(prompts)) await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  });

  await test.step('5a. OKF: the imported «refactor» session keeps its snapshot binding and its OKF rows; B’s OKF tab reads its KB', async () => {
    expect(await boundOkfSnapshot(sid('refactor'))).toBe(okfSnapshotId);
    expect(await okfRows(sid('refactor'))).toBe(2);
    const res = await owner.api.get(`/api/v1/repositories/${repoB}/sessions/${sid('refactor')}/okf-usage`);
    expect(res.status()).toBe(200);
    const usage = (await res.json()) as { hasSnapshot: boolean; bundles: Array<{ root: string; filesRead: number }> };
    expect(usage.hasSnapshot).toBe(true);
    // db.md only: the bundle's index.md is the entry point and never counts as an article read.
    expect(usage.bundles).toEqual([expect.objectContaining({ root: okfKb, filesRead: 1 })]);
  });

  await test.step('6. The session with a sub-agent costs the same in B as in A (the tree is the same row)', async () => {
    const costIn = async (repoId: number) => (await sessionsOf(repoId)).find((r) => r.sessionId === sid('fix'))!.totalCost;
    const inA = await costIn(repoA);
    expect(inA).not.toBeNull();
    expect(await costIn(repoB)).toBe(inA);
  });

  await test.step('7. Importing the same zip into B again: «3 sessions imported.», still 4 sessions, no duplicates', async () => {
    await page.goto(importExport(repoB, 'import'));
    await chooseZip(page, zipPath);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('3 sessions imported.')).toBeVisible({ timeout: 30_000 });
    const rows = await sessionsOf(repoB);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(4);
    const summary = (await (await owner.api.get(`/api/v1/repositories/${repoB}/summary`)).json()) as { sessionCount: number };
    expect(summary.sessionCount).toBe(4);
  });

  await test.step('8. REGULAR (member, not the owner) in the team route: «Only the repository owner can start an export.», no button', async () => {
    const { context, page: memberPage } = await browserAs(
      browser,
      stand.url,
      regular,
      `/#/teams/${teamId}/repos/${repoA}?mtab=settings&stab=import-export`,
    );
    try {
      await expect(memberPage.getByText('Only the repository owner can start an export.')).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Start export' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('9. OKF: deleting the «refactor» session removes its session_okf_access rows and sweeps the orphan okf_snapshots row', async () => {
    expect(await okfSnapshotRows(), 'the owner’s stored snapshot').toBe(1);
    expect((await owner.api.delete(`/api/v1/sessions/${sid('refactor')}`)).status()).toBe(204);
    expect(await okfRows(sid('refactor'))).toBe(0);
    expect(await boundOkfSnapshot(sid('refactor'))).toBeNull();
    expect(await okfSnapshotRows(), 'no session references the snapshot any more').toBe(0);
  });
});
