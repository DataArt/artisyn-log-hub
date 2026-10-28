// S-SESS-09. Change surface of a Windows session: a scattered change, a file outside the repository,
// three warnings (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-09; no mode
// in the design → A and C, DD SC4).
//
// Data: GS-08 (repo root `C:\work\acme-shop`; eight Edit/Write calls, `web/Cart.tsx` logged twice —
// once as `C:\…\web\Cart.tsx`, once as `c:/…/web/Cart.tsx` — and one Write to
// `C:\Users\dev\.claude\plans\p.md`, outside the repository) plus GS-09 (400 files, all logged with
// backslashes under the same root) for the path normalisation at scale. Uploaded through
// POST /api/v2/logs (DD SC3); the numbers come from their expected.json (DD D3). The fixtures carry
// only Windows paths, so the result does not depend on the OS running the test.
//
// Lines of the file outside the repository (impl-plan DD 1: the code's current behaviour is
// fixed): the change surface counts only files of the repository — +61 / −6 — and reports the
// outside file separately (`outsideRepoFiles` 1, +12 / −0), listed in the tree under «Outside repo»
// and excluded from the folder / spread / module math. The session-level lines (Summary Code impact)
// keep all eight calls: 75 written, +73 / −6.
//
// Code facts that differ from the design text:
//   - Largest-folder share is printed as a whole percent: «17%» (design 16.7 %).
//   - the file kind of `db/migrations/001_init.sql` is `source` (the fixed taxonomy has no
//     migration kind); `docs/changelog.md` is `docs`.
//   - the tree shows a file's lines and change kind, not its call count; the two calls on Cart.tsx
//     are checked in the API (`editCalls` 2) and as one tree node.
//
// Steps 7–10 — the session OKF tab (2026-10-27 OKF usage tab, FR-4, FR-11..FR-13): a session
// tree built by helpers/okf.ts (DD-36) in a repository whose snapshot has one 12-file bundle
// `docs/kb`. The main agent edits a01.md and reads it back (own edit), reads index.md, greps the
// bundle folder (folder scan), reads a02.md three times and a03.md once; its sub-agent reads
// a04.md (8 KB). Main agent: 3 of the 11 files it did not write (27 % > 25 %) → «Something to fix»
// with one Why line; the sub-agent's 1 of 12 is fine.
//
// Replaces:
//   - server/test/change-surface.e2e-spec.ts (24, part ≈ 10)
//   - server/src/logs/change-surface/path-normalise.spec.ts (15)
//   - server/src/logs/change-surface/file-kind.spec.ts (15, part)
//   (server/src/logs/change-surface/change-surface-metrics.spec.ts was folded into the table test of
//   docs/knowledgebase/algorithms/change-surface-concentration.md)
//   - client/src/viewer/__tests__/unit/change-surface-detectors.test.ts (22, part)
//   - client/src/viewer/__tests__/unit/log-parser.test.ts (normaliseClientPath, auto path
//     normalization: ≈ 10)
//   - client/src/viewer/__tests__/components/change-surface-tab.test.tsx (18, part)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { loadExpected } from '../helpers/golden';
import { uploadOkfSessionTree } from '../helpers/okf';
import { ownRepoId } from '../helpers/prompt-session';
import { openSession, summaryTile, uploadGoldenRepo } from '../helpers/session-view';

interface ChangeSurface {
  computed: boolean;
  changedFiles: number;
  foldersTouched: number;
  topLevelModules: string[];
  singleFileFolders: number;
  linesAdded: number;
  linesRemoved: number;
  outsideRepoFiles: number;
  outsideRepoLinesAdded: number;
  outsideRepoLinesRemoved: number;
  concentration: number | null;
  band: string | null;
  largestFolderShare: number;
}
interface FileRow {
  rawPath: string;
  relPath: string | null;
  folder: string | null;
  fileKind: string | null;
  editCalls: number;
  linesAdded: number;
  linesRemoved: number;
  outsideRepo: boolean;
}
interface FilesResponse {
  files: FileRow[];
  total: number;
  truncated: boolean;
}
/** A field gs-08/expected.json must carry (optional in the shared type). */
function need<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`gs-08 expected.json changeSurface has no ${field}`);
  return value;
}

interface Edit {
  path: string;
  outsideRepo?: boolean;
}

test('@S-SESS-09 Windows change surface: scattered change, a file outside the repo, three warnings @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(180_000);
  const E = loadExpected('gs-08').roots[0];
  const X = E.changeSurface;
  const B = loadExpected('gs-09').roots[0].changeSurface;
  const edits = E.edits as Edit[];
  const outsideAdded = need(X.outsideRepoLinesAdded, 'outsideRepoLinesAdded');
  const outsideRemoved = need(X.outsideRepoLinesRemoved, 'outsideRepoLinesRemoved');
  const owner = await users.user('user', { label: 'ss09-owner' });

  const repo = await test.step('1. upload GS-08 (and GS-09, 400 Windows paths)', async () =>
    uploadGoldenRepo(api, db, owner, ['gs-08', 'gs-09']),
  );
  const sid = repo.rootId('gs-08');
  const route = (s: string) => `/api/v1/repositories/${repo.repoId}/sessions/${encodeURIComponent(s)}/change-surface`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await owner.api.get(path);
    expect(res.status(), path).toBe(200);
    return (await res.json()) as T;
  };

  await test.step('2a. API aggregate: 6 files, 6 folders, 6 modules, concentration 8, scattered, 1 file outside the repo', async () => {
    const cs = await get<ChangeSurface>(route(sid));
    expect(cs).toMatchObject({
      computed: true,
      changedFiles: X.changedFiles,
      foldersTouched: X.foldersTouched,
      singleFileFolders: X.singleFileFolders,
      linesAdded: X.linesAdded,
      linesRemoved: X.linesRemoved,
      outsideRepoFiles: X.outsideRepoFiles,
      outsideRepoLinesAdded: outsideAdded,
      outsideRepoLinesRemoved: outsideRemoved,
      concentration: X.concentration,
      band: X.band,
    });
    expect([...cs.topLevelModules].sort()).toEqual(Object.keys(need(X.folders, 'folders')).map((f) => f.split('/')[0]).sort());
  });

  await test.step('2b. API files: 6 repo paths + 1 outside; Cart.tsx once with 2 calls; relPath without drive or backslashes; rawPath keeps the first spelling', async () => {
    const { files, total, truncated } = await get<FilesResponse>(`${route(sid)}/files`);
    expect(truncated).toBe(false);
    expect(total).toBe(X.changedFiles + X.outsideRepoFiles);
    const inRepo = files.filter((f) => !f.outsideRepo);
    expect(inRepo).toHaveLength(X.changedFiles);
    for (const f of inRepo) {
      expect(f.relPath, f.rawPath).toMatch(/^[^\\:]+$/);
      expect(f.relPath!.startsWith('/'), f.rawPath).toBe(false);
    }
    const cart = inRepo.filter((f) => f.relPath === 'web/Cart.tsx');
    expect(cart).toHaveLength(1);
    expect(cart[0].editCalls).toBe(edits.filter((e) => /cart\.tsx$/i.test(e.path)).length);
    expect(cart[0].rawPath).toBe(edits.find((e) => /cart\.tsx$/i.test(e.path))!.path);
    const outside = files.filter((f) => f.outsideRepo);
    expect(outside).toHaveLength(X.outsideRepoFiles);
    expect(outside[0]).toMatchObject({ rawPath: edits.find((e) => e.outsideRepo)!.path, relPath: null, folder: null });
    const kind = (rel: string) => inRepo.find((f) => f.relPath === rel)?.fileKind;
    expect(kind('docs/changelog.md')).toBe('docs');
    expect(kind('db/migrations/001_init.sql')).toBe('source');
    expect(kind('infra/deploy.yml')).toBe('config');
  });

  await test.step('2c. GS-09: 400 backslash paths normalise to 400 repo files in 80 folders, scattered', async () => {
    const sid9 = repo.rootId('gs-09');
    const cs = await get<ChangeSurface>(route(sid9));
    expect(cs).toMatchObject({
      changedFiles: B.changedFiles,
      foldersTouched: B.foldersTouched,
      outsideRepoFiles: B.outsideRepoFiles,
      concentration: B.concentration,
      band: B.band,
    });
    const { files, total } = await get<FilesResponse>(`${route(sid9)}/files`);
    expect(total).toBe(B.changedFiles);
    expect(files.filter((f) => f.outsideRepo)).toHaveLength(0);
    expect(files.filter((f) => !/^src\/[^\\:]+$/.test(f.relPath ?? '')).map((f) => f.rawPath)).toEqual([]);
    expect(new Set(files.map((f) => f.relPath)).size).toBe(B.changedFiles);
  });

  await test.step('3. Summary: Change surface tile 8 scattered and three change-surface findings (spread, modules, single-file folders)', async () => {
    await openSession(page, owner, repo.repoId, sid);
    const tile = summaryTile(page, 'Change surface');
    await expect(tile).toContainText(`${X.changedFiles} files · ${X.foldersTouched} folders`);
    await expect(tile).toContainText(`Concentration ${X.concentration} / 100`);
    await expect(tile).toContainText(X.band!);
    // The session-level lines keep the outside file: all eight calls.
    await expect(summaryTile(page, 'Code impact')).toContainText(`${E.lines.written} lines`);
    await expect(summaryTile(page, 'Code impact')).toContainText(`+${E.lines.added} / −${E.lines.removed}`);
    const group = page.getByTestId('summary-finding-group').filter({ hasText: /change surface/i });
    const findings = group.getByTestId('summary-finding');
    await expect(findings).toHaveCount(need(X.detectors, 'detectors').length);
    await expect(findings.filter({ hasText: `Change spread across ${X.foldersTouched} folders` })).toHaveCount(1);
    await expect(findings.filter({ hasText: `${X.topLevelModules} unrelated top-level modules` })).toHaveCount(1);
    await expect(findings.filter({ hasText: `${X.singleFileFolders} folders with a single changed file` })).toHaveCount(1);
  });

  await test.step('4. «Open Change surface tab» in a finding opens the tab', async () => {
    await page.getByTestId('summary-finding-action').first().click();
    await expect(page).toHaveURL(/tab=change-surface/);
    await expect(page.getByTestId('change-surface-tab')).toBeVisible();
  });

  await test.step('5. headline, spread cards and breakdowns: repo files only, +61 / −6, the outside file noted apart', async () => {
    const headline = page.getByTestId('change-surface-headline');
    await expect(headline).toContainText(new RegExp(`Changed files\\s*${X.changedFiles}`, 'i'));
    await expect(headline).toContainText(new RegExp(`Folders touched\\s*${X.foldersTouched}`, 'i'));
    await expect(headline).toContainText(new RegExp(`Concentration\\s*${X.concentration} / 100\\s*${X.band}`, 'i'));
    await expect(headline).toContainText(new RegExp(`Lines \\+/−\\s*\\+${X.linesAdded} −${X.linesRemoved}`, 'i'));
    await expect(headline).toContainText(new RegExp(`Top-level modules\\s*${X.topLevelModules}`, 'i'));
    await expect(headline).toContainText(/Common ancestor\s*depth 0/i);
    const cards = page.getByTestId('change-surface-spread-cards');
    await expect(cards).toContainText(new RegExp(`Single-file folders\\s*${X.singleFileFolders} of ${X.foldersTouched}`, 'i'));
    await expect(cards).toContainText(/Largest-folder share\s*17%/i);
    await expect(page.getByTestId('change-surface-breakdowns')).toContainText(
      `+ ${X.outsideRepoFiles} path outside the repo (+${outsideAdded} −${outsideRemoved})`,
    );
  });

  await test.step('6. file tree: Cart.tsx is one node; the outside file sits in its own «Outside repo» group', async () => {
    const tree = page.getByTestId('change-surface-file-tree');
    await expect(tree.getByText('Cart.tsx', { exact: true })).toHaveCount(1);
    await expect(tree).toContainText(`Outside repo / unnormalised (${X.outsideRepoFiles})`);
    await expect(tree).toContainText(`+${X.linesAdded}`);
  });

  // ── OKF tab ───────────────────────────────────────────────────────────────────────────────
  const run = randomBytes(4).toString('hex');
  const okfSid = `ss09okf-${run}`;
  const subAgentId = `agent-${run}kb`;
  const okfRepoUrl = `https://git.arrakis.test/scn/ss09-okf-${run}`;
  const articles = Array.from({ length: 11 }, (_, i) => `docs/kb/a${String(i + 1).padStart(2, '0')}.md`);

  const okfRepoId = await test.step('7. upload an OKF session tree: 12-file bundle docs/kb, main agent + one sub-agent', async () => {
    const key = await createApiKey(owner.api);
    await uploadOkfSessionTree(
      api,
      key.key,
      {
        sessionId: okfSid,
        repoUrl: okfRepoUrl,
        prompt: 'document the KB-driven checkout',
        snapshot: { bundles: [{ root: 'docs/kb', files: [{ path: 'docs/kb/index.md', size: 600 }, ...articles] }] },
        actions: [
          { edit: 'docs/kb/a01.md' },
          { read: 'docs/kb/a01.md', bytes: 3000 },
          { read: 'docs/kb/index.md', bytes: 600 },
          { grep: 'docs/kb', bytes: 200 },
          { read: 'docs/kb/a02.md', bytes: 100 },
          { read: 'docs/kb/a02.md', bytes: 100 },
          { read: 'docs/kb/a02.md', bytes: 100 },
          { read: 'docs/kb/a03.md', bytes: 1000 },
        ],
        subAgents: [{ agentId: subAgentId, task: 'summarise the payment article', actions: [{ read: 'docs/kb/a04.md', bytes: 8000 }] }],
      },
      { db, userId: owner.id },
    );
    const id = await ownRepoId(owner.api, okfRepoUrl);
    const bound = await db.query<{ okf_snapshot_id: string | null }>(
      'SELECT okf_snapshot_id FROM sessions WHERE session_id = $1',
      [okfSid],
    );
    expect(bound.rows[0]?.okf_snapshot_id, 'the root session is bound to the uploaded snapshot').toMatch(/^[0-9a-f]{64}$/);
    const sub = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM session_okf_access a JOIN sessions s ON s.id = a.session_id
        WHERE s.session_id = $1 AND a.path_key = 'docs/kb/a04.md' AND a.op = 'read'`,
      [subAgentId],
    );
    expect(Number(sub.rows[0].n), 'the sub-agent read is stored on the sub-agent node (FR-4)').toBe(1);
    return id;
  });

  await test.step('8. verdict card: «Something to fix», one Why line for the main agent (3 of 11, 27 %), read top 5 with the own-edit icon, two agents', async () => {
    await openSession(page, owner, okfRepoId, okfSid, { tab: 'okf' });
    await expect(page.getByTestId('session-okf-tab')).toBeVisible();
    await expect(page.getByTestId('okf-no-snapshot')).toHaveCount(0);
    await expect(page.getByTestId('okf-verdict-level')).toHaveText('Something to fix');
    const why = page.getByTestId('okf-why-line');
    await expect(why).toHaveCount(1);
    await expect(why).toContainText(`agent ${okfSid.slice(0, 4)} read 27% of docs/kb files (3 of 11)`);
    const readTop = page.getByTestId('okf-read-top');
    await expect(readTop).toHaveCount(5);
    await expect(readTop.first()).toContainText('docs/kb/a04.md');
    await expect(readTop.filter({ hasText: 'docs/kb/a01.md' }).getByLabel('read after own edit')).toBeVisible();
    await expect(page.getByTestId('okf-agent-row')).toHaveCount(2);
    await expect(page.getByTestId('okf-bundle-card')).toContainText('docs/kb');
  });

  await test.step('9. tree: heat by bytes puts the sub-agent’s a04.md first, by calls a02.md; own-edit and folder-scan markers', async () => {
    const rows = page.getByTestId('okf-tree-row');
    await expect(rows.first()).toContainText('docs/kb');
    await expect(rows.nth(1)).toContainText('a04.md');
    await expect(rows.filter({ hasText: 'a01.md' })).toContainText('own edit');
    await expect(page.getByTestId('okf-tree')).toContainText('grep / ls over folder');
    await expect(rows.filter({ hasText: 'a11.md' })).toContainText('not read');
    await page.getByTestId('okf-metric-toggle').getByText('Calls', { exact: true }).click();
    await expect(rows.nth(1)).toContainText('a02.md');
    await page.getByTestId('okf-metric-toggle').getByText('Bytes', { exact: true }).click();
    await expect(rows.nth(1)).toContainText('a04.md');
  });

  await test.step('10. the sub-agent row narrows the tree to its read (FR-4); a Why line scrolls to and highlights the bundle', async () => {
    const rows = page.getByTestId('okf-tree-row');
    await page.getByTestId('okf-agent-row').filter({ hasText: subAgentId.slice(0, 4) }).click();
    await expect(page.getByTestId('okf-tree')).toContainText('only agent');
    await expect(rows.filter({ hasText: 'a04.md' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'a02.md' })).toHaveCount(0);
    await page.getByTestId('okf-why-line').click();
    await expect(rows.filter({ hasText: 'a02.md' }), 'the Why click clears the agent filter').toHaveCount(1);
    await expect(rows.first()).toHaveClass(/\bbg-accent\b/);
    await expect(rows.first()).toBeInViewport();
  });
});
