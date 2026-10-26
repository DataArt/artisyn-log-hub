// S-COST-03. The first model, an unknown model, public prices
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-COST-03; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-06a (sonnet-4-6 first, then opus-5: priced by the FIRST model) and GS-06b (the unpriced
// `claude-unreleased-9`: cost null, never 0). The Executive Summary step needs the whole of W2, so
// GS-07, GS-08 and GS-09 (the other W2 roots) are uploaded into the same repository. Numbers come from
// tests/golden/gs-06-multi-model/expected.json and tests/golden/repo-gold.expected.json (DD D3).
//
// The rate step is the only place in the suite that reads the price table itself: if a pricing
// migration changes a DD D3 rate, this step and the golden expected numbers break, nothing else.
//
// Code facts that differ from the design text:
//   - The list switches to «Plain list» (it groups by branch and folds the groups by default).
//   - The Executive Summary page shows the exclusion as «1 sessions excluded from cost» in its
//     «Data Source & Limitations» block, with the model in «no pricing for model claude-unreleased-9».
//
// Replaces:
//   - server/test/model-pricing.e2e-spec.ts (9, part)
//   - server/test/session-cost-consistency.e2e-spec.ts (model switch)
//   - client/src/viewer/__tests__/components/no-pricing-badge.test.tsx (19)
//   - server/src/logs/cost.sql.spec.ts (null against 0: ≈ 4)
import { test, expect } from '../fixtures';
import { infoTableValue, infoValue, int, openSession, summaryTile, usd4 } from '../helpers/session-view';
import { downloadPdfText, openReport, repoGet, reportSection, uploadRepoGold } from '../helpers/reports';

test.use({ timezoneId: 'UTC' });

/** DD D3, $ per Mtok; web search $ per request. */
const RATES: Record<string, [number, number, number, number, number]> = {
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
};
const WEB_SEARCH = 0.01;
const UNPRICED = 'claude-unreleased-9';

interface Pricing {
  priceIn: number;
  priceOut: number;
  priceCacheR: number;
  priceCacheW5m: number;
  priceCacheW1h: number;
  priceWebSearch: number;
}
interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  totalCost: number | null;
  costUnavailableReason: string | null;
}

test('@S-COST-03 the first model, an unknown model, public prices @mode-a @mode-c', async ({ api, db, users, page }) => {
  test.setTimeout(180_000);

  await test.step('1. GET /api/v1/model-pricing without a cookie: 200 and the DD D3 rates', async () => {
    const res = await api.get('/api/v1/model-pricing');
    expect(res.status()).toBe(200);
    const pricing = (await res.json()) as Record<string, Pricing>;
    for (const [model, [inp, out, read, w5m, w1h]] of Object.entries(RATES)) {
      expect(pricing[model], model).toMatchObject({
        priceIn: inp,
        priceOut: out,
        priceCacheR: read,
        priceCacheW5m: w5m,
        priceCacheW1h: w1h,
        priceWebSearch: WEB_SEARCH,
      });
    }
    expect(pricing[UNPRICED]).toBeUndefined();
  });

  const owner = await users.user('user', { label: 'cost03-owner' });
  const gold = await test.step('2. upload GS-06a and GS-06b (plus GS-07..GS-09, the rest of W2)', async () =>
    uploadRepoGold(api, db, owner, ['gs-06', 'gs-07', 'gs-08', 'gs-09']),
  );
  const A = gold.expected.get('gs06a')!;
  const B = gold.expected.get('gs06b')!;
  const wrongA = (A.wrongCostsUsd as { pricedByOpus5: number }).pricedByOpus5;

  const rows = await test.step(`3. GET .../sessions: GS-06a ${A.costUsd} (first model, not ${wrongA}); GS-06b null with unknown-model`, async () => {
    const list = await repoGet<SessionRow[]>(owner, gold.repoId, '/sessions');
    const row = (key: string) => list.find((r) => r.sessionId === gold.sid(key))!;
    expect(row('gs06a').totalCost).toBeCloseTo(A.costUsd!, 6);
    expect(row('gs06a').totalCost).not.toBeCloseTo(wrongA, 4);
    expect(row('gs06a').costUnavailableReason).toBeNull();
    expect(row('gs06b').totalCost).toBeNull();
    expect(row('gs06b').costUnavailableReason).toBe(B.costUnavailableReason);
    return list;
  });
  const prompt = (key: string) => rows.find((r) => r.sessionId === gold.sid(key))!.firstPrompt!.slice(0, 40);

  await test.step('4. UI GS-06a: list, header, Summary and Info show 0.1260; Model is the first model; tokens of both models summed', async () => {
    await openSession(page, owner, gold.repoId, gold.sid('gs06a'));
    await page.locator('select', { has: page.locator('option[value="plain"]') }).selectOption('plain');
    const text = usd4(A.costUsd!);
    await expect(page.getByTestId('session-item').filter({ hasText: prompt('gs06a') }).getByTestId('session-item-cost')).toContainText(text);
    await expect(page.locator('xpath=//p[normalize-space(text())="Cost"]/following-sibling::div').first()).toContainText(text);
    await expect(summaryTile(page, 'Cost')).toContainText(text);
    await page.getByTestId('tab-session-info').click();
    await expect(infoValue(page, 'Model')).toContainText(A.model);
    const t = A.tokens.own;
    const tokens = (label: string) =>
      page.locator('tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) }).first().locator('td').nth(1);
    await expect(tokens('Input')).toHaveText(int(t.input));
    await expect(tokens('Output')).toHaveText(int(t.output));
    await expect(tokens('Cache read')).toHaveText(int(t.cacheRead));
    await expect(tokens('Cache write')).toHaveText(int(t.cacheWrite5m + t.cacheWrite1h));
    await expect(infoTableValue(page, 'Calculated total')).toHaveText(text);
  });

  await test.step('5. UI GS-06b: «$???» in the list, header, Summary and Info, the hint names the model — and $0.0000 nowhere', async () => {
    await openSession(page, owner, gold.repoId, gold.sid('gs06b'));
    const item = page.getByTestId('session-item').filter({ hasText: prompt('gs06b') });
    await expect(item).toHaveCount(1);
    await expect(item).not.toContainText('$0.0000');
    const header = page.locator('xpath=//p[normalize-space(text())="Cost"]/following-sibling::div').first();
    await expect(header.getByTestId('no-pricing-badge')).toHaveText('$???');
    await expect(item.getByTestId('no-pricing-badge')).toHaveText('$???');
    await header.getByTestId('no-pricing-badge').hover();
    await expect(page.getByRole('tooltip').first()).toContainText(`No price for model ${UNPRICED} in Log Hub`);
    await expect(header).not.toContainText('$0.0000');
    await expect(summaryTile(page, 'Cost').getByTestId('no-pricing-badge')).toBeVisible();
    await expect(summaryTile(page, 'Cost')).not.toContainText('$0.0000');
    await page.getByTestId('tab-session-info').click();
    await expect(infoValue(page, 'Model')).toContainText(UNPRICED);
    await expect(infoValue(page, 'Model').getByTestId('no-pricing-badge')).toBeVisible();
    await expect(infoTableValue(page, 'Calculated total').getByTestId('no-pricing-badge')).toBeVisible();
    await expect(infoTableValue(page, 'Calculated total')).not.toContainText('$0.0000');
  });

  const w2 = { startDate: gold.day('2026-01-12'), endDate: gold.day('2026-01-18') };

  await test.step(`6. GET .../reports/executive-summary for W2: totalCost ${gold.totals.costByWeek.W2}, one excluded session, ${UNPRICED}`, async () => {
    const ex = await repoGet<{
      totalCost: number;
      totalSessions: number;
      excludedSessionCount: number;
      excludedModels: string[];
      topSessions: Array<{ model: string | null; cost: number; costUnavailableReason: string | null }>;
    }>(owner, gold.repoId, '/reports/executive-summary', {
      startDate: `${w2.startDate}T00:00:00.000Z`,
      endDate: `${w2.endDate}T23:59:59.999Z`,
    });
    expect(ex.totalSessions).toBe(gold.totals.sessionsByWeek.W2);
    expect(ex.totalCost).toBeCloseTo(gold.totals.costByWeek.W2, 6);
    expect(ex.excludedSessionCount).toBe(1);
    expect(ex.excludedModels).toEqual([UNPRICED]);
    const unpriced = ex.topSessions.find((s) => s.model === UNPRICED);
    expect(unpriced?.costUnavailableReason).toBe('unknown-model');
  });

  await test.step('7. Reports → Executive Summary for W2: total, the GS-06b row badged, the exclusion note on screen and in the PDF', async () => {
    await openReport(page, owner, gold.repoId, 'executive-summary', w2);
    await expect(page.getByText(usd4(gold.totals.costByWeek.W2)).first()).toBeVisible();
    const top = reportSection(page, 'Top 5 Most Expensive Sessions');
    const row = top.locator('tbody tr', { hasText: UNPRICED });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('no-pricing-badge')).toBeVisible();
    await expect(page.getByText('1 sessions excluded from cost').first()).toBeVisible();
    await expect(page.getByText(`no pricing for model ${UNPRICED}`).first()).toBeVisible();
    const pdf = await downloadPdfText(page);
    expect(pdf.filename).toBe(`executive-summary_${w2.startDate}_${w2.endDate}.pdf`);
    expect(pdf.text).toMatch(/1\s+sessions\s+excluded\s+from\s+cost/);
    expect(pdf.text).toMatch(/no\s+pricing/);
    expect(pdf.text).toContain(UNPRICED);
  });
});
