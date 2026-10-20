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
import { test, expect } from '../fixtures';
import { loadExpected } from '../helpers/golden';
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
});
