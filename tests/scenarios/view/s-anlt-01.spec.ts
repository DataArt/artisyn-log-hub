// S-ANLT-01. Analytics: timeline, cost, work time on the golden repository
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-ANLT-01; no mode in the design
// → A and C, DD SC4).
//
// Data: all of REPO-GOLD (GS-01…GS-09, ten roots, five sub-agents) in one repository, uploaded through
// POST /api/v2/logs (DD SC3). Every number comes from tests/golden/repo-gold.expected.json and the
// fixtures' expected.json (DD D3).
//
// Code facts that differ from the design text:
//   - The Analytics Cost and Work Time views bucket sessions by START HOUR, not by week: there is no
//     weekly column in Analytics (the weekly W1/W2 totals live in the Executive Summary, S-REPT-01).
//     The scenario reads the Tuesday-W1 10:00 bar instead — GS-02 and GS-04 share it — whose tooltip
//     lists both sessions, and the horizontal layout grouped by branch for the per-branch cost.
//     Both views print money as `$x.xx` (four decimals only under one cent).
//   - The Analytics Work Time view shows each session's own work time; the merged per-day minutes
//     (GS-02 ∪ GS-04 = 185 s, not 305 s) come from `GET .../analytics/work-time`, which feeds
//     Reports → Work Time Distribution: its «Total Work Time» is the merged 22m, not the 24m sum.
//   - An empty range prints «no sessions» («No sessions active in this range.» is the Active
//     Sessions view's text).
//   - `branches=` (empty) is no filter at all — the routes treat an empty list as «every branch».
//
// Replaces:
//   - server/test/repositories-analytics.e2e-spec.ts (30)
//   - tests/e2e/analytics-horizontal-view.spec.ts (22)
//   - client/src/viewer/__tests__/unit/repository-analytics.test.ts (≈ 20 of 33)
//   - tests/e2e/usage-analytics.spec.ts (timeline part)
import { test, expect } from '../fixtures';
import { openAnalytics, openReport, repoGet, uploadRepoGold, kpiRowValues } from '../helpers/reports';

test.use({ timezoneId: 'UTC' });

interface TimelineRow {
  sessionId: string;
  gitBranch: string | null;
  group: string | null;
  workTimeMs: number;
  totalCost: number | null;
}
interface WorkTimeRow {
  day: string;
  group: string | null;
  workTimeMinutes: number;
}

/** `1.3999` → `$1.40`, `0.0086` → `$0.0086`: the Analytics charts' money format. */
const chartUsd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
/** `125000` → `2:05`: the Analytics charts' work-time format. */
const chartDuration = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

test('@S-ANLT-01 analytics: timeline, cost, work time on the golden repository @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await users.user('user', { label: 'anlt01-owner' });
  const gold = await test.step('1. upload GS-01…GS-09 (ten root sessions) into REPO-GOLD', async () =>
    uploadRepoGold(api, db, owner),
  );
  const t = gold.totals;
  const keys = [...gold.expected.keys()];
  const sumCost = (rows: TimelineRow[]) => rows.reduce((n, r) => n + (r.totalCost ?? 0), 0);

  await test.step(`2. timeline A..A+13d: ${t.rootSessions} roots, GS-02 0.1173 with its grandchild, GS-06b null, priced sum ${t.costUsd}`, async () => {
    const rows = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', gold.range);
    expect(rows).toHaveLength(t.rootSessions);
    expect(rows.map((r) => gold.keyOf(r.sessionId)).sort()).toEqual([...keys].sort());
    for (const r of rows) {
      const e = gold.expected.get(gold.keyOf(r.sessionId))!;
      if (e.costUsd === null) expect(r.totalCost, e.key).toBeNull();
      else expect(r.totalCost, e.key).toBeCloseTo(e.costUsd, 6);
      expect(r.workTimeMs, e.key).toBe(e.workTimeMs);
    }
    expect(rows.find((r) => r.sessionId === gold.sid('gs02'))!.totalCost).toBeCloseTo(0.1173, 6);
    expect(rows.find((r) => r.sessionId === gold.sid('gs06b'))!.totalCost).toBeNull();
    expect(sumCost(rows)).toBeCloseTo(t.costUsd, 6);
    expect(t.costUsd).toBeCloseTo(2.9469, 6);
  });

  await test.step('2a. groupBy=branch: main 1.5998, feature/billing 1.2610, fix/windows 0.0861', async () => {
    const rows = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', { ...gold.range, groupBy: 'branch' });
    expect(rows).toHaveLength(t.rootSessions);
    const byGroup = new Map<string, TimelineRow[]>();
    for (const r of rows) byGroup.set(r.group ?? '', [...(byGroup.get(r.group ?? '') ?? []), r]);
    expect([...byGroup.keys()].sort()).toEqual(Object.keys(t.costByBranch).sort());
    for (const [branch, cost] of Object.entries(t.costByBranch)) {
      expect(sumCost(byGroup.get(branch)!), branch).toBeCloseTo(cost, 6);
      expect(byGroup.get(branch)!.length, `${branch} sessions`).toBe(t.sessionsByBranch[branch]);
    }
    expect(t.costByBranch).toEqual({ main: 1.5998, 'feature/billing': 1.261, 'fix/windows': 0.0861 });
  });

  await test.step('2b. branches=main: the three main sessions; groupBy=branch with a branches filter → 400; branches= is no filter', async () => {
    const main = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', { ...gold.range, branches: 'main' });
    expect(main.map((r) => gold.keyOf(r.sessionId)).sort()).toEqual(['gs01', 'gs02', 'gs04']);
    const both = await owner.api.get(`/api/v1/repositories/${gold.repoId}/analytics/timeline`, {
      params: { ...gold.range, groupBy: 'branch', branches: 'main' },
    });
    expect(both.status()).toBe(400);
    const empty = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', { ...gold.range, branches: '' });
    expect(empty).toHaveLength(t.rootSessions);
  });

  const tueW1 = gold.day('2026-01-06');

  await test.step('3. work-time A..A+13d: 14 daily points, zero days present, Tue W1 3.0833 min (GS-02 ∪ GS-04 = 185 s, not 305 s)', async () => {
    const rows = await repoGet<WorkTimeRow[]>(owner, gold.repoId, '/analytics/work-time', gold.range);
    const days = Object.entries(t.workTimeMinutesByDay);
    expect(rows).toHaveLength(14);
    expect(days).toHaveLength(14);
    const byDay = new Map(rows.map((r) => [r.day.slice(0, 10), r.workTimeMinutes]));
    for (const [day, minutes] of days) expect(byDay.get(gold.day(day)), day).toBeCloseTo(minutes, 4);
    expect(byDay.get(tueW1)).toBeCloseTo(185 / 60, 4);
    const unmerged = (gold.expected.get('gs02')!.workTimeMs + gold.expected.get('gs04')!.workTimeMs) / 60_000;
    expect(unmerged).toBeCloseTo(305 / 60, 4);
    expect(byDay.get(tueW1)).not.toBeCloseTo(unmerged, 2);
    expect(byDay.get(gold.day('2026-01-05'))).toBeCloseTo(2.75, 4);
    expect(byDay.get(gold.day('2026-01-07'))).toBeCloseTo(6, 4);
    for (const zero of ['2026-01-09', '2026-01-10', '2026-01-11']) expect(byDay.get(gold.day(zero)), zero).toBe(0);
  });

  await test.step('3a. work-time groupBy=branch: one point per day and branch; main keeps the Tue W1 merge; the branches add up to the day', async () => {
    const rows = await repoGet<WorkTimeRow[]>(owner, gold.repoId, '/analytics/work-time', { ...gold.range, groupBy: 'branch' });
    const branches = Object.keys(t.costByBranch);
    expect(rows).toHaveLength(14 * branches.length);
    expect([...new Set(rows.map((r) => r.group))].sort()).toEqual([...branches].sort());
    const at = (day: string, group: string) => rows.find((r) => r.day.slice(0, 10) === day && r.group === group)!.workTimeMinutes;
    expect(at(tueW1, 'main')).toBeCloseTo(185 / 60, 4);
    expect(at(tueW1, 'feature/billing')).toBe(0);
    for (const [day, minutes] of Object.entries(t.workTimeMinutesByDay)) {
      const sum = branches.reduce((n, b) => n + at(gold.day(day), b), 0);
      expect(sum, day).toBeCloseTo(minutes, 4);
    }
  });

  await test.step('3b. one day (startDate == endDate, GS-01’s day) widens to the whole UTC day: GS-01 only', async () => {
    const day = gold.day('2026-01-05');
    const rows = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', { startDate: day, endDate: day });
    expect(rows.map((r) => gold.keyOf(r.sessionId))).toEqual(['gs01']);
  });

  const from = gold.day('2026-01-05');
  const to = gold.day('2026-01-18');

  await test.step('4. UI Cost by branch: the Tue W1 10:00 bar lists GS-04 $1.40 and GS-02 $0.12 on main; the legend lists the three branches', async () => {
    await openAnalytics(page, owner, gold.repoId, { from, to, view: 'cost', groupBy: 'branch' });
    // One bar per start hour of a priced session: GS-06b (no pricing) has none, GS-02 and GS-04 share one.
    const bars = page.locator('svg g[style*="cursor: pointer"]');
    await expect(bars).toHaveCount(8);
    for (const branch of Object.keys(t.costByBranch)) await expect(page.getByText(branch, { exact: true }).first()).toBeVisible();
    await bars.nth(1).hover();
    const tip = page.locator('div', { hasText: chartUsd(gold.expected.get('gs04')!.costUsd!) }).filter({
      hasText: chartUsd(gold.expected.get('gs02')!.costUsd!),
    }).last();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('main');
  });

  await test.step('4a. UI Cost, horizontal layout (toggle) grouped by branch: main $1.60, feature/billing $1.26, fix/windows $0.09', async () => {
    // Same view as step 4: the layout toggle switches it in place (a URL-only change of `al` does not remount it).
    await page.getByTestId('layout-toggle-horizontal').click();
    const rows = page.getByTestId('bar-row');
    await expect(rows).toHaveCount(3);
    const sorted = Object.entries(t.costByBranch).sort((a, b) => b[1] - a[1]);
    for (const [i, [branch, cost]] of sorted.entries()) {
      await expect(rows.nth(i)).toContainText(branch);
      await expect(rows.nth(i).getByTestId('bar-value')).toHaveText(chartUsd(cost));
    }
  });

  await test.step('5. UI Work Time: the Tue W1 10:00 bar lists GS-02 3:00 and GS-04 2:05; Work Time Distribution totals the merged 22m, not 24m', async () => {
    await openAnalytics(page, owner, gold.repoId, { from, to, view: 'work-time' });
    // Every root has work time, GS-02 and GS-04 share an hour: nine bars.
    const bars = page.locator('svg g[style*="cursor: pointer"]');
    await expect(bars).toHaveCount(9);
    await bars.nth(1).hover();
    const tip = page
      .locator('div', { hasText: chartDuration(gold.expected.get('gs02')!.workTimeMs) })
      .filter({ hasText: chartDuration(gold.expected.get('gs04')!.workTimeMs) })
      .last();
    await expect(tip).toBeVisible();
    await openReport(page, owner, gold.repoId, 'work-time', { startDate: from, endDate: to });
    const merged = Object.values(t.workTimeMinutesByDay).reduce((n, m) => n + m, 0);
    expect(Math.round(merged)).toBe(22);
    expect(Math.round(t.workTimeMs / 60_000)).toBe(24);
    await expect(kpiRowValues(page, 'Total Work Time').first()).toHaveText(`${Math.round(merged)}m`);
  });

  await test.step('6. UI range without sessions (2020-01-01..02): «no sessions»; the API returns an empty timeline', async () => {
    const rows = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', {
      startDate: '2020-01-01T00:00:00.000Z',
      endDate: '2020-01-02T23:59:59.999Z',
    });
    expect(rows).toEqual([]);
    await openAnalytics(page, owner, gold.repoId, { from: '2020-01-01', to: '2020-01-02', view: 'cost' });
    await expect(page.getByText('no sessions', { exact: true })).toBeVisible();
  });
});
