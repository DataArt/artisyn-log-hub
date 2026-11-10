// S-BUDG-01. A personal repository budget end to end: Settings › Budgets, the Spend tab, the
// threshold job with its bell / banner / tray, Analytics › Budget burn, Reports › Budget, the help
// page and the event log (task 2026-11-05 budgets-threshold-alerts, impl-plan «Test coverage plan»;
// mode A — auth `none` has no SMTP, so every crossing logs `email skipped`).
//
// Data: two prompt sessions uploaded through POST /api/v2/logs (DD SC3) a few minutes ago, so both
// fall into the current UTC day, week and month:
//   - session A: 200 000 output tokens of claude-sonnet-4-6 — a hook cost of about $3;
//   - session B: a tiny transcript plus an OTEL chunk of two api_request records whose `cost_usd`
//     sum ($4) is far above the hook cost — the budget-only rule (DD-5) takes the OTEL figure.
// Exact amounts are read back from `GET R/spend` and every other surface is compared with it, so
// the scenario does not depend on the price table.
//
// The browser runs in UTC and every budget uses `UTC`, so the Spend tab, the burn view and the
// report all cover the same calendar month as the API calls.
import type { Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect, type ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  amountForPercent,
  currentUtcMonthDays,
  getSpend,
  listBudgetEvents,
  listBudgets,
  recentAt,
  updateBudget,
  usd2,
  waitForUnreadNotices,
  type SpendView,
} from '../helpers/budgets';
import { uploadOtelChunk, waitForOtelProjected } from '../helpers/otel';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { downloadPdfText, openAnalytics, openReport, repoGet } from '../helpers/reports';
import { skipNewUserNudge } from '../helpers/teams';
import { apiRequestLine } from '../fixtures/otel/otel-lines';

test.use({ timezoneId: 'UTC' });

const OTEL_COST_USD = 2; // per call, two calls

interface BudgetBurnView {
  spendMicros: number;
  points: { key: string; cumulativeMicros: number }[];
}

interface BudgetReport {
  budgets: {
    budget: { id: number; period: string };
    periods: { isCurrent: boolean; spendMicros: number; percentUsed: number; forecast: { forecastMicros: number } | null }[];
  }[];
}

/**
 * Signs `user` in and opens a repository page with `query` in a fresh document: a hash-only
 * `goto` would keep the SPA (and its cached spend queries) alive, so the page leaves for
 * about:blank first.
 */
async function openRepo(page: Page, user: ScenarioUser, repoId: number, query: string): Promise<void> {
  await skipNewUserNudge(page.context());
  await user.signIn(page);
  await page.goto('about:blank');
  await page.goto(`/#/repos/${repoId}?${query}`);
}

test('@S-BUDG-01 a repository budget: settings, spend, threshold notices, burn, report, help, event log @mode-a', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(300_000);
  const runId = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${runId}/budget`;
  const owner = await users.user('user', { label: 'budg01-owner' });
  const key = await createApiKey(owner.api);
  const sidA = `budg01-a-${runId}`;
  const sidB = `budg01-b-${runId}`;

  const repoId = await test.step('setup: session A (≈ $3 of output tokens) creates the repository', async () => {
    await uploadPromptSession(
      api,
      key.key,
      {
        sessionId: sidA,
        prompt: `budget session A ${runId}`,
        repoUrl,
        at: recentAt(20),
        usages: [{ input_tokens: 10, output_tokens: 200_000 }],
      },
      { db, userId: owner.id },
    );
    return ownRepoId(owner.api, repoUrl);
  });
  const scope = { repoId };

  await test.step('1. Settings › Budgets: «+ Add budget», a $1,000 monthly budget in UTC; the event log has «Created»', async () => {
    await openRepo(page, owner, repoId, 'mtab=settings&stab=budgets');
    const section = page.getByTestId('budgets-section');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText('No budgets yet.');
    await section.getByTestId('budget-add').click();
    const form = page.getByTestId('budget-form');
    await expect(form.getByTestId('budget-period-month')).toBeChecked();
    await expect(form.getByTestId('budget-timezone')).toHaveValue('UTC');
    for (const t of [75, 90, 100]) await expect(form.getByTestId(`budget-threshold-${t}`)).toBeVisible();
    await form.getByTestId('budget-amount').fill('1000');
    await form.getByTestId('budget-save').click();
    const row = page.getByTestId('budget-row-month');
    await expect(row).toContainText('$1,000.00');
    await expect(row).toContainText('75 · 90 · 100 %');
    await expect(page.getByTestId('budget-add')).toBeEnabled();

    await page.getByTestId('budget-event-log-open').click();
    const log = page.getByTestId('budget-event-log');
    await expect(log.getByTestId('budget-event-row')).toHaveCount(1);
    await expect(log.getByTestId('budget-event-row').first()).toHaveAttribute('data-event-type', 'created');
    await expect(log.getByTestId('budget-event-row').first()).toContainText(owner.email);
    await page.keyboard.press('Escape');
    await expect(log).toHaveCount(0);
  });

  const view = await test.step(`2. session B with OTEL cost ${usd2(2 * OTEL_COST_USD * 1e6)} above its hook cost: the Spend tab shows the spend, every slice adds up to it, a slice row opens its sessions`, async () => {
    const atB = recentAt(10);
    await uploadPromptSession(api, key.key, { sessionId: sidB, prompt: `budget session B ${runId}`, repoUrl, at: atB }, { db, userId: owner.id });
    const lines = [0, 1].map((n) =>
      apiRequestLine(sidB, {
        requestId: `req_budg01_${runId}_${n}`,
        querySource: 'repl_main_thread',
        model: 'claude-sonnet-4-6',
        at: new Date(atB.getTime() + (n + 1) * 10_000),
        costUsd: OTEL_COST_USD,
        input: 10,
        output: 5,
        attributes: { 'skill.name': 'budget-skill' },
      }),
    );
    await uploadOtelChunk(api, key.key, sidB, lines, { db, userId: owner.id });
    await waitForOtelProjected(db, sidB);

    // The OTEL total wins for B, so the month holds A's hook cost plus B's $4 (DD-5).
    await expect.poll(async () => (await getSpend(owner.api, scope)).sessions, { timeout: 15_000 }).toBe(2);
    const s = await getSpend(owner.api, scope);
    expect(s.budget?.label).toBe('Monthly $1,000.00');
    expect(s.spendMicros).toBeGreaterThan(2 * OTEL_COST_USD * 1e6 + 1_000_000);
    expect(s.unpricedTrees).toBe(0);
    expect(s.slices.length).toBeGreaterThan(0);
    for (const slice of s.slices) {
      const sum = slice.rows.reduce((n, r) => n + r.micros, 0);
      expect(Math.abs(sum - s.spendMicros), `${slice.kind} slice adds up to the spend`).toBeLessThanOrEqual(slice.rows.length);
    }
    const skill = s.slices.find((x) => x.kind === 'skill');
    expect(skill?.rows.find((r) => r.label === 'budget-skill')?.micros).toBe(2 * OTEL_COST_USD * 1e6);

    await openRepo(page, owner, repoId, 'mtab=spend');
    const tab = page.getByTestId('spend-tab');
    await expect(tab.getByTestId('spend-total')).toHaveText(usd2(s.spendMicros), { timeout: 15_000 });
    await expect(tab.getByTestId('budget-card')).toContainText('Monthly budget · $1,000.00');
    await expect(tab.getByTestId('spend-period-month')).toHaveAttribute('aria-pressed', 'true');
    await expect(tab.getByTestId('spend-next')).toBeDisabled();
    await expect(tab.getByTestId('spend-manage-budgets')).toBeVisible();
    const slices = tab.getByTestId('spend-slices');
    await expect(slices.getByTestId('slice-total')).toContainText(usd2(s.spendMicros));
    await expect(slices.getByTestId('slice-total')).toContainText('100.0 %');
    await slices.getByTestId('spend-slice-skill').click();
    await expect(page).toHaveURL(/ssl=skill/);
    await slices.getByTestId('slice-row').filter({ hasText: 'budget-skill' }).click();
    const modal = page.getByTestId('spend-sessions-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('spend-session-row')).toHaveCount(1);
    await expect(modal.getByTestId('spend-session-row')).toContainText(usd2(2 * OTEL_COST_USD * 1e6));
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    return s;
  });
  const spend = view.spendMicros;

  await test.step('3. lower the amount so 75, 90 and 100 % are crossed in turn: one notice each, the bell counts them, the banner shows them, × survives a reload, the tray opens Spend at sp=month&so=0', async () => {
    let budget = (await listBudgets(owner.api, scope)).budgets[0];
    await openRepo(page, owner, repoId, 'mtab=spend');
    for (const [i, [percent, threshold]] of ([[80, 75], [95, 90], [105, 100]] as const).entries()) {
      budget = await updateBudget(owner.api, scope, budget, amountForPercent(spend, percent));
      const notices = await waitForUnreadNotices(owner.api, i + 1);
      expect(notices[0].threshold, 'newest notice').toBe(threshold);
      expect(notices[0].link).toMatchObject({ repoId, period: 'month', offset: 0 });
      expect(notices[0].link.teamId ?? null).toBeNull();
      await page.reload();
      await expect(page.getByTestId('notification-badge')).toHaveText(String(i + 1), { timeout: 15_000 });
      await expect(page.getByTestId('budget-notice-banner')).toHaveCount(i + 1);
    }
    const banners = page.getByTestId('budget-notice-banner');
    await expect(banners.first()).toHaveAttribute('data-threshold', '100');
    await expect(banners.first()).toHaveClass(/bg-red-50/);
    await expect(banners.nth(1)).toHaveClass(/bg-amber-50/);
    await expect(page.getByTestId('budget-percent')).toHaveText(`${Math.round(((await getSpend(owner.api, scope)).forecast?.percentUsed ?? 0))} %`);

    // Mode A has no SMTP: every shown notice logs one `email skipped`.
    expect(await listBudgetEvents(owner.api, scope, { event: 'email_skipped' })).toHaveLength(3);
    expect(await listBudgetEvents(owner.api, scope, { event: 'threshold_crossed' })).toHaveLength(3);

    await banners.first().getByTestId('budget-notice-dismiss').click();
    await expect(banners).toHaveCount(2);
    await page.reload();
    await expect(page.getByTestId('budget-notice-banner')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId('budget-notice-banner').first()).toHaveAttribute('data-threshold', '90');
    await expect(page.getByTestId('notification-badge')).toHaveText('2');

    await openRepo(page, owner, repoId, 'mtab=settings&stab=budgets');
    await page.getByRole('button', { name: 'Notifications' }).click();
    const rows = page.getByTestId('budget-notice-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute('data-read', 'true');
    await rows.filter({ hasText: '90 %' }).click();
    await expect(page).toHaveURL(new RegExp(`#/repos/${repoId}\\?.*mtab=spend`));
    await expect(page).toHaveURL(/sp=month/);
    await expect(page).toHaveURL(/so=0/);
    await expect(page.getByTestId('spend-tab')).toBeVisible();
    await expect(page.getByTestId('notification-badge')).toHaveText('1');
  });

  await test.step('4. Analytics › Budget burn: the last cumulative point equals the Spend total', async () => {
    const burn = await repoGet<BudgetBurnView>(owner, repoId, '/analytics/budget-burn', { tz: 'UTC' });
    expect(burn.spendMicros).toBe(spend);
    expect(burn.points.at(-1)?.cumulativeMicros).toBe(spend);
    const { first, today } = currentUtcMonthDays();
    await openAnalytics(page, owner, repoId, { from: first, to: today, view: 'budget-burn' });
    await expect(page.getByTestId('budget-burn-last')).toHaveText(usd2(spend), { timeout: 15_000 });
    await expect(page.getByTestId('budget-burn-chart')).toBeVisible();
  });

  await test.step('5. Reports › Budget: the same spend, % and forecast as the Spend view; the PDF downloads', async () => {
    const s: SpendView = await getSpend(owner.api, scope);
    expect(s.spendMicros).toBe(spend);
    const { first, today } = currentUtcMonthDays();
    const report = await repoGet<BudgetReport>(owner, repoId, '/reports/budget', {
      startDate: `${first}T00:00:00.000Z`,
      endDate: `${today}T23:59:59.999Z`,
      tz: 'UTC',
    });
    expect(report.budgets).toHaveLength(1);
    const current = report.budgets[0].periods.find((p) => p.isCurrent);
    expect(current?.spendMicros).toBe(spend);
    expect(current?.percentUsed).toBeCloseTo(s.forecast?.percentUsed ?? -1, 6);
    expect(current?.forecast?.forecastMicros).toBe(s.forecast?.forecastMicros);

    await openReport(page, owner, repoId, 'budget', { startDate: first, endDate: today });
    const section = page.getByTestId('report-budget-month');
    await expect(section.getByTestId('report-budget-spend').first()).toHaveText(usd2(spend));
    await expect(section.getByTestId('report-budget-percent').first()).toHaveText(`${Math.round(s.forecast?.percentUsed ?? 0)} %`);
    const pdf = await downloadPdfText(page);
    expect(pdf.filename).toBe(`budget_${first}_${today}.pdf`);
    expect(pdf.text).toContain(usd2(spend));
  });

  await test.step('6. Help: the Budgets page opens from the help menu', async () => {
    await page.getByRole('button', { name: 'Help' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('navigation').getByRole('button', { name: 'Budgets', exact: true }).click();
    await expect(dialog.getByRole('heading', { level: 1, name: 'Budgets', exact: true })).toBeVisible();
    await expect(dialog).toContainText('Log Hub');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  await test.step('7. edit the amount, then delete the budget: the event log keeps every event, marked «(deleted)»', async () => {
    await openRepo(page, owner, repoId, 'mtab=settings&stab=budgets');
    await page.getByTestId('budget-edit-month').click();
    const form = page.getByTestId('budget-form');
    await expect(form).toContainText('applies to the whole period');
    await form.getByTestId('budget-amount').fill('500');
    await form.getByTestId('budget-save').click();
    await expect(page.getByTestId('budget-row-month')).toContainText('$500.00');

    await page.getByTestId('budget-delete-month').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('budgets-section')).toContainText('No budgets yet.');
    expect((await listBudgets(owner.api, scope)).budgets).toEqual([]);

    const events = await listBudgetEvents(owner.api, scope);
    const types = events.map((e) => e.eventType);
    expect(types[0]).toBe('deleted');
    for (const t of ['created', 'edited', 'threshold_crossed', 'email_skipped']) expect(types, t).toContain(t);
    expect(events.every((e) => e.budgetDeleted)).toBe(true);

    await page.getByTestId('budget-event-log-open').click();
    const log = page.getByTestId('budget-event-log');
    const rows = log.getByTestId('budget-event-row');
    await expect(rows).toHaveCount(events.length);
    await expect(rows.first()).toHaveAttribute('data-event-type', 'deleted');
    for (let i = 0; i < events.length; i += 1) await expect(rows.nth(i)).toContainText('(deleted)');
    await expect(log.locator('[data-event-type="threshold_crossed"]').first()).toContainText('system · threshold job');
  });
});
