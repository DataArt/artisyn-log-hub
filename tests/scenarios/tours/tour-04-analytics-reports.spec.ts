// Tour 4 — repository owner: every Analytics view and every report on REPO-GOLD (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 4, §1.7, §1.8; checks per screen §2.2).
//
// The longest story (32 screens: 13 views, 17 reports, the repo Tools/MCP tab and the repo OKF tab), kept apart from
// tour 3 so a broken report does not mix with the settings walk. Analytics views are switched through the view Select, reports through the report
// tree, both as a person does; the range is the golden two weeks (A..A+13d) of the loaded copy.
// The horizontal layout is checked once, on the Cost view (06 §1.7).
//
// Numbers are NOT checked here — S-ANLT-01, S-COST-*, S-REPT-* pin them; the anchor is that each
// view draws data (bars, rows, a summary) and each report renders its document.
//
// Data: all nine golden fixtures (REPO-GOLD, ten roots) for a plain-user owner.
//
// Replaces:
//   - tests/e2e/reports-tab.spec.ts, tests/e2e/executive-summary-report.spec.ts,
//     tests/e2e/usage-analytics.spec.ts, tests/e2e/cache-read-ratio.spec.ts,
//     tests/e2e/analytics-horizontal-view.spec.ts («view/report opens» cases, ≈ 8–12 in all)
//   - client/src/viewer/__tests__/components/reports-tree.test.tsx («renders» cases)
import { test, expect } from '../fixtures';
import { uploadRepoGold } from '../helpers/reports';
import { skipNewUserNudge } from '../helpers/teams';
import { rowById } from './screen-registry';
import { TourWalker } from './tour-kit';

test.use({ timezoneId: 'UTC' });

/** `Analytics: Cost` → `Cost` (the view's label in the Select). */
const viewLabel = (rowId: string) => rowById(rowId).title.replace(/^Analytics: /, '');
/** `Report: Cost by Branch` → `Cost by Branch` (the report's title in the tree and its <h1>). */
const reportTitle = (rowId: string) => rowById(rowId).title.replace(/^Report: /, '');

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-04 owner: analytics & reports tour @mode-a', async ({ stand, api, db, users, page }) => {
  test.setTimeout(420_000);
  const owner = await users.user('user', { label: 'tour04-owner' });
  const gold = await test.step('setup: GS-01…GS-09 (REPO-GOLD) for a plain-user owner', async () => uploadRepoGold(api, db, owner));
  const from = gold.day('2026-01-05');
  const to = gold.day('2026-01-18');

  const walker = new TourWalker({
    story: 'tour-04',
    mode: stand.mode,
    params: { repoId: gold.repoId, from, to, startDate: from, endDate: to },
  });
  walker.attach(page);
  await skipNewUserNudge(page);
  await owner.signIn(page);

  const analyticsRows = walker.rows().filter((r) => r.id.startsWith('repo.analytics.'));
  for (const [i, row] of analyticsRows.entries()) {
    const label = viewLabel(row.id);
    await walker.screen(page, row.id, {
      go: async (hash) => {
        if (i === 0) {
          await page.goto(hash);
          return;
        }
        await page.getByRole('combobox').filter({ hasText: viewLabel(analyticsRows[i - 1].id) }).click();
        await page.getByRole('option').filter({ has: page.getByText(label, { exact: true }) }).click();
      },
      check: async () => {
        const view = row.id.slice('repo.analytics.'.length);
        await expect(page).toHaveURL(new RegExp(`av=${view}(&|$)`));
        await expect(page.getByRole('combobox').filter({ hasText: label })).toBeVisible();
        if (view === 'cost') {
          await page.getByTestId('layout-toggle-horizontal').click();
          await expect(page.getByTestId('bar-row').first()).toBeVisible();
          await page.getByTestId('layout-toggle-vertical').click();
          await expect(page.locator('svg g[style*="cursor: pointer"]').first()).toBeVisible();
        }
      },
    });
  }

  const reportRows = walker.rows().filter((r) => r.id.startsWith('repo.reports.'));
  const tree = page.getByRole('navigation', { name: 'Reports' });
  for (const [i, row] of reportRows.entries()) {
    const title = reportTitle(row.id);
    await walker.screen(page, row.id, {
      go: async (hash) => {
        if (i === 0) {
          await page.goto(hash);
          return;
        }
        // A category may share its report's title («Productivity»): the report button comes last.
        await tree.getByRole('button', { name: title, exact: true }).last().click();
      },
      check: async () => {
        await expect(page).toHaveURL(new RegExp(`report=${row.id.slice('repo.reports.'.length)}(&|$)`));
        // A report with no data keeps «Download as PDF» disabled; a dataOptional row may be empty.
        if (row.dataOptional) return;
        await expect(page.getByRole('button', { name: 'Download as PDF' })).toBeEnabled({ timeout: 20_000 });
        await expect(page.locator('table td').filter({ visible: true }).first()).toBeVisible();
      },
    });
  }

  // The repo Tools/MCP tab (2026-06-19-mcp-invocation-log-tab), by deep link with the golden range.
  await walker.screen(page, 'repo.tools', {
    check: async () => {
      await expect(page).toHaveURL(/mtab=tools(&|$)/);
      await expect(page.getByTestId('tools-top-bar')).toBeVisible();
      await expect(page.getByTestId('tools-panes').or(page.getByTestId('tools-empty'))).toBeVisible({ timeout: 20_000 });
    },
  });

  // The repo OKF tab (2026-10-27-okf-usage-tab), by deep link with the golden range.
  await walker.screen(page, 'repo.okf', {
    check: async () => {
      await expect(page).toHaveURL(/mtab=okf(&|$)/);
      await expect(page.getByTestId('okf-verdict-card').or(page.getByTestId('okf-empty'))).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('okf-filter-strip')).toBeVisible();
    },
  });

  // The repo OTEL tab (2026-10-30-otel-tabs-traces): the golden sessions carry no OTEL records.
  await walker.screen(page, 'repo.otel', {
    check: async () => {
      await expect(page).toHaveURL(/mtab=otel(&|$)/);
      await expect(page.getByTestId('otel-realtime-badge')).toBeVisible();
      await expect(page.getByTestId('otel-empty-A').or(page.getByTestId('otel-cost-chart'))).toBeVisible({ timeout: 20_000 });
    },
  });

  walker.finish();
});
