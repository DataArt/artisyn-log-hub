// S-REPT-01. Executive Summary: totals, filters, period, PDF
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-REPT-01; no mode in the design
// → A and C, DD SC4).
//
// Data: all of REPO-GOLD (ten roots) in one repository, uploaded through POST /api/v2/logs (DD SC3).
// Every number comes from tests/golden/repo-gold.expected.json (DD D3, scenarios/03 §2.4).
//
// Code facts that differ from the design text:
//   - The page prints Total AI Cost, Total Sessions, Active Users and Avg Cost / Session as tiles,
//     and Total Lines Changed, Avg Cost / Line («$0.0055/line») and Avg Lines / Hour («1,317»,
//     rounded) in the KPI table under them. The average session length is the «Avg Work Time» of
//     the Usage by Engineer total row and reads «2m» (reports round to minutes), not «2:26».
//   - The W2 «vs previous period» is a sub-line of the tiles («vs $2.7348 previous period»); with an
//     empty previous window the sub-line is absent.
//   - The user filter is shown only in a team view; in a personal repository it is API-only
//     (`users=`). `users=all` is a literal e-mail filter: 200 with no sessions.
//   - Weekly buckets and the model mix are charts; their numbers are asserted on the API, the page
//     is checked for the four model names in the model-mix legend.
//
// Steps 8–10 — the repo OKF tab's verdict card (2026-10-27-okf-usage-tab, DD-38): five OKF
// session trees (helpers/okf.ts, DD-36) in a repository of their own read `core.md` and 4 KB of
// the 100 KB `big.md` → «Something to fix» with two «always read» lines and one «coarse
// article» line; a branch filter down to three KB sessions shows «Not enough data» with the
// findings still listed.
//
// Replaces:
//   - tests/e2e/executive-summary-report.spec.ts (42)
//   - server/test/executive-summary-report-filters.e2e-spec.ts (4)
//   - server/test/executive-summary-spend-sections.e2e-spec.ts (branch filter part)
//   - server/test/session-cost-consistency.e2e-spec.ts (Executive Summary part)
//   - server/src/logs/reports/*.spec.ts (Executive Summary parts)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadOkfSessionTree } from '../helpers/okf';
import { ownRepoId, rangeAround } from '../helpers/prompt-session';
import { usd4 } from '../helpers/session-view';
import { downloadPdfText, kpiRowValues, kpiTile, openReport, repoGet, reportSection, uploadRepoGold } from '../helpers/reports';

test.use({ timezoneId: 'UTC' });

interface ExecutiveSummary {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  avgCostPerSession: number;
  totalLinesChanged: number;
  avgCostPerLine: number;
  avgLinesPerHour: number;
  avgSessionLengthMs: number;
  excludedSessionCount: number;
  excludedModels: string[];
  previousPeriod: { totalCost: number; totalSessions: number } | null;
  weeklyBuckets: Array<{ weekStart: string; sessionCount: number; totalCost: number }>;
  modelMix: Array<{ model: string; sessionCount: number; cost: number }>;
  topSessions: Array<{ startTime: string; cost: number; branch: string | null; model: string | null } & Record<string, unknown>>;
}

interface OkfRepoUsage {
  verdict: { level: string; findings: Array<{ rule: string; node: { bundle: string | null; path?: string } }> };
  tiles: { kbSessions: number };
}

const BILLING = 'feature/billing';

test('@S-REPT-01 executive summary: totals, filters, period, PDF @mode-a @mode-c', async ({ api, db, users, page }) => {
  test.setTimeout(240_000);
  const owner = await users.user('user', { label: 'rept01-owner' });
  const gold = await test.step('0. upload REPO-GOLD (ten root sessions)', async () => uploadRepoGold(api, db, owner));
  const t = gold.totals;
  const from = gold.day('2026-01-05');
  const to = gold.day('2026-01-18');
  const w2 = { startDate: gold.day('2026-01-12'), endDate: to };
  const apiRange = (r: { startDate: string; endDate: string }) => ({
    startDate: `${r.startDate}T00:00:00.000Z`,
    endDate: `${r.endDate}T23:59:59.999Z`,
  });
  const keyOfStart = new Map([...gold.expected.values()].map((e) => [gold.at(e.start).getTime(), e.key]));

  await test.step('1–2. Reports → Executive Summary A..A+13d: tiles, KPI table, exclusion note, model mix, top 5 without prompts', async () => {
    await openReport(page, owner, gold.repoId, 'executive-summary', { startDate: from, endDate: to });
    await expect(kpiTile(page, 'Total AI Cost')).toContainText(usd4(t.costUsd));
    await expect(kpiTile(page, 'Total AI Cost')).not.toContainText('previous period');
    await expect(kpiTile(page, 'Total Sessions')).toContainText(String(t.rootSessions));
    await expect(kpiTile(page, 'Active Users / Team Size')).toContainText('1');
    await expect(kpiTile(page, 'Avg Cost / Session')).toContainText(usd4(t.avgCostPerSessionUsd));
    await expect(kpiRowValues(page, 'Total Lines Changed').first()).toHaveText(String(t.lines.written));
    await expect(kpiRowValues(page, 'Avg Cost / Line').first()).toHaveText(`${usd4(t.avgCostPerLineUsd)}/line`);
    await expect(kpiRowValues(page, 'Avg Lines / Hour').first()).toHaveText(Math.round(t.avgLinesPerHour).toLocaleString('en-US'));
    await expect(page.getByText(`${t.excludedSessionCount} sessions excluded from cost`).first()).toBeVisible();
    await expect(page.getByText(`no pricing for model ${t.excludedModels[0]}`, { exact: false }).first()).toBeVisible();
    const engineers = reportSection(page, 'Usage by Engineer');
    await expect(engineers.locator('tr', { hasText: 'Total / Avg' })).toContainText(`${Math.round(t.avgSessionLengthMs / 60_000)}m`);
    const mix = reportSection(page, 'Model Mix');
    for (const model of Object.keys(t.costByRootModel)) await expect(mix.getByText(model).first()).toBeVisible();
    const top = reportSection(page, 'Top 5 Most Expensive Sessions');
    await expect(top.locator('thead th')).toHaveText(['Date', 'Engineer', 'Branch', 'Work Time', 'Cost', 'Model', 'Tokens (In / Out)', 'Cache (Read / Write)'], {
      ignoreCase: true,
    });
    const rows = top.locator('tbody tr');
    await expect(rows).toHaveCount(t.topSessionsByCost.length);
    for (const [i, s] of t.topSessionsByCost.entries()) {
      const e = gold.expected.get(s.key)!;
      await expect(rows.nth(i)).toContainText(usd4(s.costUsd));
      await expect(rows.nth(i)).toContainText(e.branch);
      await expect(rows.nth(i)).toContainText(e.model);
    }
  });

  await test.step('3. period W2: «vs previous period» compares with W1 ($2.7348, 5 sessions)', async () => {
    const r = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', apiRange(w2));
    expect(r.totalCost).toBeCloseTo(t.costByWeek.W2, 6);
    expect(r.totalSessions).toBe(t.sessionsByWeek.W2);
    expect(r.previousPeriod?.totalCost).toBeCloseTo(t.costByWeek.W1, 6);
    expect(r.previousPeriod?.totalSessions).toBe(t.sessionsByWeek.W1);
    await openReport(page, owner, gold.repoId, 'executive-summary', w2);
    await expect(kpiTile(page, 'Total AI Cost')).toContainText(usd4(t.costByWeek.W2));
    await expect(kpiTile(page, 'Total AI Cost')).toContainText(`vs ${usd4(t.costByWeek.W1)} previous period`);
    await expect(kpiTile(page, 'Total Sessions')).toContainText(`vs ${t.sessionsByWeek.W1} previous period`);
  });

  await test.step(`4. branch filter ${BILLING} (Generate): $1.2610 over 4 sessions, one excluded; cleared again: $2.9469`, async () => {
    const billing = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', { ...gold.range, branches: BILLING });
    expect(billing.totalCost).toBeCloseTo(t.costByBranch[BILLING], 6);
    expect(billing.totalSessions).toBe(t.sessionsByBranch[BILLING]);
    expect(billing.excludedSessionCount).toBe(1);

    const toggle = async (branch: string) => {
      await page.getByRole('button', { name: /All branches|\d+ selected/ }).click();
      await page.locator('label', { hasText: branch }).getByRole('checkbox').click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Generate' }).click();
    };
    await openReport(page, owner, gold.repoId, 'executive-summary', { startDate: from, endDate: to });
    await toggle(BILLING);
    await expect(page.getByRole('button', { name: '1 selected' })).toBeVisible();
    await expect(kpiTile(page, 'Total AI Cost')).toContainText(usd4(t.costByBranch[BILLING]));
    await expect(kpiTile(page, 'Total Sessions')).toContainText(String(t.sessionsByBranch[BILLING]));
    await expect(page.getByText('1 sessions excluded from cost').first()).toBeVisible();
    await toggle(BILLING);
    await expect(page.getByRole('button', { name: 'All branches' })).toBeVisible();
    await expect(kpiTile(page, 'Total AI Cost')).toContainText(usd4(t.costUsd));
  });

  await test.step('5. download the PDF: not empty, the title, the total and «1 sessions excluded from cost»', async () => {
    const pdf = await downloadPdfText(page);
    expect(pdf.filename).toBe(`executive-summary_${from}_${to}.pdf`);
    expect(pdf.text.length).toBeGreaterThan(200);
    expect(pdf.text).toMatch(/Executive\s+Summary/);
    expect(pdf.text).toContain(usd4(t.costUsd));
    expect(pdf.text).toMatch(/1\s+sessions\s+excluded\s+from\s+cost/);
  });

  await test.step('6. GET .../reports/executive-summary A..A+13d: the REPO-GOLD totals', async () => {
    const r = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', gold.range);
    expect(r.totalSessions).toBe(t.rootSessions);
    expect(r.totalCost).toBeCloseTo(t.costUsd, 6);
    expect(r.avgCostPerSession).toBeCloseTo(t.avgCostPerSessionUsd, 6);
    expect(r.totalLinesChanged).toBe(t.lines.written);
    expect(r.avgCostPerLine).toBeCloseTo(t.avgCostPerLineUsd, 6);
    expect(r.avgLinesPerHour).toBeCloseTo(t.avgLinesPerHour, 4);
    expect(r.avgSessionLengthMs).toBe(t.avgSessionLengthMs);
    expect(r.activeUsers).toBe(1);
    expect(r.excludedSessionCount).toBe(t.excludedSessionCount);
    expect(r.excludedModels).toEqual(t.excludedModels);
    expect(r.previousPeriod).toBeNull();
    // Weeks: W1 and W2, five sessions each, adding up to the total.
    const week = (fixtureMonday: string) => r.weeklyBuckets.find((b) => b.weekStart.slice(0, 10) === gold.day(fixtureMonday))!;
    expect(week('2026-01-05').totalCost).toBeCloseTo(t.costByWeek.W1, 6);
    expect(week('2026-01-12').totalCost).toBeCloseTo(t.costByWeek.W2, 6);
    expect(week('2026-01-05').sessionCount).toBe(t.sessionsByWeek.W1);
    expect(week('2026-01-12').sessionCount).toBe(t.sessionsByWeek.W2);
    expect(r.weeklyBuckets.reduce((n, b) => n + b.totalCost, 0)).toBeCloseTo(r.totalCost, 6);
    // Model mix by root model: sub-agents (haiku, opus-5 under GS-02) count inside the sonnet row.
    for (const [model, m] of Object.entries(t.costByRootModel)) {
      const mix = r.modelMix.find((x) => x.model === model);
      expect(mix?.sessionCount, model).toBe(m.sessions);
      expect(mix?.cost, model).toBeCloseTo(m.costUsd ?? 0, 6);
    }
    expect(r.modelMix.reduce((n, m) => n + m.sessionCount, 0)).toBe(t.rootSessions);
    // Top 5 by cost, each row only date / engineer / branch / duration / cost / model / tokens.
    expect(r.topSessions.map((s) => keyOfStart.get(Date.parse(s.startTime)))).toEqual(t.topSessionsByCost.map((s) => s.key));
    t.topSessionsByCost.forEach((s, i) => expect(r.topSessions[i].cost, s.key).toBeCloseTo(s.costUsd, 6));
    for (const s of r.topSessions) {
      expect(Object.keys(s).filter((k) => /prompt/i.test(k)), 'no prompt text in a top-session row').toEqual([]);
    }
  });

  await test.step('6a. branches=main and users=all answer 200 (once a 500 «malformed array literal»); a users= filter on the owner keeps everything', async () => {
    const main = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', { ...gold.range, branches: 'main' });
    expect(main.totalSessions).toBe(t.sessionsByBranch.main);
    expect(main.totalCost).toBeCloseTo(t.costByBranch.main, 6);
    const all = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', { ...gold.range, users: 'all' });
    expect(all.totalSessions).toBe(0);
    const mine = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', { ...gold.range, users: owner.email });
    expect(mine.totalSessions).toBe(t.rootSessions);
    expect(mine.totalCost).toBeCloseTo(t.costUsd, 6);
  });

  await test.step('7. empty range 2020-01-01..02: zeros, no NaN, no crash', async () => {
    const r = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', apiRange({ startDate: '2020-01-01', endDate: '2020-01-02' }));
    expect(r).toMatchObject({ totalSessions: 0, totalCost: 0, avgCostPerSession: 0, totalLinesChanged: 0, excludedSessionCount: 0 });
    await openReport(page, owner, gold.repoId, 'executive-summary', { startDate: '2020-01-01', endDate: '2020-01-02' });
    await expect(kpiTile(page, 'Total AI Cost')).toContainText('$0.0000');
    await expect(kpiTile(page, 'Total Sessions')).toContainText('0');
    await expect(reportSection(page, 'Top 5 Most Expensive Sessions').getByText('No sessions in the selected period.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('NaN');
  });

  // ── Repo OKF tab verdict (2026-10-27-okf-usage-tab, FR-14a, FR-17a, DD-38) ────────────────
  const run = randomBytes(4).toString('hex');
  const okfRepoUrl = `https://git.arrakis.test/scn/rept01-okf-${run}`;
  const KB = 'docs/kb';
  const BIG_SIZE = 100_000;
  const FEAT = 'feat/okf';
  const okfRepoId = await test.step('8. upload 5 OKF session trees into their own repository: 2 on main, 3 on feat/okf, each reads index.md, core.md and 4 KB of the 100 KB big.md', async () => {
    const key = await createApiKey(owner.api);
    const branches = ['main', 'main', FEAT, FEAT, FEAT];
    for (const [i, branch] of branches.entries()) {
      await uploadOkfSessionTree(
        api,
        key.key,
        {
          sessionId: `rept01-okf-${run}-${i}`,
          repoUrl: okfRepoUrl,
          branch,
          prompt: `okf session ${i} ${run}`,
          at: new Date(Date.now() - 24 * 60 * 60 * 1000 - i * 60 * 60 * 1000),
          snapshot: {
            bundles: [
              {
                root: KB,
                files: [`${KB}/core.md`, { path: `${KB}/big.md`, size: BIG_SIZE }, `${KB}/other1.md`, `${KB}/other2.md`, `${KB}/other3.md`],
              },
            ],
          },
          actions: [{ read: `${KB}/index.md`, bytes: 500 }, { read: `${KB}/core.md` }, { read: `${KB}/big.md`, bytes: 4000 }],
        },
        { db, userId: owner.id },
      );
    }
    return ownRepoId(owner.api, okfRepoUrl);
  });
  const okfUsage = (query: Record<string, string> = {}) =>
    repoGet<OkfRepoUsage>(owner, okfRepoId, '/reports/okf-usage', { ...Object.fromEntries(new URLSearchParams(rangeAround())), ...query });

  await test.step('9. 5 KB sessions: «Something to fix» — core.md and big.md always read, big.md a coarse article; the anomaly lines say so', async () => {
    const r = await okfUsage();
    expect(r.tiles.kbSessions).toBe(5);
    expect(r.verdict.level).toBe('fix');
    const rules = r.verdict.findings.map((f) => `${f.rule}:${f.node.path ?? ''}`).sort();
    expect(rules).toEqual([`always_read:${KB}/big.md`, `always_read:${KB}/core.md`, `coarse_article:${KB}/big.md`].sort());

    await page.goto(`/#/repos/${okfRepoId}?mtab=okf`);
    await expect(page.getByTestId('tab-repo-okf')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('okf-verdict-level')).toHaveText('Something to fix');
    const lines = page.getByTestId('okf-why-line');
    await expect(lines).toHaveCount(3);
    await expect(lines.filter({ hasText: `${KB}/core.md is read in 5 of 5 KB sessions (100%)` })).toHaveCount(1);
    await expect(lines.filter({ hasText: `${KB}/big.md (` }).filter({ hasText: 'is read in 5 sessions, ~' })).toContainText('(4%)');
    await expect(page.getByTestId('okf-tile-sessions').locator('p').first()).toHaveText('5 / 5');
  });

  await test.step(`10. branch filter ${FEAT}: 3 KB sessions → «Not enough data», the findings still listed`, async () => {
    const r = await okfUsage({ branches: FEAT });
    expect(r.tiles.kbSessions).toBe(3);
    expect(r.verdict.level).toBe('not_enough_data');
    expect(r.verdict.findings.map((f) => f.rule)).toContain('always_read');

    await page.goto(`/#/repos/${okfRepoId}?mtab=okf&okfBranches=${encodeURIComponent(encodeURIComponent(FEAT))}`);
    await expect(page.getByTestId('okf-verdict-level')).toHaveText('Not enough data');
    await expect(page.getByTestId('okf-why-line').filter({ hasText: `${KB}/core.md is read in 3 of 3 KB sessions` })).toHaveCount(1);
    await expect(page.getByTestId('okf-tile-sessions').locator('p').first()).toHaveText('3 / 3');
  });
});
