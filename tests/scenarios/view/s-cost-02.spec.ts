// S-COST-02. Cache 5m and 1h, fast mode, web search: the price by the formula
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-COST-02; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-04 (opus-5, four prompts): P1 writes 40 000 tokens to the 5m cache and 60 000 to the 1h
// cache, P2 is a fast turn with two web searches and a 1h write, P3 only reads the cache, P4 has no
// cache traffic at all. Rates of DD D3 (opus-5: 5 / 25 / 0.50 / 6.25 / 10.00 per Mtok, $0.01 per web
// search, fast ×2 on input and output). Every literal comes from
// tests/golden/gs-04-cache-5m-1h/expected.json; the tooltip rows are recomputed here from its token
// counts and those rates, so a flat cache-write rate or a missing fast surcharge shows up as a
// different row, not just a different total.
//
// Code facts that differ from the design text:
//   - The turn cost tooltip prices Token In / Token Out at the standard rate and adds one
//     «Fast mode (2×)» surcharge row (the design's «input with fast 0.0500, output with fast 0.0500»):
//     P2 reads Token In $0.0250, Token Out $0.0250, Fast mode $0.0500.
//   - Info shows the fast share as «Input (fast)» / «Output (fast)» rows under the Input/Output rows.
//   - Call Tree lists the cache writes per turn as «Cache: write (5m)» / «Cache: write (1h)» with
//     their tokens and cost share; a dollar figure is printed only on prompt rows and «Session Total».
//
// Replaces:
//   - server/test/cache-write-ttl-pricing.e2e-spec.ts (13)
//   - client/src/viewer/__tests__/components/CallTreeView.test.tsx (TTL block: 7)
//   - client/src/viewer/__tests__/components/cost-breakdown-tooltip.test.tsx (8)
//   - client/src/viewer/__tests__/unit/log-parser.test.ts (cache-write TTL accumulation: ≈ 12)
//   - server/src/logs/claude-extractor.spec.ts (TTL / fast / web search: ≈ 8)
//   - tests/e2e/usage-analytics.spec.ts (TTL part)
import { test, expect } from '../fixtures';
import { type GoldenTokens } from '../helpers/golden';
import { infoTableValue, int, logTurns, openSession, pct1, turnMetric, usd4 } from '../helpers/session-view';
import { repoGet, uploadRepoGold } from '../helpers/reports';

/** DD D3 rates of claude-opus-5, $ per Mtok; web search $ per request. */
const OPUS5 = { in: 5, out: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10, webSearch: 0.01, fast: 2 };
const M = 1_000_000;

interface PerPrompt {
  tokens: GoldenTokens;
  costUsd: number;
  cacheRatio: number | null;
}

test('@S-COST-02 cache 5m and 1h, fast mode, web search: the price by the formula @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await users.user('user', { label: 'cost02-owner' });
  const gold = await test.step('1. upload GS-04', async () => uploadRepoGold(api, db, owner, ['gs-04']));
  const E = gold.expected.get('gs04')!;
  const P = E.perPrompt as PerPrompt[];
  const wrong = E.wrongCostsUsd as { oneHourAtFiveMinuteRate: number; noFastSurcharge: number };
  const tok = E.tokens.own;
  const sid = gold.sid('gs04');

  await test.step(`2. GET .../sessions: totalCost ${E.costUsd}, not ${wrong.oneHourAtFiveMinuteRate} (1h at the 5m rate) or ${wrong.noFastSurcharge} (no fast surcharge)`, async () => {
    const [row] = await repoGet<Array<{ totalCost: number }>>(owner, gold.repoId, '/sessions');
    expect(row.totalCost).toBeCloseTo(E.costUsd!, 6);
    expect(row.totalCost).not.toBeCloseTo(wrong.oneHourAtFiveMinuteRate, 4);
    expect(row.totalCost).not.toBeCloseTo(wrong.noFastSurcharge, 4);
    expect(P.reduce((n, p) => n + p.costUsd, 0)).toBeCloseTo(E.costUsd!, 6);
  });

  await test.step('3. analytics/tokens for the session’s day and the cache-read-ratio report keep the 5m and 1h buckets apart', async () => {
    const day = gold.at(E.start).toISOString().slice(0, 10);
    // The usage analytics routes take the bounds as given (only timeline/work-time widen equal dates).
    const { totals } = await repoGet<{ totals: { cacheCreation: number; cacheWrite5m: number; cacheWrite1h: number } }>(
      owner,
      gold.repoId,
      '/analytics/tokens',
      { startDate: `${day}T00:00:00.000Z`, endDate: `${day}T23:59:59.999Z` },
    );
    expect(totals).toMatchObject({
      cacheWrite5m: tok.cacheWrite5m,
      cacheWrite1h: tok.cacheWrite1h,
      cacheCreation: tok.cacheWrite5m + tok.cacheWrite1h,
    });
    const rep = await repoGet<{ root: { cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number } }>(
      owner,
      gold.repoId,
      '/reports/cache-read-ratio',
      gold.range,
    );
    expect(rep.root).toMatchObject({
      cacheWrite5mTokens: tok.cacheWrite5m,
      cacheWrite1hTokens: tok.cacheWrite1h,
      cacheWriteTokens: tok.cacheWrite5m + tok.cacheWrite1h,
    });
  });

  await test.step('4. Logs: per-turn cost 0.9500 / 0.3700 / 0.0775 / 0.0025 and cache ratio 0.0% / 83.3% / 100.0% / n/a', async () => {
    await openSession(page, owner, gold.repoId, sid, { tab: 'logs' });
    const turns = logTurns(page);
    await expect(turns).toHaveCount(P.length);
    for (const [i, p] of P.entries()) {
      await expect(turnMetric(turns.nth(i), 'Cost'), `P${i + 1} cost`).toHaveText(usd4(p.costUsd));
      await expect(turnMetric(turns.nth(i), 'cache_ratio'), `P${i + 1} cache ratio`).toHaveText(
        p.cacheRatio === null ? 'n/a' : pct1(p.cacheRatio),
      );
    }
  });

  const tooltip = async (i: number) => {
    await page.mouse.move(0, 0);
    await logTurns(page).nth(i).getByText('Cost', { exact: true }).hover();
    const tip = page.locator('table', { hasText: 'Calculated approx. total' });
    await expect(tip).toBeVisible();
    return (label: string) => tip.locator('tr', { hasText: label }).locator('td').last();
  };

  await test.step('4a. P1 tooltip: two cache-write rows, 5m 40 000 × 6.25 = 0.2500 and 1h 60 000 × 10 = 0.6000', async () => {
    const t = P[0].tokens;
    const row = await tooltip(0);
    await expect(row('Cache Write 5m')).toHaveText(usd4((t.cacheWrite5m * OPUS5.write5m) / M));
    await expect(row('Cache Write 1h')).toHaveText(usd4((t.cacheWrite1h * OPUS5.write1h) / M));
    await expect(row('Cache Write 5m')).toHaveText('$0.2500');
    await expect(row('Cache Write 1h')).toHaveText('$0.6000');
    // A flat 5m rate would have priced both buckets at 0.6250 together, not 0.8500.
    expect((t.cacheWrite5m + t.cacheWrite1h) * OPUS5.write5m / M).toBeCloseTo(0.625, 6);
    await expect(row('Calculated approx. total')).toHaveText(usd4(P[0].costUsd));
  });

  await test.step('4b. P2 tooltip: input/output at the standard rate plus the fast surcharge, 2 web searches 0.0200, 1h write 0.2000', async () => {
    const t = P[1].tokens;
    const row = await tooltip(1);
    await expect(row('Token In')).toHaveText(usd4((t.input * OPUS5.in) / M));
    await expect(row('Token Out')).toHaveText(usd4((t.output * OPUS5.out) / M));
    const surcharge = ((t.inputFast * OPUS5.in + t.outputFast * OPUS5.out) / M) * (OPUS5.fast - 1);
    await expect(row('Fast mode (2×)')).toHaveText(usd4(surcharge));
    await expect(row('Fast mode (2×)')).toHaveText('$0.0500');
    await expect(row('Web Search')).toHaveText(usd4(t.webSearch * OPUS5.webSearch));
    await expect(row('Web Search')).toHaveText('$0.0200');
    await expect(row('Cache Write 1h')).toHaveText('$0.2000');
    await expect(row('Calculated approx. total')).toHaveText(usd4(P[1].costUsd));
    await page.mouse.move(0, 0);
  });

  await test.step('5. Info Tokens & Cost: 5m TTL and 1h TTL rows at their own rates, web search, the fast rows, total 1.4000', async () => {
    await page.getByTestId('tab-session-info').click();
    const cells = (label: string) => page.locator('tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) }).first().locator('td');
    await expect(cells('↳ 5m TTL').nth(1)).toHaveText(int(tok.cacheWrite5m));
    await expect(cells('↳ 5m TTL').nth(3)).toHaveText(usd4((tok.cacheWrite5m * OPUS5.write5m) / M));
    await expect(cells('↳ 1h TTL').nth(1)).toHaveText(int(tok.cacheWrite1h));
    await expect(cells('↳ 1h TTL').nth(3)).toHaveText(usd4((tok.cacheWrite1h * OPUS5.write1h) / M));
    await expect(cells('Web search').nth(1)).toHaveText(`${tok.webSearch} req`);
    await expect(cells('Web search').nth(3)).toHaveText(usd4(tok.webSearch * OPUS5.webSearch));
    await expect(cells('Input \\(fast\\)').nth(1)).toHaveText(int(tok.inputFast));
    await expect(cells('Output \\(fast\\)').nth(1)).toHaveText(int(tok.outputFast));
    await expect(infoTableValue(page, 'Calculated total')).toHaveText(usd4(E.costUsd!));
  });

  await test.step('6. Statistics: 5-minute TTL 40.0K and 1-hour TTL 80.0K', async () => {
    await page.getByTestId('tab-session-usage').click();
    const tab = page.getByTestId('session-usage-tab');
    await expect(tab.locator('tr', { hasText: '5-minute TTL' })).toContainText(`${(tok.cacheWrite5m / 1000).toFixed(1)}K`);
    await expect(tab.locator('tr', { hasText: '1-hour TTL' })).toContainText(`${(tok.cacheWrite1h / 1000).toFixed(1)}K`);
  });

  await test.step('7. Charts → Call Tree: P1 has separate «Cache: write (5m)» and «Cache: write (1h)» rows; «Session Total» 1.4000', async () => {
    await page.getByTestId('tab-session-charts').click();
    await page.getByTestId('tab-chart-call-tree').click();
    const t = P[0].tokens;
    const cells = (label: string) =>
      page.locator('tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) }).first().locator('td');
    await expect(cells('Cache: write \\(5m\\)').nth(1)).toHaveText(`${(t.cacheWrite5m / 1000).toFixed(1)}K`);
    await expect(cells('Cache: write \\(1h\\)').nth(1)).toHaveText(`${(t.cacheWrite1h / 1000).toFixed(1)}K`);
    await expect(cells('Session Total').nth(2)).toHaveText(usd4(E.costUsd!));
  });
});
