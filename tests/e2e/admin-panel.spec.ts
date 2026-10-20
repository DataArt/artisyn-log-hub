import { test, expect } from '@playwright/test';
import { storageStatePath } from './helpers/credentials';

// ────────────────────────────────────────────────────────────
// Admin user — authenticated via the `admin` storageState.
// ────────────────────────────────────────────────────────────
test.describe('Admin Panel — admin user', () => {
  test.use({ storageState: storageStatePath('admin') });

  test('@core System Info tab renders real, non-corrupted system metrics', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin');
    await page.waitForURL('**/#/admin', { timeout: 10_000 });

    const systemInfoTab = page.getByRole('tab', { name: 'System Info' });
    await expect(systemInfoTab).toBeVisible({ timeout: 8_000 });
    await systemInfoTab.click();
    await expect(systemInfoTab).toHaveAttribute('data-state', 'active', {
      timeout: 3_000,
    });

    const tabPanel = page.getByRole('tabpanel');

    // Key card / tile labels become visible (actual rendered casing from
    // AdminSystemTab.tsx is Title Case; CSS applies the ALL-CAPS look).
    await expect(
      tabPanel.getByText('Node Instances', { exact: true }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      tabPanel.getByText('Visible CPUs', { exact: true }),
    ).toBeVisible();
    await expect(tabPanel.getByText('Database', { exact: true })).toBeVisible();
    await expect(
      tabPanel.getByText('Memory', { exact: true }).first(),
    ).toBeVisible();
    await expect(tabPanel.getByText('Uptime', { exact: true })).toBeVisible();
    await expect(
      tabPanel.getByText('Load Average', { exact: true }),
    ).toBeVisible();
    await expect(tabPanel.getByText('Build', { exact: true })).toBeVisible();
    await expect(
      tabPanel.getByText('Node / Env', { exact: true }),
    ).toBeVisible();
    await expect(
      tabPanel.getByText('Event Loop', { exact: true }),
    ).toBeVisible();
    await expect(tabPanel.getByText('DB Pool', { exact: true })).toBeVisible();
    await expect(tabPanel.getByText('Disk', { exact: true })).toBeVisible();
    await expect(tabPanel.getByText('Requests', { exact: true })).toBeVisible();

    // Wait for the per-instance table to render before reading full panel text.
    // .first() because the tab now renders a second table below it — the
    // Release Downloads inventory — so a bare 'table' locator is ambiguous.
    const perInstanceTable = tabPanel.locator('table').first();
    await expect(perInstanceTable).toBeVisible({ timeout: 8_000 });

    // Cheap, direct regression check: no corrupted values anywhere in the tab
    const panelText = await tabPanel.innerText();
    expect(panelText).not.toContain('NaN');
    expect(panelText).not.toContain('undefined');
    expect(panelText).not.toMatch(/\bnull\b/);

    expect(jsErrors).toHaveLength(0);
  });

  // Environment-dependent half of the System Info check. It only holds on a
  // plain local dev server (no cluster supervisor, unstamped "dev" build, a DB
  // role allowed to read table sizes), so each precondition is read from the
  // same API the tab renders and the test skips with an explicit reason when
  // the server under test is not set up that way.
  test('@core System Info tab renders the single-process dev fallback and DB Space', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin');
    await page.waitForURL('**/#/admin', { timeout: 10_000 });

    const infoResp = await page.request.get('/api/v1/admin/system');
    expect(infoResp.ok()).toBeTruthy();
    const info = (await infoResp.json()) as {
      supervisor: { clustered: boolean };
      build: { version: string };
      dbSpace: { available: boolean };
    };
    test.skip(
      info.supervisor.clustered,
      'Server runs under a cluster supervisor — the single-process fallback is not rendered',
    );
    test.skip(
      info.build.version !== 'dev',
      `Server is a stamped build (version ${info.build.version}) — the Build tile does not read "dev"`,
    );
    test.skip(
      !info.dbSpace.available,
      'DB role cannot inspect table sizes — the DB Space card is omitted',
    );

    const systemInfoTab = page.getByRole('tab', { name: 'System Info' });
    await expect(systemInfoTab).toBeVisible({ timeout: 8_000 });
    await systemInfoTab.click();
    await expect(systemInfoTab).toHaveAttribute('data-state', 'active', {
      timeout: 3_000,
    });
    const tabPanel = page.getByRole('tabpanel');
    const perInstanceTable = tabPanel.locator('table').first();
    await expect(perInstanceTable).toBeVisible({ timeout: 8_000 });

    // No cluster primary, so the single-process fallback path must render,
    // end-to-end: exactly one per-instance row, and the Build tile literally
    // shows "dev".
    const rows = perInstanceTable.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(
      tabPanel.getByText(
        'Running without a supervisor — showing this process only',
      ),
    ).toBeVisible();

    const buildTile = tabPanel.getByText('Build', { exact: true }).locator('..');
    await expect(buildTile).toContainText('dev');

    // The DB role can read sizes, so the DB Space card must be visible with
    // both rows and bytes rendered as real text.
    const dbSpaceCard = tabPanel.getByText('DB Space', { exact: true }).locator('..');
    await expect(dbSpaceCard).toBeVisible();
    await expect(dbSpaceCard).toContainText(/Logs table: [\d,]+ rows/);
    await expect(dbSpaceCard).toContainText(/Database total: [\d.]+\s*\w+/);

    expect(jsErrors).toHaveLength(0);
  });

  test('Filter box on Repos tab narrows rows', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin');
    await page.waitForURL('**/#/admin', { timeout: 10_000 });

    // System Info is now the default tab — switch to Repos first.
    const reposTab = page.getByRole('tab', { name: 'Repos' });
    await expect(reposTab).toBeVisible({ timeout: 8_000 });
    await reposTab.click();
    await expect(reposTab).toHaveAttribute('data-state', 'active', { timeout: 3_000 });

    // Wait for table data to load
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 8_000 });

    // Count rows before filtering
    const rowsBefore = await page.locator('tbody tr').count();

    // Type a string that likely matches no repo URL to narrow results
    const filterInput = page.locator('input[placeholder="Filter by repository URL…"]');
    await expect(filterInput).toBeVisible({ timeout: 5_000 });
    await filterInput.fill('zzz-nonexistent-repo-filter-xyz');

    // Wait for debounce (300ms) + rendering
    await page.waitForTimeout(500);

    // Should show "No results." or fewer rows
    const noResults = page.getByText('No results.');
    const rowsAfter = await page.locator('tbody tr').count();

    const filtered = (await noResults.isVisible()) || rowsAfter < rowsBefore;
    expect(filtered).toBe(true);

    expect(jsErrors).toHaveLength(0);
  });

  test('Clicking a column header toggles sort direction indicator', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin');
    await page.waitForURL('**/#/admin', { timeout: 10_000 });

    // System Info is now the default tab — switch to Repos first.
    const reposTab = page.getByRole('tab', { name: 'Repos' });
    await expect(reposTab).toBeVisible({ timeout: 8_000 });
    await reposTab.click();
    await expect(reposTab).toHaveAttribute('data-state', 'active', { timeout: 3_000 });

    // Wait for table to render
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 8_000 });

    // The first column header (Repository) starts sorted asc — ArrowUp icon present
    const firstHeader = page.locator('thead th').first();
    await expect(firstHeader.locator('svg.lucide-arrow-up')).toBeVisible({ timeout: 5_000 });

    // Click header — should toggle to desc
    await firstHeader.click();
    await expect(firstHeader.locator('svg.lucide-arrow-down')).toBeVisible({ timeout: 3_000 });

    // Click again — should go to unsorted (ArrowUpDown)
    await firstHeader.click();
    await expect(firstHeader.locator('svg.lucide-arrow-up-down')).toBeVisible({ timeout: 3_000 });

    expect(jsErrors).toHaveLength(0);
  });
});

