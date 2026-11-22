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
// Steps 7–11 — the session OKF tab (2026-11-21: the tab is a summary line and four views —
// Versions, Wrong format, Hot files, Explorer — counted in agents). Session trees are built by
// helpers/okf.ts in a repository whose snapshot has one 12-file bundle `docs/kb`. Step 7's main
// agent edits a01.md and reads it back (a read after an own edit still counts), reads index.md,
// greps the bundle folder (a folder search: its own explorer row, in no file's numbers), reads
// a02.md three times, a03.md and a05.md once and greps a03.md (a file grep counts on the file);
// its sub-agent reads a04.md (8 KB). Steps 7–10 stand for an older hook (a snapshot without
// front-matter metadata): the old-hook line replaces Versions and Wrong format.
//   - step 8: the summary line («KB read by 2 of 2 agents»), «Agents» in every count column,
//     hot files (index.md is one line below the table), none of the removed blocks;
//   - step 9: the explorer — the folder-search row, opened and never-opened files, the filters;
//   - step 10: a second tree whose agents also read and grep code files and read a KB file through
//     PowerShell `Get-Content`: only KB files are listed, with one agent each;
//   - step 11: a hook 3.1.0 snapshot (bundle `docs/guide`, `okf_version` 0.2, per-file `meta`):
//     the Versions row of an older bundle, the Wrong-format groups, nested index.md / log.md in
//     the explorer but not in hot files, a dot-path file nowhere.
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
import type { Locator } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { loadExpected } from '../helpers/golden';
import { expectOkfTreeFits, uploadOkfSessionTree } from '../helpers/okf';
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

/** `GET …/sessions/:id/okf-usage` — the fields this scenario reads. */
interface OkfUsage {
  unit: 'sessions' | 'agents';
  snapshot: { branch: string | null; takenAt: string; hasMeta: boolean } | null;
  currentFormat: string;
  summary: { unitsRead: number; unitsTotal: number; reads: number; tokens: number };
  versions: Array<{ root: string; files: number; okfVersion: string | null; older: boolean; ignored: boolean }>;
  format: {
    articles: number;
    indexFiles: number;
    withProblems: number;
    groups: Array<{ problem: string; files: Array<{ path: string; supersededBy?: string }> }>;
  } | null;
  files: Array<{ path: string; inSnapshot: boolean; index: boolean; units: number; reads: number; tokens: number }>;
  folders: Array<{
    bundle: string;
    path: string;
    units: number;
    search: { units: number; reads: number; tokens: number; cost: number | null } | null;
  }>;
}

/** Ids of the session OKF blocks removed on 2026-11-21: none of them may render. */
const REMOVED_OKF_IDS = [
  'okf-verdict-card',
  'okf-section-a',
  'okf-section-b',
  'okf-checks',
  'okf-read-top',
  'okf-upkeep-line',
  'okf-agent-row',
  'okf-bundle-card',
  'okf-value-signals-tile',
  'okf-agent-trail',
  'okf-metric-toggle',
  'okf-tree-unread-group',
  'okf-thresholds-chip',
];

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
          { grep: 'docs/kb/a03.md', bytes: 50 },
          { read: 'docs/kb/a05.md', bytes: 100 },
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

  /** One explorer row by its kind and `data-path` (a folder key ends in `/`, a bundle is its root). */
  const treeRow = (kind: 'bundle' | 'folder' | 'file' | 'search', path: string) =>
    page.locator(`[data-testid="okf-tree-row"][data-kind="${kind}"][data-path="${path}"]`);
  /** Opens (or closes) an expandable explorer row. */
  const toggleRow = (row: Locator) => row.getByRole('button').first().click();
  const hotRow = (path: string) => page.locator(`[data-testid="okf-hot-row"][data-path="${path}"]`);
  const hotPaths = () =>
    page.getByTestId('okf-hot-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path')));
  const sessionOkf = async (s: string): Promise<OkfUsage> => {
    const res = await owner.api.get(`/api/v1/repositories/${okfRepoId}/sessions/${encodeURIComponent(s)}/okf-usage`);
    expect(res.status(), `okf-usage of ${s}`).toBe(200);
    return (await res.json()) as OkfUsage;
  };
  const opened = (u: OkfUsage) => u.files.filter((f) => f.units > 0).map((f) => f.path);

  await test.step('8. session OKF tab: «KB read by 2 of 2 agents», «Agents» in every count column and no «Sessions» label, the old-hook line, hot files without index.md, none of the removed blocks', async () => {
    const usage = await sessionOkf(okfSid);
    expect(usage.unit).toBe('agents');
    expect(usage.snapshot, 'an older hook: a snapshot without metadata').toMatchObject({ branch: 'main', hasMeta: false });
    // main: a01.md read back after its own edit (3000 B), index.md (600), the folder grep (200),
    // a02.md ×3 (300), a03.md (1000) and its file grep (50), a05.md (100); sub-agent: a04.md
    // (8000). The Edit is no read. 13 250 B / 4.
    expect(usage.summary).toMatchObject({ unitsRead: 2, unitsTotal: 2, reads: 10, tokens: 3312.5 });
    expect({ versions: usage.versions, format: usage.format }).toEqual({ versions: [], format: null });

    await openSession(page, owner, okfRepoId, okfSid, { tab: 'okf' });
    const tab = page.getByTestId('session-okf-tab');
    await expect(tab).toBeVisible();
    await expect(tab.getByTestId('okf-no-snapshot')).toHaveCount(0);
    await expect(tab.getByTestId('okf-summary-ratio')).toHaveText('KB read by 2 of 2 agents');
    await expect(tab.getByTestId('okf-summary-tokens')).toHaveText('≈ 3.3K tokens of context');
    await expect(tab.getByTestId('okf-summary-snapshot')).toContainText('snapshot from main, ');
    await expect(tab.getByTestId('okf-old-hook-line')).toHaveText('Update the hook to see versions and format problems.');
    await expect(tab.getByTestId('okf-versions')).toHaveCount(0);
    await expect(tab.getByTestId('okf-format')).toHaveCount(0);

    // The unit is the agent everywhere: the hot-files column, the explorer column, the header.
    const table = tab.getByTestId('okf-hot-files');
    await expect(table.locator('th', { has: page.getByTestId('okf-hot-sort-units') })).toContainText('Agents');
    await expect(tab.getByTestId('okf-tree')).toContainText('Agents');
    await expect(tab, 'no «Sessions» label on the session tab').not.toContainText('Sessions');

    // Hot files, by ≈ Tokens: the sub-agent's a04.md first; a01.md (read after the own edit) is
    // a hot file like any other; index.md is one line below the table.
    await expect
      .poll(hotPaths)
      .toEqual(['docs/kb/a04.md', 'docs/kb/a01.md', 'docs/kb/a03.md', 'docs/kb/a02.md', 'docs/kb/a05.md']);
    const a04 = hotRow('docs/kb/a04.md').locator('td');
    await expect(a04.nth(1), 'agents').toHaveText('1');
    await expect(a04.nth(2), 'reads').toHaveText('1');
    await expect(a04.nth(3), '≈ tokens').toHaveText('2.0K');
    await expect(hotRow('docs/kb/a02.md').locator('td').nth(2), 'three reads of a02.md').toHaveText('3');
    await expect(hotRow('docs/kb/a03.md').locator('td').nth(2), 'the read and the file grep of a03.md').toHaveText('2');
    await expect(table.getByTestId('okf-hot-index-line')).toContainText('1 index file is not listed');

    for (const id of REMOVED_OKF_IDS) await expect(page.getByTestId(id), `${id} is gone`).toHaveCount(0);
  });

  await test.step('9. explorer: 6 of 12 files opened in this session; the folder grep is a search row; a03.md (read + file grep) and the sub-agent’s a04.md are opened, a06.md is not; «Never opened» lists the other six', async () => {
    const usage = await sessionOkf(okfSid);
    expect(opened(usage)).toEqual(['a01', 'a02', 'a03', 'a04', 'a05', 'index'].map((n) => `docs/kb/${n}.md`));
    expect(usage.folders, 'both agents opened a file of the folder; the folder grep is in no file').toEqual([
      { bundle: 'docs/kb', path: 'docs/kb/', units: 2, search: expect.objectContaining({ units: 1, reads: 1, tokens: 50 }) },
    ]);

    await expect(page.getByTestId('okf-tree-header')).toHaveText('6 of 12 files opened in this session');
    await expect(page.getByTestId('okf-tree-filter-opened')).toHaveText('Opened (6)');
    await expect(page.getByTestId('okf-tree-filter-never')).toHaveText('Never opened (6)');
    // Collapsed at first: the bundle root only.
    const rows = page.getByTestId('okf-tree-row');
    await expect(rows).toHaveCount(1);
    const root = treeRow('bundle', 'docs/kb');
    await expect(root).toContainText('6 of 12');
    await toggleRow(root);
    await expect(rows).toHaveCount(14);
    const search = treeRow('search', 'docs/kb/');
    await expect(search).toContainText('searches across this folder');
    const a03 = treeRow('file', 'docs/kb/a03.md');
    await expect(a03).toHaveAttribute('data-opened', 'true');
    await expect(a03.locator('> span').nth(2), 'agents').toHaveText('1');
    await expect(a03.locator('> span').nth(3), '≈ tokens of the read and the file grep').toHaveText('0.3K');
    const a04 = treeRow('file', 'docs/kb/a04.md');
    await expect(a04, 'opened by the sub-agent').toHaveAttribute('data-opened', 'true');
    await expect(a04.locator('> span').nth(3)).toHaveText('2.0K');
    const a06 = treeRow('file', 'docs/kb/a06.md');
    await expect(a06).toHaveAttribute('data-opened', 'false');
    await expect(a06.locator('> span').nth(2), 'a never-opened file has no numbers').toHaveText('—');
    await expectOkfTreeFits(page);

    await page.getByTestId('okf-tree-filter-never').click();
    await expect(search).toHaveCount(0);
    await expect(a04).toHaveCount(0);
    await expect(page.locator('[data-testid="okf-tree-row"][data-kind="file"]')).toHaveCount(6);
    await expect(page.locator('[data-testid="okf-tree-row"][data-kind="file"][data-opened="true"]')).toHaveCount(0);
    await page.getByTestId('okf-tree-filter-opened').click();
    await expect(page.locator('[data-testid="okf-tree-row"][data-kind="file"]')).toHaveCount(6);
    await expect(a06).toHaveCount(0);
    await expect(search, 'the search row stays under «Opened»').toHaveCount(1);
  });

  await test.step('10. a second tree whose agents also read and grep code files, and a08.md read through PowerShell Get-Content: hot files list a06.md, a07.md and a08.md with one agent each and no code path; «KB read by 2 of 2 agents»', async () => {
    // Main agent: a ranged read of a06.md, then a read and two greps of payment code files.
    // Then a PowerShell `Get-Content` of a08.md — a KB read like the Read tool (FR-13).
    // Sub-agent: one read of a07.md. Code files are not KB files: they count nowhere.
    const sid2 = `ss09okf2-${run}`;
    const sub2 = `agent-${run}ptr`;
    const key = await createApiKey(owner.api);
    await uploadOkfSessionTree(
      api,
      key.key,
      {
        sessionId: sid2,
        repoUrl: okfRepoUrl,
        prompt: 'trace the card charge flow <pasted_content id="1">TypeError: amount is undefined</pasted_content>',
        snapshot: { bundles: [{ root: 'docs/kb', files: [{ path: 'docs/kb/index.md', size: 600 }, ...articles] }] },
        actions: [
          {
            read: 'docs/kb/a06.md',
            offset: 10,
            limit: 20,
            result: 'Charge flow: `server/pay/charge.ts`; refunds: `server/pay/refund.ts`.\n',
          },
          { read: 'server/pay/charge.ts' },
          { grep: 'server/pay/charge.ts', pattern: 'chargeCard' },
          { grep: 'server/pay/refund.ts', pattern: 'refundAll', result: 'No matches found' },
          { psRead: 'docs/kb/a08.md' },
        ],
        subAgents: [
          {
            agentId: sub2,
            description: 'Check refunds vs ledger',
            task: 'check `server/pay/refund.ts` against the ledger',
            actions: [
              {
                read: 'docs/kb/a07.md',
                result:
                  'Ledger: `server/pay/ledger.ts` (logs via `Logger.error`, reads `process.env`, calls `LedgerService.post()`, since `2.31.0`); refunds in `server/pay/refund.ts`.\n',
              },
            ],
          },
        ],
      },
      { db, userId: owner.id },
    );

    const usage = await sessionOkf(sid2);
    expect(usage.summary).toMatchObject({ unitsRead: 2, unitsTotal: 2, reads: 3 });
    expect(opened(usage)).toEqual(['docs/kb/a06.md', 'docs/kb/a07.md', 'docs/kb/a08.md']);
    expect(usage.files.every((f) => f.inSnapshot), 'a code file is not a «not in this snapshot» file either').toBe(true);
    expect(JSON.stringify(usage)).not.toContain('server/pay');

    await openSession(page, owner, okfRepoId, sid2, { tab: 'okf' });
    // Same page, hash-only navigation: reload so the session list sees the new tree.
    await page.reload();
    const tab = page.getByTestId('session-okf-tab');
    await expect(tab).toBeVisible();
    await expect(tab.getByTestId('okf-summary-ratio')).toHaveText('KB read by 2 of 2 agents');
    const hot = ['docs/kb/a06.md', 'docs/kb/a07.md', 'docs/kb/a08.md'];
    await expect.poll(async () => [...(await hotPaths())].sort()).toEqual(hot);
    for (const path of hot) {
      await expect(hotRow(path).locator('td').nth(1), `${path}: one agent`).toHaveText('1');
      await expect(hotRow(path).locator('td').nth(2), `${path}: one read`).toHaveText('1');
    }
    await expect(tab.getByTestId('okf-hot-index-line'), 'no index file was read').toHaveCount(0);
    await expect(tab).not.toContainText('server/pay');
    await expect(tab.getByTestId('okf-tree-header')).toHaveText('3 of 12 files opened in this session');
    await expectOkfTreeFits(page);
  });

  await test.step('11. OKF v0.3 front matter (2026-11-19): a hook 3.1.0 snapshot — the Versions row «0.2, older than the current format», Wrong format: deprecated (with its replacement), past «stale after», no front matter; nested index.md / log.md are in the explorer, not in hot files; a dot-path file is nowhere', async () => {
    const sid3 = `ss09okf3-${run}`;
    const fm = { frontMatter: true, hasGenerated: true, hasTimestamp: false };
    const key = await createApiKey(owner.api);
    await uploadOkfSessionTree(
      api,
      key.key,
      {
        sessionId: sid3,
        repoUrl: okfRepoUrl,
        prompt: 'set up the dev environment',
        snapshot: {
          bundles: [
            {
              root: 'docs/guide',
              okfVersion: '0.2',
              title: 'Team guide',
              description: 'How the team sets up, builds and ships the shop',
              files: [
                { path: 'docs/guide/index.md', size: 500, meta: { ...fm, type: 'Index' } },
                {
                  path: 'docs/guide/setup.md',
                  meta: { ...fm, type: 'Article', status: 'Deprecated', superseded_by: 'install.md' },
                },
                { path: 'docs/guide/install.md', meta: { ...fm, type: 'Article', stale_after: '2020-01-01' } },
                { path: 'docs/guide/old.md', meta: { frontMatter: false, hasGenerated: false, hasTimestamp: false } },
                { path: 'docs/guide/api/routes.md', meta: { ...fm, type: 'Article' } },
                // Reserved names at any depth are index files: read like any KB file, never checked.
                { path: 'docs/guide/log.md', meta: { frontMatter: false, hasGenerated: false, hasTimestamp: false } },
                { path: 'docs/guide/sub/index.md', meta: { frontMatter: false, hasGenerated: false, hasTimestamp: false } },
                // A dot-path is not part of the bundle at all.
                { path: 'docs/guide/.hidden/notes.md', meta: { frontMatter: false, hasGenerated: false, hasTimestamp: false } },
              ],
            },
          ],
        },
        actions: [
          { read: 'docs/guide/index.md', bytes: 500 },
          { read: 'docs/guide/setup.md', bytes: 400 },
          { read: 'docs/guide/sub/index.md', bytes: 200 },
          { read: 'docs/guide/log.md', bytes: 200 },
          { read: 'docs/guide/.hidden/notes.md', bytes: 300 },
          { read: 'docs/guide/api/routes.md', result: 'Routes need a running stack — see `../install.md` first.\n' },
          { read: 'docs/guide/install.md', bytes: 700 },
        ],
      },
      { db, userId: owner.id },
    );

    const usage = await sessionOkf(sid3);
    expect(usage.snapshot).toMatchObject({ branch: 'main', hasMeta: true });
    expect(usage.currentFormat).toBe('0.3');
    expect(usage.versions, 'seven files — the dot-path file is not part of the KB').toEqual([
      { root: 'docs/guide', files: 7, okfVersion: '0.2', older: true, ignored: false },
    ]);
    // setup, install, old and api/routes are the articles; index.md, log.md and sub/index.md are
    // index files. `install.md` is relative to the deprecated article's folder.
    expect(usage.format).toEqual({
      articles: 4,
      indexFiles: 3,
      withProblems: 3,
      groups: [
        { problem: 'no_front_matter', files: [{ path: 'docs/guide/old.md' }] },
        { problem: 'deprecated', files: [{ path: 'docs/guide/setup.md', supersededBy: 'docs/guide/install.md' }] },
        { problem: 'past_stale_after', files: [{ path: 'docs/guide/install.md' }] },
      ],
    });
    expect(usage.summary, 'six reads; the dot-path read is not a KB read').toMatchObject({ unitsRead: 1, unitsTotal: 1, reads: 6 });
    expect(opened(usage)).toEqual(
      ['api/routes.md', 'index.md', 'install.md', 'log.md', 'setup.md', 'sub/index.md'].map((p) => `docs/guide/${p}`),
    );
    expect(JSON.stringify(usage)).not.toContain('.hidden');
    const version = await db.query<{ v: number | null }>(
      'SELECT okf_extract_version AS v FROM sessions WHERE session_id = $1',
      [sid3],
    );
    expect(version.rows[0]?.v, 'stamped by the current extractor').toBe(5);

    await openSession(page, owner, okfRepoId, sid3, { tab: 'okf' });
    await page.reload();
    const tab = page.getByTestId('session-okf-tab');
    await expect(tab).toBeVisible();
    await expect(tab.getByTestId('okf-summary-ratio')).toHaveText('KB read by 1 of 1 agents');
    await expect(tab.getByTestId('okf-old-hook-line')).toHaveCount(0);

    // A bundle behind the current format: Versions starts expanded.
    const versions = tab.getByTestId('okf-versions');
    await expect(versions).toHaveAttribute('data-collapsed', 'false');
    const versionRow = page.locator('[data-testid="okf-version-row"][data-root="docs/guide"]');
    await expect(versionRow).toContainText('7 files');
    await expect(versionRow).toContainText('0.2');
    await expect(versionRow.getByTestId('okf-version-older')).toHaveText('older than the current format 0.3');

    const format = tab.getByTestId('okf-format');
    await expect(format).toContainText('Wrong format — 3 of 4 articles');
    await expect(format.getByTestId('okf-format-group')).toHaveCount(3);
    const group = (problem: string) => format.locator(`[data-testid="okf-format-group"][data-problem="${problem}"]`);
    for (const [problem, file] of [
      ['deprecated', 'docs/guide/setup.md → replaced by docs/guide/install.md'],
      ['past_stale_after', 'docs/guide/install.md'],
      ['no_front_matter', 'docs/guide/old.md'],
    ]) {
      await group(problem).getByRole('button').click();
      await expect(group(problem).getByTestId('okf-format-file'), problem).toHaveText(file);
      await group(problem).getByRole('button').click();
    }

    // Index files are in the explorer, never among the hot files.
    await expect
      .poll(async () => [...(await hotPaths())].sort())
      .toEqual(['docs/guide/api/routes.md', 'docs/guide/install.md', 'docs/guide/setup.md']);
    await expect(tab.getByTestId('okf-hot-index-line')).toContainText('3 index files are not listed');
    await expect(tab.getByTestId('okf-tree-header')).toHaveText('6 of 7 files opened in this session');
    await toggleRow(treeRow('bundle', 'docs/guide'));
    await expect(treeRow('file', 'docs/guide/log.md')).toHaveAttribute('data-opened', 'true');
    await expect(treeRow('file', 'docs/guide/old.md')).toHaveAttribute('data-opened', 'false');
    const sub = treeRow('folder', 'docs/guide/sub/');
    await expect(sub).toContainText('1 of 1');
    await toggleRow(sub);
    await expect(treeRow('file', 'docs/guide/sub/index.md')).toHaveAttribute('data-opened', 'true');
    await expect(tab, 'the dot-path file is nowhere').not.toContainText('notes.md');
    for (const id of REMOVED_OKF_IDS) await expect(page.getByTestId(id), `${id} is gone`).toHaveCount(0);
    await expectOkfTreeFits(page);
  });
});
