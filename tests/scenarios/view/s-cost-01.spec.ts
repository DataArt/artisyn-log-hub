// S-COST-01. One session, one cost in every place
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-COST-01; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-01, GS-02 (a tree of three sub-agents), GS-03 and GS-04 in one repository, uploaded through
// POST /api/v2/logs (DD SC3). Every cost is the `costUsd` of the fixture's expected.json (DD D3); the
// server SQL (session list, timeline, active sessions, Executive Summary) and the client formula
// (session header, Summary, Info — computed from the transcript) must print the same number.
//
// Steps 7–11 (AC4a/AC4d of task 2026-10-26-pricing-fetch-tiered): a model seeded with a long-context
// tier and two prompt-session uploads whose two calls fall on either side of the tier threshold. The
// tier is chosen per call (the 110k-token call is tiered, the 90k one is not); an override that moves
// the threshold re-prices only the session whose price date is on or after the override (the sweeper
// recomputes `session_costs` in the background, so the list cost is polled).
//
// Steps 12–13 (Chunk 16 of the same task — Log Hub's price is the source of truth): utility calls
// (`otel_api_calls` rows no transcript records) are priced per call with the same tier rule, so a
// 110k-prompt utility call is tiered and a 90k one is not; and one utility call on a model with no
// price in Log Hub makes the whole session cost `$???` (never a partial sum, never the OTEL
// figure), with a hint naming that model.
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
import type { Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect, type ScenarioUser } from '../fixtures';
import { infoTableValue, logTurns, openSession, summaryTile, turnMetric, usd4 } from '../helpers/session-view';
import { repoGet, uploadRepoGold } from '../helpers/reports';
import { insertRow, sessionRowId } from '../helpers/db-seed';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';

const FIXTURES = ['gs-01', 'gs-02', 'gs-03', 'gs-04'];
const KEYS = ['gs01', 'gs02', 'gs03', 'gs04'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AC4a/AC4d (task 2026-10-26-pricing-fetch-tiered, impl-plan «Test coverage plan»): Haiku 5.5
 * base rates and one long-context tier above 100000 prompt tokens, USD/MTok.
 */
const TIER_BASE = { priceIn: 0.1, priceOut: 0.5, priceCacheR: 0.01, priceCacheW5m: 0.125, priceCacheW1h: 0.2 };
const TIER_RATES = { priceIn: 0.5, priceOut: 2.5, priceCacheR: 0.05, priceCacheW5m: 0.625, priceCacheW1h: 1 };
/**
 * Call 1: 60000 in + 50000 cache read = a 110000-token prompt, over the tier → 0.0325.
 * Call 2: 90000 in, under it → 0.0090. Session 0.0415. With the threshold at 120000 call 1
 * falls back to base rates (0.0065) and the session costs 0.0155.
 */
const TIERED_USAGES = [
  { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 50_000 },
  { input_tokens: 90_000, output_tokens: 0 },
];
const TIERED_TURN_COSTS = [0.0325, 0.009];
const TIERED_COST = 0.0415;
const OVERRIDDEN_COST = 0.0155;
/**
 * Chunk 16: the same two calls as utility calls (`otel_api_calls`, no request id, a
 * non-transcript `query_source`) on the 3-day-old session: 0.0325 (tiered) + 0.0090 (base).
 * The session then costs its own 0.0415 plus 0.0415 of utility calls.
 */
const UTILITY_CALLS = [
  { input_tokens: 60_000, cache_read_tokens: 50_000 },
  { input_tokens: 90_000 },
];
const UTILITY_COST = 0.0415;

/** `YYYY-MM-DD` (UTC) `days` before now. */
function utcDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** The session list cell and the header «Cost» of the open session pane. */
async function expectListAndHeaderCost(page: Page, prompt: string, text: string): Promise<void> {
  await page.locator('select', { has: page.locator('option[value="plain"]') }).selectOption('plain');
  const item = page.getByTestId('session-item').filter({ hasText: prompt });
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId('session-item-cost')).toContainText(text);
  await expect(page.locator('xpath=//p[normalize-space(text())="Cost"]/following-sibling::div').first()).toContainText(text);
}

/** Opens a session freshly (a reload drops the SPA's cached pricing and session list). */
async function openFresh(page: Page, user: ScenarioUser, repoId: number, sessionId: string, tab?: string): Promise<void> {
  await openSession(page, user, repoId, sessionId, tab ? { tab } : {});
  await page.reload();
}

interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  totalCost: number | null;
  costUnavailableReason?: string | null;
  costBreakdown?: { utilityCost: number; calculatedCost: number | null; unpricedModels?: string[] };
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
  test.setTimeout(300_000);
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

  // AC4a / AC4d — prompt-length tiers are chosen per call, at the session's price date.
  const runId = randomBytes(4).toString('hex');
  // The `r` keeps the id from ending in `-` + 8 digits: an all-digit runId would read as a
  // `-YYYYMMDD` snapshot suffix, which every pricing lookup strips (`scn-tiered`, unpriced).
  const tieredModel = `scn-tiered-r${runId}`;
  const tieredRepoUrl = `https://git.arrakis.test/scn/${runId}/tiered`;
  const tier = (aboveTokens: number) => [{ aboveTokens, ...TIER_RATES }];
  const now = Date.now();
  const startOfUtcDay = Date.parse(`${utcDay(0)}T00:00:00.000Z`);
  const tiered: Record<'old' | 'today', PromptSession> = {
    old: {
      sessionId: `cost01-tier-old-${runId}`,
      prompt: `tiered three days ago ${runId}`,
      repoUrl: tieredRepoUrl,
      at: new Date(now - 3 * DAY_MS),
      turns: 2,
      model: tieredModel,
      usages: TIERED_USAGES,
    },
    today: {
      sessionId: `cost01-tier-today-${runId}`,
      prompt: `tiered today ${runId}`,
      repoUrl: tieredRepoUrl,
      // Today in UTC (the price date), even right after midnight.
      at: new Date(Math.max(now - 10 * 60_000, startOfUtcDay + 1_000)),
      turns: 2,
      model: tieredModel,
      usages: TIERED_USAGES,
    },
  };

  const tieredRepoId = await test.step(`7. seed ${tieredModel} (anthropic, 30 days back, a tier above 100000); upload a 3-day-old and a today session of 110k + 90k calls`, async () => {
    await insertRow(db, 'model_pricing', {
      model_id: tieredModel,
      price_in: TIER_BASE.priceIn,
      price_out: TIER_BASE.priceOut,
      price_cache_r: TIER_BASE.priceCacheR,
      price_cache_w: TIER_BASE.priceCacheW5m,
      price_cache_w_5m: TIER_BASE.priceCacheW5m,
      price_cache_w_1h: TIER_BASE.priceCacheW1h,
      price_web_search: 0.01,
      effective_from: utcDay(30),
      source: 'anthropic',
      tiers: tier(100_000),
    });
    const key = await createApiKey(owner.api);
    for (const s of Object.values(tiered)) await uploadPromptSession(api, key.key, s, { db, userId: owner.id });
    return ownRepoId(owner.api, tieredRepoUrl);
  });

  const listCost = async (sessionId: string) => {
    const list = await repoGet<SessionRow[]>(owner, tieredRepoId, '/sessions');
    return list.find((r) => r.sessionId === sessionId)?.totalCost ?? null;
  };

  for (const which of ['old', 'today'] as const) {
    const s = tiered[which];
    await test.step(`8. ${which} session: ${usd4(TIERED_COST)} in the list, header, Summary and Info; per-turn ${TIERED_TURN_COSTS.map(usd4).join(' / ')}`, async () => {
      expect(await listCost(s.sessionId)).toBeCloseTo(TIERED_COST, 6);
      const text = usd4(TIERED_COST);
      await openFresh(page, owner, tieredRepoId, s.sessionId);
      await expectListAndHeaderCost(page, s.prompt, text);
      await expect(summaryTile(page, 'Cost')).toContainText(text);
      await page.getByTestId('tab-session-info').click();
      await expect(infoTableValue(page, 'Calculated total')).toHaveText(text);
      await openFresh(page, owner, tieredRepoId, s.sessionId, 'logs');
      const turns = logTurns(page);
      await expect(turns).toHaveCount(TIERED_TURN_COSTS.length);
      for (const [i, c] of TIERED_TURN_COSTS.entries()) {
        await expect(turnMetric(turns.nth(i), 'Cost'), `turn ${i + 1} cost`).toHaveText(usd4(c));
      }
    });
  }

  const admin = await users.user('admin', { label: 'cost01-admin' });

  await test.step(`9. ADMIN PUT /override: same rates, tier above 120000 → the today session's list cost becomes ${usd4(OVERRIDDEN_COST)}`, async () => {
    const res = await admin.api.put('/api/v1/admin/model-pricing/override', {
      data: { modelId: tieredModel, ...TIER_BASE, priceWebSearch: 0.01, tiers: tier(120_000) },
    });
    expect(res.status(), await res.text()).toBe(200);
    await expect.poll(() => listCost(tiered.today.sessionId), { timeout: 15_000 }).toBeCloseTo(OVERRIDDEN_COST, 6);
  });

  await test.step(`10. UI: the today session's list cell and header show ${usd4(OVERRIDDEN_COST)}`, async () => {
    await openFresh(page, owner, tieredRepoId, tiered.today.sessionId);
    await expectListAndHeaderCost(page, tiered.today.prompt, usd4(OVERRIDDEN_COST));
  });

  await test.step(`11. the 3-day-old session still costs ${usd4(TIERED_COST)} (the override starts today), in the API and the UI`, async () => {
    expect(await listCost(tiered.old.sessionId)).toBeCloseTo(TIERED_COST, 6);
    await openFresh(page, owner, tieredRepoId, tiered.old.sessionId);
    await expectListAndHeaderCost(page, tiered.old.prompt, usd4(TIERED_COST));
  });

  const listRow = async (sessionId: string) => {
    const list = await repoGet<SessionRow[]>(owner, tieredRepoId, '/sessions');
    return list.find((r) => r.sessionId === sessionId)!;
  };

  await test.step(`12. two utility calls (110k and 90k prompts) on the 3-day-old session: utility ${usd4(UTILITY_COST)} (tiered per call), session ${usd4(TIERED_COST + UTILITY_COST)} in the API and the UI`, async () => {
    const sid = await sessionRowId(db, tiered.old.sessionId);
    for (const [i, c] of UTILITY_CALLS.entries()) {
      await insertRow(db, 'otel_api_calls', {
        session_id: sid,
        call_key: `cost01-utility-${runId}-${i}`,
        query_source: 'prompt_suggestion',
        model: tieredModel,
        ...c,
      });
    }
    const row = await listRow(tiered.old.sessionId);
    expect(row.costBreakdown?.utilityCost).toBeCloseTo(UTILITY_COST, 6);
    expect(row.totalCost).toBeCloseTo(TIERED_COST + UTILITY_COST, 6);
    await openFresh(page, owner, tieredRepoId, tiered.old.sessionId);
    await expectListAndHeaderCost(page, tiered.old.prompt, usd4(TIERED_COST + UTILITY_COST));
  });

  const unpricedModel = `scn-unpriced-r${runId}`;
  await test.step(`13. a utility call on ${unpricedModel} (no price in Log Hub) on the today session: totalCost null, unknown-model; «$???» with the hint in the list and the header; Active Sessions reports the same`, async () => {
    await insertRow(db, 'otel_api_calls', {
      session_id: await sessionRowId(db, tiered.today.sessionId),
      call_key: `cost01-unpriced-${runId}`,
      query_source: 'prompt_suggestion',
      model: unpricedModel,
      input_tokens: 1_000,
    });
    const row = await listRow(tiered.today.sessionId);
    expect(row.totalCost).toBeNull();
    expect(row.costUnavailableReason).toBe('unknown-model');
    expect(row.costBreakdown?.calculatedCost).toBeNull();
    expect(row.costBreakdown?.unpricedModels).toEqual([unpricedModel]);
    // The Active Sessions panel reports the same complete tree cost as the list.
    const active = await repoGet<{
      sessions: { sessionId: string; totalCost: number | null; costUnavailableReason?: string | null; unpricedModels?: string[] }[];
    }>(owner, tieredRepoId, '/analytics/active-sessions', {
      startDate: new Date(Date.now() - 7 * DAY_MS).toISOString(),
      endDate: new Date(Date.now() + DAY_MS).toISOString(),
    });
    const activeRow = active.sessions.find((s) => s.sessionId === tiered.today.sessionId);
    expect(activeRow?.totalCost).toBeNull();
    expect(activeRow?.costUnavailableReason).toBe('unknown-model');
    expect(activeRow?.unpricedModels).toEqual([unpricedModel]);
    await openFresh(page, owner, tieredRepoId, tiered.today.sessionId);
    await page.locator('select', { has: page.locator('option[value="plain"]') }).selectOption('plain');
    const item = page.getByTestId('session-item').filter({ hasText: tiered.today.prompt });
    await expect(item.getByTestId('no-pricing-badge')).toHaveText('$???');
    await expect(item).not.toContainText(usd4(OVERRIDDEN_COST));
    const header = page.locator('xpath=//p[normalize-space(text())="Cost"]/following-sibling::div').first();
    const badge = header.getByTestId('no-pricing-badge');
    await expect(badge).toHaveText('$???');
    await badge.hover();
    const hint = page.getByRole('tooltip').first();
    await expect(hint).toContainText(`No price for model ${unpricedModel} in Log Hub`);
    await expect(hint).toContainText('Fetch Anthropic prices now');
  });
});
