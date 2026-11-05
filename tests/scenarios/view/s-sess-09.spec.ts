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
// bundle folder (folder scan), reads a02.md three times, a03.md and a05.md once and greps a03.md
// (a file grep, not counted in the folder-scan marker); its sub-agent
// reads a04.md (8 KB). Shares count articles only (index.md is the entry point): main agent 3 of
// the 10 articles it did not write (30 % > 25 %) → «Something to fix» with one Why line; the
// sub-agent's 1 of 11 is fine. Since 2026-11-03 (OKF value signals, DD-15) the a01.md read back
// after the own edit is upkeep: it leaves Read top 5 for the Upkeep line and its tree row shows
// `upkeep ×1` next to `own edit`. Step 11 uploads a second tree in the same repository for the
// value-signal UI (section reads, pointers, searches after reading, the agents panel columns).
// OKF tab quick wins: agents are named `main` / `1.N · <description or task head>`, a folder's
// unread articles fold into one «N articles not read in this session» row (hidden while the
// tree is filtered to one agent), and a `<pasted_content>` wrapper is stripped from task heads.
// Package 2 (2026-11-05): the tab is split into section A (structure, verified) and B (value
// signals, heuristic, with a «N signals to check» count); the verdict card lists one Checks line
// per structure rule (step 8: the session_share finding, step 11: an OK share line) and links to
// the repository OKF tab.
// Package 3 (agent trail): step 12 opens an agent's trail in section B (`okfAgent` in the URL) —
// call order, the new code paths of a read and where they were opened, in-area searches with
// `found` / `nothing found`.
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

  await test.step('8. verdict card: «Something to fix», one Why line for the main agent (3 of 10, 30 %), read top 5 without the upkeep a01.md (on the Upkeep line), two agents', async () => {
    await openSession(page, owner, okfRepoId, okfSid, { tab: 'okf' });
    await expect(page.getByTestId('session-okf-tab')).toBeVisible();
    await expect(page.getByTestId('okf-no-snapshot')).toHaveCount(0);
    await expect(page.getByTestId('okf-verdict-level')).toHaveText('Something to fix');
    const why = page.getByTestId('okf-why-line');
    await expect(why).toHaveCount(1);
    // The root agent is named `main` (OKF tab quick wins: agent labels).
    await expect(why).toContainText('agent main read 30% of docs/kb files (3 of 10)');
    const readTop = page.getByTestId('okf-read-top');
    await expect(readTop).toHaveCount(5);
    await expect(readTop.first()).toContainText('docs/kb/a04.md');
    // FR-5 (2026-11-03 DD-15): a01.md, read back after the agent's own edit, is upkeep — it
    // leaves Read top 5 for the muted Upkeep line.
    await expect(readTop.filter({ hasText: 'docs/kb/a01.md' })).toHaveCount(0);
    await expect(page.getByTestId('okf-upkeep-line')).toContainText('docs/kb/a01.md');
    await expect(page.getByTestId('okf-upkeep-line')).toContainText('1 read');
    await expect(page.getByTestId('okf-agent-row')).toHaveCount(2);
    await expect(page.getByTestId('okf-bundle-card')).toContainText('docs/kb');

    // Package 2 (2026-11-05): the tab is split into A (structure, verified) and B (value
    // signals, heuristic); A's verdict card lists one Checks line per structure rule with the
    // counted value and its threshold, also when the rule found nothing.
    await expect(page.getByTestId('okf-section-a').getByTestId('okf-section-title')).toHaveText('A · How the KB was navigated (verified)');
    await expect(page.getByTestId('okf-section-a').getByTestId('okf-verdict-card')).toHaveCount(1);
    await expect(page.getByTestId('okf-section-a').getByTestId('okf-bundle-card')).toHaveCount(1);
    await expect(page.getByTestId('okf-section-b').getByTestId('okf-section-title')).toHaveText('B · Did the articles help? (heuristic — check by hand)');
    await expect(page.getByTestId('okf-section-b').getByTestId('okf-value-signals-tile')).toHaveCount(1);
    await expect(page.getByTestId('okf-section-b-intro')).toContainText('they cannot know what a search was about');
    await expect(page.getByTestId('okf-section-b-count')).toHaveText('nothing to check');
    const checks = page.getByTestId('okf-checks');
    await expect(checks).toContainText('How the agents navigated the KB — counted from tool calls');
    const lines = checks.getByTestId('okf-check-line');
    await expect(lines).toHaveCount(4);
    const kbUsed = lines.and(page.locator('[data-rule="kb_used"]'));
    await expect(kbUsed).toHaveAttribute('data-status', 'ok');
    await expect(kbUsed.getByTestId('okf-check-text')).toHaveText('2 of 2 agents read the KB (docs/kb)');
    const share = lines.and(page.locator('[data-rule="session_share"]'));
    await expect(share).toHaveAttribute('data-status', 'finding');
    // main wrote a01.md, so 10 articles are left; it read a02, a03 and a05 (upkeep excluded).
    await expect(share.getByTestId('okf-check-text')).toHaveText(
      'main read 3 of 10 articles of docs/kb (30 %) — wholesale reading (finding at > 25 %, mess at > 50 %)',
    );
    await expect(share.getByTestId('okf-check-action')).toHaveText(
      '→ sharpen the one-line descriptions in docs/kb/index.md so the agent can pick one article',
    );
    const upkeep = lines.and(page.locator('[data-rule="upkeep"]'));
    await expect(upkeep).toHaveAttribute('data-status', 'ok');
    await expect(upkeep.getByTestId('okf-check-text')).toHaveText(
      'main edited docs/kb/a01.md — reads of an article the same agent edits are upkeep and excluded above',
    );
    await expect(lines.and(page.locator('[data-rule="entry"]'))).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('okf-checks-repo-note')).toContainText(
      'Repo-level checks (always read, KB flood, coarse article) run over many sessions on the repository OKF tab',
    );
  });

  await test.step('9. tree: heat by bytes puts the sub-agent’s a04.md first, by calls a02.md; own-edit and folder-scan markers', async () => {
    const rows = page.getByTestId('okf-tree-row');
    await expect(rows.first()).toContainText('docs/kb');
    await expect(rows.nth(1)).toContainText('a04.md');
    await expect(rows.filter({ hasText: 'a01.md' })).toContainText('own edit');
    await expect(rows.filter({ hasText: 'a01.md' })).toContainText('upkeep ×1');
    // The bundle's grepCalls (2) include the file grep on a03.md; the marker counts the folder's own grep only.
    await expect(rows.first()).toContainText('grep / ls over folder ×1');
    // Session tree: the six unread articles fold into one row; «show» lists them.
    const unread = page.getByTestId('okf-tree-unread-group');
    await expect(unread).toHaveText('6 articles not read in this session · show');
    await expect(rows.filter({ hasText: 'a11.md' })).toHaveCount(0);
    await unread.click();
    await expect(rows.filter({ hasText: 'a11.md' })).toContainText('not read');
    await expect(unread).toContainText('hide');
    await expect(page.getByTestId('okf-tree-legend')).toContainText('Code paths followed');
    await expectOkfTreeFits(page);
    await page.getByTestId('okf-metric-toggle').getByText('Calls', { exact: true }).click();
    await expect(rows.nth(1)).toContainText('a02.md');
    await page.getByTestId('okf-metric-toggle').getByText('Bytes', { exact: true }).click();
    await expect(rows.nth(1)).toContainText('a04.md');
  });

  await test.step('10. the sub-agent row narrows the tree to its read (FR-4); a Why line scrolls to and highlights the bundle', async () => {
    const rows = page.getByTestId('okf-tree-row');
    // Neither a description nor a task head (the helper's sub-agent log has no first prompt):
    // the sub-agent is named by its short id, the 8 characters after `agent-`.
    const subLabel = page.getByTestId('okf-agent-label').filter({ hasText: `1.1 · ${run}` });
    await expect(subLabel).toHaveCount(1);
    await subLabel.click();
    await expect(page.getByTestId('okf-tree')).toContainText(`only agent 1.1 · ${run}`);
    await expect(page.getByTestId('okf-tree-unread-group'), 'unread rows are hidden while filtered to one agent').toHaveCount(0);
    await expect(rows.filter({ hasText: 'a04.md' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'a02.md' })).toHaveCount(0);
    await page.getByTestId('okf-why-line').click();
    await expect(rows.filter({ hasText: 'a02.md' }), 'the Why click clears the agent filter').toHaveCount(1);
    await expect(rows.first()).toHaveClass(/\bbg-accent\b/);
    await expect(rows.first()).toBeInViewport();
  });

  await test.step('11. value signals (2026-11-03): § section chip, POINTERS USED / EXPL. AFTER columns, per-agent pointers with the prompt-named count, agents panel yield / misses / upkeep / searches', async () => {
    // Main agent: reads lines 10–29 of a06.md (a section read), which names two payment files;
    // it opens charge.ts (a followed pointer) and greps both files twice after reading. The
    // sub-agent's task already names refund.ts, so only ledger.ts is new in its read of a07.md.
    const sid2 = `ss09okf2-${run}`;
    const sub2 = `agent-${run}ptr`;
    const key = await createApiKey(owner.api);
    await uploadOkfSessionTree(
      api,
      key.key,
      {
        sessionId: sid2,
        repoUrl: okfRepoUrl,
        // The pasted-content wrapper is stripped from the task head, its text kept (OKF quick wins).
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
          // Package 3: this search found nothing (the trail's `nothing found`).
          { grep: 'server/pay/refund.ts', pattern: 'refundAll', result: 'No matches found' },
        ],
        subAgents: [
          {
            agentId: sub2,
            description: 'Check refunds vs ledger',
            task: 'check `server/pay/refund.ts` against the ledger',
            actions: [{ read: 'docs/kb/a07.md', result: 'Ledger: `server/pay/ledger.ts`; refunds in `server/pay/refund.ts`.\n' }],
          },
        ],
      },
      { db, userId: owner.id },
    );

    await openSession(page, owner, okfRepoId, sid2, { tab: 'okf' });
    // Same page, hash-only navigation: reload so the session list sees the new tree.
    await page.reload();
    await expect(page.getByTestId('session-okf-tab')).toBeVisible();
    await expect(page.getByTestId('okf-read-top').filter({ hasText: 'docs/kb/a06.md' }).getByTestId('okf-section-chip')).toHaveText(
      '1 partial read (line range)',
    );
    const tile = page.getByTestId('okf-value-signals-tile');
    await expect(tile.getByTestId('okf-signal-pointers-used')).toContainText('1 / 2 reads');
    await expect(tile.getByTestId('okf-signal-searched-after')).toContainText('1 agent kept searching after reading');
    await expect(tile.getByTestId('okf-signal-searched-after').getByTestId('okf-signal-caption')).toContainText('Counted per agent and article');
    // Section B counts the non-zero signals: the one search after reading.
    await expect(page.getByTestId('okf-section-b-count')).toHaveText('1 signal to check');
    // Section A: every agent read 1 of the 11 articles — an OK share line with the number and
    // the threshold (the first of the equal shares, main, is named).
    const share = page.getByTestId('okf-check-line').and(page.locator('[data-rule="session_share"]'));
    await expect(share).toHaveAttribute('data-status', 'ok');
    await expect(share.getByTestId('okf-check-text')).toHaveText(
      'Targeted reads — at most 1 of 11 articles (9 %) per agent (main, docs/kb). More than 25 % means an agent read the KB wholesale instead of finding one article',
    );
    await expect(page.getByTestId('okf-check-line').and(page.locator('[data-rule="upkeep"]')).getByTestId('okf-check-text')).toHaveText(
      'No agent edited an article it read',
    );

    const rows = page.getByTestId('okf-tree-row');
    const a06 = rows.filter({ hasText: 'a06.md' });
    await expect(a06).toContainText('1 partial read (line range)');
    await expect(a06.getByTestId('okf-tree-pointers-used')).toHaveText('1 / 1');
    await expect(a06.getByTestId('okf-tree-searched-after')).toHaveText('1 · 2');
    const a07 = rows.filter({ hasText: 'a07.md' });
    await expect(a07.getByTestId('okf-tree-pointers-used')).toHaveText('0 / 1');
    await a07.getByTestId('okf-pointers-toggle').click();
    const sub = page.getByTestId('okf-agent-pointers').filter({ hasText: '1.1 · Check refunds vs ledger' });
    await expect(sub.getByTestId('okf-agent-pointer')).toHaveText(['· server/pay/ledger.ts']);
    await expect(sub.getByTestId('okf-prompt-named')).toContainText('1 path already named in its prompt');
    // Long marker texts and the opened code-path rows still fit without sideways scroll.
    await expectOkfTreeFits(page);

    const mainRow = page.getByTestId('okf-agent-row').filter({ hasText: 'trace the card charge flow' });
    await expect(mainRow.getByTestId('okf-agent-label')).toHaveText('main');
    await expect(mainRow).toContainText('trace the card charge flow TypeError: amount is undefined');
    await expect(mainRow).not.toContainText('pasted_content');
    await expect(mainRow.getByTestId('okf-agent-yield')).toContainText('1 / 1');
    await expect(mainRow.getByTestId('okf-agent-misses')).toContainText('0');
    await expect(mainRow.getByTestId('okf-agent-upkeep')).toContainText('0');
    await expect(mainRow.getByTestId('okf-agent-searches')).toContainText('2');
    const subRow = page.getByTestId('okf-agent-row').filter({ hasNotText: 'trace the card charge flow' });
    await expect(subRow).toHaveCount(1);
    await expect(subRow.getByTestId('okf-agent-label')).toHaveText('1.1 · Check refunds vs ledger');
    await expect(subRow.getByTestId('okf-agent-yield')).toContainText('0 / 1');
    await expect(subRow.getByTestId('okf-agent-searches')).toContainText('0');

    // The Checks block's link opens the repository OKF tab, where the repo-level rules run.
    await page.getByTestId('okf-checks-open-repo').click();
    await expect(page).toHaveURL(/[?&]mtab=okf\b/);
    await expect(page).not.toHaveURL(/[?&]session=/);
    await expect(page.getByTestId('session-okf-tab')).toHaveCount(0);
    await expect(page.getByTestId('okf-checks').getByTestId('okf-check-line').and(page.locator('[data-rule="kb_sessions"]'))).toHaveCount(1);
  });

  await test.step('12. agent trail (package 3): the searched-after tile link opens main’s trail (`okfAgent`): the a06.md read, its two code paths and what became of them, the in-area searches with their result; the sub-agent’s trail from the Agents panel', async () => {
    const sid2 = `ss09okf2-${run}`;
    const sub2 = `agent-${run}ptr`;
    await openSession(page, owner, okfRepoId, sid2, { tab: 'okf' });
    await expect(page.getByTestId('session-okf-tab')).toBeVisible();
    await expect(page.getByTestId('okf-agent-trail')).toHaveCount(0);
    await expect(page.getByTestId('okf-trail-prompt')).toBeVisible();

    // Section B's «searched after reading» number links to the trail of the agent behind it.
    await page.getByTestId('okf-signal-searched-after').getByTestId('okf-signal-trail-link').click();
    await expect(page).toHaveURL(new RegExp(`[?&]okfAgent=${sid2}(&|$)`));
    const trail = page.getByTestId('okf-section-b').getByTestId('okf-agent-trail');
    await expect(trail.getByTestId('okf-trail-title')).toHaveText('Agent trail · main · 4 calls');
    // One episode, opened by the KB read; the call numbers in order.
    await expect(trail.getByTestId('okf-trail-episode')).toHaveCount(1);
    await expect(trail.getByTestId('okf-trail-episode')).toHaveAttribute('data-article', 'docs/kb/a06.md');
    const items = trail.getByTestId('okf-trail-item');
    await expect(items).toHaveCount(4);
    for (const [i, op] of ['kb_read', 'read', 'search', 'search'].entries()) {
      await expect(items.nth(i)).toHaveAttribute('data-ord', String(i + 1));
      await expect(items.nth(i)).toHaveAttribute('data-op', op);
    }
    await expect(items.nth(0)).toContainText('docs/kb/a06.md');
    await expect(items.nth(0)).toContainText('lines 10–29');
    // The read showed two new code paths: charge.ts was opened at #2, refund.ts only searched at #4.
    await expect(items.nth(0).getByTestId('okf-trail-pointer')).toHaveText([
      '✓ server/pay/charge.ts (opened at #2)',
      '✓ server/pay/refund.ts (searched at #4)',
    ]);
    await expect(trail.getByTestId('okf-trail-after')).toHaveText('── after reading: 2 searches in its area, 1 file opened ──');
    // The searches: full pattern, the result, and the mark of the article whose area they hit.
    await expect(items.nth(2).getByTestId('okf-trail-pattern')).toHaveText('"chargeCard"');
    await expect(items.nth(2).getByTestId('okf-trail-hit')).toHaveText('found');
    await expect(items.nth(2).getByTestId('okf-trail-in-area')).toHaveText('in area of a06.md');
    await expect(items.nth(3).getByTestId('okf-trail-pattern')).toHaveText('"refundAll"');
    await expect(items.nth(3).getByTestId('okf-trail-hit')).toHaveText('nothing found');
    await expect(items.nth(3)).toHaveAttribute('data-in-area', 'true');
    await expect(items.nth(1)).toHaveAttribute('data-in-area', 'true');
    await expect(trail.getByTestId('okf-trail-hint')).toContainText('a search for something the article names is a gap in the article');

    // The Agents panel selects another agent: the sub-agent's read showed ledger.ts (refund.ts
    // was named in its task), which it never opened.
    await page.getByTestId('okf-agent-row').filter({ hasNotText: 'trace the card charge flow' }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]okfAgent=${sub2}(&|$)`));
    await expect(trail).toHaveAttribute('data-agent', sub2);
    await expect(trail.getByTestId('okf-trail-title')).toHaveText('Agent trail · 1.1 · Check refunds vs ledger · 1 call');
    await expect(trail.getByTestId('okf-trail-pointer')).toHaveText(['· server/pay/ledger.ts (never opened)']);
    await expect(trail.getByTestId('okf-trail-after')).toHaveCount(0);

    // The selection survives a reload (URL state); closing the trail clears it.
    await page.reload();
    await expect(page.getByTestId('okf-agent-trail')).toHaveAttribute('data-agent', sub2);
    await page.getByTestId('okf-trail-close').click();
    await expect(page).not.toHaveURL(/[?&]okfAgent=/);
    await expect(page.getByTestId('okf-agent-trail')).toHaveCount(0);
  });
});
