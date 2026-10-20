// S-REPT-02. Cache Read Ratio: a ratio of sums, the «root / with descendants» pair, causes, threshold
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-REPT-02; no mode in the design
// → A and C, DD SC4).
//
// Data: all of REPO-GOLD (ten roots, five sub-agents) in one repository, uploaded through
// POST /api/v2/logs (DD SC3). Totals from tests/golden/repo-gold.expected.json (DD D3): root ratio
// 0.369785 (37.0 %), with descendants 0.379275 (37.9 %); the mean of the sessions' own ratios,
// 0.613690 (61.4 %), is the trap the report must NOT print. Per-branch and per-day sums are re-added
// here from the fixtures' own token counts, so a group or a day that loses a session shows up.
//
// Code facts that differ from the design text:
//   - The report's buckets are per UTC day (`YYYY-MM-DD`) and only days with sessions are listed.
//   - The cause table is root-only and its footnote names the threshold source («the built-in
//     default» / «your personal override»).
//   - «Sessions with undefined ratio (excluded)» counts per scope: with descendants it stays 2 too
//     (GS-06b and GS-09 have no sub-agents).
//
// Replaces:
//   - server/test/cache-read-ratio-report.e2e-spec.ts (16)
//   - server/src/logs/reports/cache-read-ratio.service.spec.ts (≈ 20 of 29)
//   - client/src/viewer/__tests__/unit/cache-cause-parity.test.ts (6)
//   - client/src/viewer/__tests__/unit/cache-ratio-aggregate.test.ts (rest of 14)
//   - server/src/logs/turn-walk.spec.ts (cause part of 24)
//   - tests/e2e/cache-read-ratio.spec.ts
import { test, expect } from '../fixtures';
import { type GoldenRootExpected, type GoldenTokens } from '../helpers/golden';
import { pct1 } from '../helpers/session-view';
import { downloadPdfText, kpiRowValues, openReport, repoGet, reportSection, uploadRepoGold } from '../helpers/reports';

test.use({ timezoneId: 'UTC' });

interface Scope {
  sessionCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  ratio: number | null;
  undefinedRatioSessionCount: number;
}
interface CauseEntry {
  turns: number;
  creationTokens: number;
}
interface CacheReadRatio {
  root: Scope;
  withDescendants: Scope;
  buckets: Array<{ bucket: string; root: Omit<Scope, 'undefinedRatioSessionCount'>; withDescendants: Omit<Scope, 'undefinedRatioSessionCount'> }>;
  groups?: Array<{ group: string; root: Scope; withDescendants: Scope }>;
  causes: {
    scope: 'root';
    thresholdTokens: number;
    thresholdSource: 'user' | 'team' | 'default';
    totalCreationTokens: number;
    compaction: CauseEntry;
    fileReread: CauseEntry;
    unattributed: CauseEntry;
  };
}

const BILLING = 'feature/billing';
const write = (t: GoldenTokens) => t.cacheWrite5m + t.cacheWrite1h;
const int = (n: number) => n.toLocaleString('en-US');

test('@S-REPT-02 cache read ratio: ratio of sums, root / with descendants, causes, threshold @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await users.user('user', { label: 'rept02-owner' });
  const gold = await test.step('0. upload REPO-GOLD (ten root sessions)', async () => uploadRepoGold(api, db, owner));
  const t = gold.totals;
  const roots = [...gold.expected.values()];
  const from = gold.day('2026-01-05');
  const to = gold.day('2026-01-18');
  const sum = (rs: GoldenRootExpected[], pick: (r: GoldenRootExpected) => number) => rs.reduce((n, r) => n + pick(r), 0);
  const billingRoots = roots.filter((r) => r.branch === BILLING);
  const billingRead = sum(billingRoots, (r) => r.tokens.own.cacheRead);
  const billingWrite = sum(billingRoots, (r) => write(r.tokens.own));
  const gs03Causes = (gold.expected.get('gs03')!.cacheCreationCauses as Record<string, { compaction: number; fileReread: number; unattributed: number }>)
    .threshold25000;

  await test.step('1. GET .../reports/cache-read-ratio A..A+13d: root 562 000 / 957 800 (877 800 + 80 000) = 37.0 %, with descendants 590 000 / 965 600 = 37.9 %, never the 61.4 % mean', async () => {
    const r = await repoGet<CacheReadRatio>(owner, gold.repoId, '/reports/cache-read-ratio', gold.range);
    expect(r.root).toMatchObject({
      sessionCount: t.rootSessions,
      cacheReadTokens: t.tokens.root.cacheRead,
      cacheWriteTokens: t.tokens.root.cacheWrite,
      cacheWrite5mTokens: t.tokens.root.cacheWrite5m,
      cacheWrite1hTokens: t.tokens.root.cacheWrite1h,
      undefinedRatioSessionCount: t.undefinedRatioSessions,
    });
    expect(r.withDescendants).toMatchObject({
      sessionCount: t.sessionsWithDescendants,
      cacheReadTokens: t.tokens.tree.cacheRead,
      cacheWriteTokens: t.tokens.tree.cacheWrite,
      cacheWrite5mTokens: t.tokens.tree.cacheWrite5m,
      cacheWrite1hTokens: t.tokens.tree.cacheWrite1h,
    });
    expect(t.tokens.root).toMatchObject({ cacheRead: 562_000, cacheWrite: 957_800, cacheWrite5m: 877_800, cacheWrite1h: 80_000 });
    expect(t.tokens.tree).toMatchObject({ cacheRead: 590_000, cacheWrite: 965_600 });
    expect(r.root.ratio).toBeCloseTo(t.cacheRatio.root, 6);
    expect(r.withDescendants.ratio).toBeCloseTo(t.cacheRatio.withDescendants, 6);
    expect(t.cacheRatio).toMatchObject({ root: 0.369785, withDescendants: 0.379275, meanOfSessionRatiosTrap: 0.61369 });
    // The trap: the mean of the per-session ratios (the two n/a sessions left out) is 0.613690.
    const own = roots.map((e) => e.cacheRatio.own).filter((x): x is number => x !== null);
    expect(own.reduce((n, x) => n + x, 0) / own.length).toBeCloseTo(t.cacheRatio.meanOfSessionRatiosTrap, 5);
    expect(Math.abs(r.root.ratio! - t.cacheRatio.meanOfSessionRatiosTrap)).toBeGreaterThan(0.2);
    // Daily buckets: per UTC day, tokens adding up to the totals; Tue W1 holds GS-02 and GS-04.
    for (const b of r.buckets) expect(b.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sessionDays = [...new Set(roots.map((e) => gold.at(e.start).toISOString().slice(0, 10)))].sort();
    expect(r.buckets.map((b) => b.bucket).sort()).toEqual(sessionDays);
    expect(r.withDescendants.undefinedRatioSessionCount).toBe(t.undefinedRatioSessions);
    expect(r.buckets.reduce((n, b) => n + b.root.cacheReadTokens, 0)).toBe(t.tokens.root.cacheRead);
    expect(r.buckets.reduce((n, b) => n + b.root.cacheWriteTokens, 0)).toBe(t.tokens.root.cacheWrite);
    expect(r.buckets.reduce((n, b) => n + b.withDescendants.cacheReadTokens, 0)).toBe(t.tokens.tree.cacheRead);
    const tue = r.buckets.find((b) => b.bucket === gold.day('2026-01-06'))!;
    expect(tue.root.cacheReadTokens).toBe(gold.expected.get('gs02')!.tokens.own.cacheRead + gold.expected.get('gs04')!.tokens.own.cacheRead);
  });

  await test.step('2. UI Reports → Cost → Cache Read Ratio: both scopes side by side — 37.0 % and 37.9 %, 2 sessions with an undefined ratio, no 61.4 %', async () => {
    await openReport(page, owner, gold.repoId, 'cache-read-ratio', { startDate: from, endDate: to });
    await expect(kpiRowValues(page, 'Cache read ratio')).toHaveText([pct1(t.cacheRatio.root), pct1(t.cacheRatio.withDescendants)]);
    await expect(kpiRowValues(page, 'Cache read ratio')).toHaveText(['37.0%', '37.9%']);
    await expect(kpiRowValues(page, 'Sessions in scope')).toHaveText([String(t.rootSessions), String(t.sessionsWithDescendants)]);
    await expect(kpiRowValues(page, 'Cache read tokens')).toHaveText([int(t.tokens.root.cacheRead), int(t.tokens.tree.cacheRead)]);
    await expect(kpiRowValues(page, 'Cache write tokens (total)')).toHaveText([int(t.tokens.root.cacheWrite), int(t.tokens.tree.cacheWrite)]);
    await expect(kpiRowValues(page, '5m TTL')).toHaveText([int(t.tokens.root.cacheWrite5m), int(t.tokens.tree.cacheWrite5m)]);
    await expect(kpiRowValues(page, '1h TTL')).toHaveText([int(t.tokens.root.cacheWrite1h), int(t.tokens.tree.cacheWrite1h)]);
    await expect(kpiRowValues(page, 'Sessions with undefined ratio (excluded)').first()).toHaveText(String(t.undefinedRatioSessions));
    await expect(page.locator('body')).not.toContainText(pct1(t.cacheRatio.meanOfSessionRatiosTrap));
  });

  await test.step('3. groupBy=branch (API and UI): the groups add up to the totals; feature/billing 295 000 / 817 800', async () => {
    const r = await repoGet<CacheReadRatio>(owner, gold.repoId, '/reports/cache-read-ratio', { ...gold.range, groupBy: 'branch' });
    const groups = r.groups ?? [];
    expect(groups.map((g) => g.group).sort()).toEqual(Object.keys(t.costByBranch).sort());
    expect(groups.reduce((n, g) => n + g.root.cacheReadTokens, 0)).toBe(t.tokens.root.cacheRead);
    expect(groups.reduce((n, g) => n + g.root.cacheWriteTokens, 0)).toBe(t.tokens.root.cacheWrite);
    expect(groups.reduce((n, g) => n + g.withDescendants.cacheReadTokens, 0)).toBe(t.tokens.tree.cacheRead);
    for (const g of groups) {
      const rs = roots.filter((e) => e.branch === g.group);
      expect(g.root.cacheReadTokens, g.group).toBe(sum(rs, (e) => e.tokens.own.cacheRead));
      expect(g.root.cacheWriteTokens, g.group).toBe(sum(rs, (e) => write(e.tokens.own)));
      expect(g.root.sessionCount, g.group).toBe(rs.length);
    }
    const billing = groups.find((g) => g.group === BILLING)!;
    expect([billing.root.cacheReadTokens, billing.root.cacheWriteTokens]).toEqual([billingRead, billingWrite]);
    expect([billingRead, billingWrite]).toEqual([295_000, 817_800]);

    await openReport(page, owner, gold.repoId, 'cache-read-ratio', { startDate: from, endDate: to, groupBy: 'branch' });
    const row = reportSection(page, 'Breakdown by branch').locator('tbody tr', { hasText: BILLING });
    await expect(row.locator('td')).toHaveText([
      BILLING,
      String(billingRoots.length),
      pct1(billingRead / (billingRead + billingWrite)),
      pct1(billing.withDescendants.ratio!),
      int(billingRead),
      int(billingWrite),
    ]);
  });

  const causes = reportSection(page, 'Why was cache creation high?');
  const causeRow = (cause: string) => causes.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${cause}$`) }) });

  await test.step(`4. ${BILLING} causes at the default 25 000: compaction 29 900, file re-reads 29 900, unattributed 758 000 = 817 800`, async () => {
    const r = await repoGet<CacheReadRatio>(owner, gold.repoId, '/reports/cache-read-ratio', { ...gold.range, branches: BILLING });
    expect(r.causes).toMatchObject({ scope: 'root', thresholdTokens: 25_000, thresholdSource: 'default', totalCreationTokens: billingWrite });
    expect(r.causes.compaction.creationTokens).toBe(gs03Causes.compaction);
    expect(r.causes.fileReread.creationTokens).toBe(gs03Causes.fileReread);
    expect(r.causes.unattributed.creationTokens).toBe(billingWrite - gs03Causes.compaction - gs03Causes.fileReread);
    expect([gs03Causes.compaction, gs03Causes.fileReread, r.causes.unattributed.creationTokens]).toEqual([29_900, 29_900, 758_000]);

    await openReport(page, owner, gold.repoId, 'cache-read-ratio', { startDate: from, endDate: to, branches: [BILLING] });
    await expect(causeRow('Compaction').locator('td').nth(2)).toHaveText(int(29_900));
    await expect(causeRow('File re-reads').locator('td').nth(2)).toHaveText(int(29_900));
    await expect(causeRow('Unattributed').locator('td').nth(2)).toHaveText(int(758_000));
    await expect(causeRow('Total').locator('td').nth(2)).toHaveText(int(billingWrite));
    await expect(causes).toContainText('threshold from the built-in default');
  });

  await test.step('5. personal threshold 30 000 (PUT .../settings/user): compaction 0, file re-reads 0, unattributed 817 800, source «user»; creation tokens unchanged', async () => {
    const put = await owner.api.put(`/api/v1/repositories/${gold.repoId}/settings/user`, {
      data: { config: { fileCategories: [], highCacheCreationThreshold: 30_000 } },
    });
    expect(put.status(), await put.text()).toBe(200);
    const r = await repoGet<CacheReadRatio>(owner, gold.repoId, '/reports/cache-read-ratio', { ...gold.range, branches: BILLING });
    expect(r.causes).toMatchObject({ thresholdTokens: 30_000, thresholdSource: 'user', totalCreationTokens: billingWrite });
    expect(r.causes.compaction.creationTokens).toBe(0);
    expect(r.causes.fileReread.creationTokens).toBe(0);
    expect(r.causes.unattributed.creationTokens).toBe(billingWrite);
    expect(r.root.cacheWriteTokens).toBe(billingWrite);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Download as PDF' })).toBeEnabled({ timeout: 15_000 });
    await expect(causeRow('Compaction').locator('td').nth(2)).toHaveText('0');
    await expect(causeRow('File re-reads').locator('td').nth(2)).toHaveText('0');
    await expect(causeRow('Unattributed').locator('td').nth(2)).toHaveText(int(billingWrite));
    await expect(causes).toContainText('threshold from your personal override');
  });

  await test.step('6. download the PDF: the report title and the ratio', async () => {
    await openReport(page, owner, gold.repoId, 'cache-read-ratio', { startDate: from, endDate: to });
    const pdf = await downloadPdfText(page);
    expect(pdf.text).toContain('Cache Read Ratio');
    expect(pdf.text).toContain(pct1(t.cacheRatio.root));
    expect(pdf.text).toContain(pct1(t.cacheRatio.withDescendants));
  });
});
