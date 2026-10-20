// S-COST-01. One session, one cost in every place
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-COST-01; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-01, GS-02 (a tree of three sub-agents), GS-03 and GS-04 in one repository, uploaded through
// POST /api/v2/logs (DD SC3). Every cost is the `costUsd` of the fixture's expected.json (DD D3); the
// server SQL (session list, timeline, active sessions, Executive Summary) and the client formula
// (session header, Summary, Info — computed from the transcript) must print the same number.
//
// Code facts that differ from the design text:
//   - The list groups sessions by branch and folds the groups; the scenario switches it to «Plain list».
//   - Info's total row is «Calculated total» («Calculated approx. total» is the turn cost tooltip).
//   - The header shows the tree cost with a «+sub-agents» marker when sub-agents are part of it.
//   - KNOWN DEVIATION (task Notes, Chunk 18): Charts → Call Tree «Session Total» prices only the main
//     thread's tokens. For the three sessions without sub-agents it equals the tree cost; for GS-02 it
//     prints 0.0390 (the root's own cost) instead of 0.1173. The step pins the current value.
//
// Replaces:
//   - tests/e2e/session-cost-consistency.spec.ts (5)
//   - server/test/session-cost-consistency.e2e-spec.ts (3 synthetic of 5)
//   - server/src/logs/cost.sql.spec.ts (14, except the three kept cases: 1h, fast, null)
//   - client/src/viewer/__tests__/unit/format.test.ts (computeCost: 13)
//   - client/src/viewer/__tests__/components/CallTreeView.test.tsx (cost block: 4+3)
//   - client/src/viewer/__tests__/components/cost-breakdown-tooltip.test.tsx (8)
//   - client/src/viewer/__tests__/components/session-info-tab.test.tsx (cost part)
//   - tests/e2e/helpers/pricing.ts (the e2e twin of the formula)
import { test, expect } from '../fixtures';
import { infoTableValue, openSession, summaryTile, usd4 } from '../helpers/session-view';
import { repoGet, uploadRepoGold } from '../helpers/reports';

const FIXTURES = ['gs-01', 'gs-02', 'gs-03', 'gs-04'];
const KEYS = ['gs01', 'gs02', 'gs03', 'gs04'];

interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  totalCost: number | null;
}
interface TimelineRow {
  sessionId: string;
  totalCost: number | null;
}
interface ExecutiveSummary {
  totalCost: number;
  totalSessions: number;
  topSessions: Array<{ startTime: string; cost: number }>;
}

test('@S-COST-01 one session, one cost in every place @mode-a @mode-c', async ({ api, db, users, page }) => {
  test.setTimeout(180_000);
  const owner = await users.user('user', { label: 'cost01-owner' });

  const gold = await test.step('1. upload GS-01, GS-02, GS-03 and GS-04 into one repository', async () =>
    uploadRepoGold(api, db, owner, FIXTURES),
  );
  const cost = (key: string) => gold.expected.get(key)!.costUsd!;
  const sum = KEYS.reduce((n, k) => n + cost(k), 0);

  const rows = await test.step('2. GET .../sessions: totalCost of every row is its expected.json cost', async () => {
    const list = await repoGet<SessionRow[]>(owner, gold.repoId, '/sessions');
    expect(list.map((r) => gold.keyOf(r.sessionId)).sort()).toEqual(KEYS);
    for (const r of list) expect(r.totalCost, gold.keyOf(r.sessionId)).toBeCloseTo(cost(gold.keyOf(r.sessionId)), 6);
    return list;
  });

  await test.step('3. GET .../analytics/timeline over the range: the same totalCost per session', async () => {
    const timeline = await repoGet<TimelineRow[]>(owner, gold.repoId, '/analytics/timeline', gold.range);
    expect(timeline).toHaveLength(KEYS.length);
    for (const r of timeline) expect(r.totalCost, gold.keyOf(r.sessionId)).toBeCloseTo(cost(gold.keyOf(r.sessionId)), 6);
  });

  await test.step('4. GET .../analytics/active-sessions: the same totalCost per session', async () => {
    const { sessions } = await repoGet<{ sessions: TimelineRow[] }>(owner, gold.repoId, '/analytics/active-sessions', gold.range);
    expect(sessions).toHaveLength(KEYS.length);
    for (const r of sessions) expect(r.totalCost, gold.keyOf(r.sessionId)).toBeCloseTo(cost(gold.keyOf(r.sessionId)), 6);
  });

  await test.step(`5. GET .../reports/executive-summary: totalCost ${sum.toFixed(4)} = the four costs; topSessions[].cost the same`, async () => {
    const ex = await repoGet<ExecutiveSummary>(owner, gold.repoId, '/reports/executive-summary', gold.range);
    expect(ex.totalSessions).toBe(KEYS.length);
    expect(ex.totalCost).toBeCloseTo(sum, 6);
    expect(ex.totalCost).toBeCloseTo(2.6488, 6);
    const byStart = new Map(KEYS.map((k) => [gold.at(gold.expected.get(k)!.start).getTime(), k]));
    expect(ex.topSessions).toHaveLength(KEYS.length);
    for (const s of ex.topSessions) {
      const key = byStart.get(Date.parse(s.startTime));
      expect(key, `top session starting ${s.startTime}`).toBeDefined();
      expect(s.cost, key).toBeCloseTo(cost(key!), 6);
    }
  });

  for (const key of KEYS) {
    await test.step(`6. UI ${key}: list cell, header, Summary Cost, Info «Calculated total» print ${usd4(cost(key))}; Call Tree «Session Total»`, async () => {
      const sid = gold.sid(key);
      const prompt = rows.find((r) => r.sessionId === sid)!.firstPrompt!;
      await openSession(page, owner, gold.repoId, sid);
      // The list groups by branch and folds the groups; a plain list shows every row.
      await page.locator('select', { has: page.locator('option[value="plain"]') }).selectOption('plain');
      const text = usd4(cost(key));
      const item = page.getByTestId('session-item').filter({ hasText: prompt.slice(0, 40) });
      await expect(item).toHaveCount(1);
      await expect(item.getByTestId('session-item-cost')).toContainText(text);
      await expect(page.locator('xpath=//p[normalize-space(text())="Cost"]/following-sibling::div').first()).toContainText(text);
      await expect(summaryTile(page, 'Cost')).toContainText(text);
      await page.getByTestId('tab-session-info').click();
      await expect(infoTableValue(page, 'Calculated total')).toHaveText(text);
      await page.getByTestId('tab-session-charts').click();
      await page.getByTestId('tab-chart-call-tree').click();
      // KNOWN DEVIATION (task Notes, Chunk 18): «Session Total» is the main thread only, so for GS-02
      // it prints the root's own cost, not the tree cost every other surface prints.
      const own = usd4(gold.expected.get(key)!.ownCostUsd!);
      const total = page.locator('tr').filter({ has: page.locator('td:first-child', { hasText: /^\s*Session Total\s*$/ }) });
      await expect(total.locator('td').nth(2)).toHaveText(own);
    });
  }
});
