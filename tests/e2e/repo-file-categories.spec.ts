import {
  test,
  expect,
  request as pwRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import { BASE_URL, storageStatePath } from './helpers/credentials';
import { seedRepoWithSessions, type SeededRepo } from './helpers/seed';

// UI edits run as the repo `owner` (ROLES.owner.email) via saved storageState.
test.use({ storageState: storageStatePath('owner') });

// The three tests share state: test 1 adds `test_category_1`, test 2 removes it,
// test 3 adds `png_files`. They must run in order in a single worker.
test.describe.configure({ mode: 'serial' });

// Deterministic seed data: no discovery, no runtime skip.
// Both paths are `Read` tool calls so they populate session_file_stats (analytics)
// AND the client-side session-log parser. Paths lack a leading slash, so server
// normalisation leaves them unchanged; the patterns below match via unanchored
// case-sensitive `new RegExp(pattern).test(path)`.
const CATEGORY_FILE_PATH = 'client/src/categories/CategoryProbe.tsx';
const CATEGORY_PATTERN = 'CategoryProbe\\.tsx$';
const PNG_FILE_PATH = 'client/src/assets/e2e-logo.png';

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;
let pngSessionId: string;

async function waitForSpinnerGone(page: Page, timeout = 12_000) {
  // Wait for any .animate-spin spinner to disappear
  await expect(page.locator('.animate-spin').first()).not.toBeVisible({ timeout });
}

test.beforeAll(async () => {
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'owner',
    specSlug: 'repo-file-categories',
    sessions: [
      {
        firstPrompt: 'File categories e2e session',
        daysAgo: 0,
        toolCalls: [
          { name: 'Read', filePath: CATEGORY_FILE_PATH },
          { name: 'Read', filePath: PNG_FILE_PATH },
        ],
      },
    ],
  });
  repoId = seeded.repoId;
  pngSessionId = seeded.sessionIds[0];

  // Start from a clean (default) config — the seeded repo has none, but be explicit.
  await ownerCtx.put(`/api/v1/repositories/${repoId}/settings/user`, {
    data: { config: null },
  });
});

test.afterAll(async () => {
  try {
    if (repoId) {
      await ownerCtx
        .put(`/api/v1/repositories/${repoId}/settings/user`, { data: { config: null } })
        .catch(() => {});
    }
    await seeded?.cleanup();
  } finally {
    await ownerCtx?.dispose();
  }
});

// ────────────────────────────────────────────────────────────
// Test 1: add a file category and verify it appears in analytics
// ────────────────────────────────────────────────────────────

test('@core adds a file category and verifies recalculation', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Step 1 — Navigate to repo
  await page.goto(`/#/repos/${repoId}`);
  await waitForSpinnerGone(page);

  // Step 2 — Navigate to Settings tab, File Categories sub-tab
  // (RepositorySettings now splits into sub-tabs — Display/File Categories/
  // Export/Maintenance — selected via the `stab` search param; the default
  // sub-tab is Display, so it must be selected explicitly here.)
  await page.goto(`/#/repos/${repoId}?mtab=settings&stab=file-categories`);
  await waitForSpinnerGone(page);

  await expect(page.getByText('File Categories')).toBeVisible({ timeout: 8_000 });

  // Step 3 — Add category
  const addBtn = page.getByRole('button', { name: /add category/i });
  await expect(addBtn).toBeVisible({ timeout: 5_000 });
  await addBtn.click();

  // The new row appears at the end of the list — fill name and pattern inputs
  // We target the last name-placeholder input (the newly added empty row)
  const nameInputs = page.locator('input[placeholder="Category name"]');
  const patternInputs = page.locator('input[placeholder="Comma-separated patterns"]');

  const lastNameInput = nameInputs.last();
  const lastPatternInput = patternInputs.last();

  await lastNameInput.fill('test_category_1');
  await lastPatternInput.fill(CATEGORY_PATTERN);

  // Assert no red validation error
  await expect(page.locator('.text-destructive').first()).not.toBeVisible({
    timeout: 2_000,
  });

  // Step 4 — Save
  const saveBtn = page.getByRole('button', { name: /^save$/i });
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 });
  await saveBtn.click();

  // Wait for "Unsaved changes" to disappear — this confirms the save completed
  // and the component re-synced initialRows with the server response
  await expect(page.getByText('Unsaved changes')).not.toBeVisible({
    timeout: 15_000,
  });

  // Assert no error message visible
  await expect(
    page.locator('.text-destructive', { hasText: /failed/i }),
  ).not.toBeVisible({ timeout: 3_000 });

  // Step 5 — Verify analytics shows new category in Files view
  await page.goto(`/#/repos/${repoId}?mtab=analytics&av=files&ar=1w`);
  await waitForSpinnerGone(page);

  // The files sub-metric selector is a Select dropdown — open it to verify
  // the test_category_1 metrics are present in the list.
  const subMetricTrigger = page.locator('button[role="combobox"]').last();
  await expect(subMetricTrigger).toBeVisible({ timeout: 10_000 });
  await subMetricTrigger.click();

  await expect(page.getByText(/test_category_1/i).first()).toBeVisible({
    timeout: 10_000,
  });

  // Static metrics Lines changed and Files edited/written should also be present
  await expect(
    page.getByText(/Lines changed|Files edited/i).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Close dropdown
  await page.keyboard.press('Escape');

  // Step 6 — No console errors
  // Filter out known benign messages:
  // - 401 Unauthorized: happens during the pre-login /api/v1/auth/me preflight check
  // - mcpCallsByServer: a data-shape warning for analytics sessions without that field
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('401') && !e.includes('mcpCallsByServer'),
  );
  expect(realErrors).toHaveLength(0);
});

// ────────────────────────────────────────────────────────────
// Test 2: removing category reverts analytics to normal
// ────────────────────────────────────────────────────────────

test('removing category reverts analytics to normal', async ({ page }) => {
  // Step 1 — Navigate to settings, File Categories sub-tab
  await page.goto(`/#/repos/${repoId}?mtab=settings&stab=file-categories`);
  await waitForSpinnerGone(page);
  await expect(page.getByText('File Categories')).toBeVisible({ timeout: 8_000 });

  // Wait for the settings to fully load (loading spinner gone means query finished)
  await waitForSpinnerGone(page);

  // Test 1 (serial) added `test_category_1` — it must be present now.
  const categoryInput = page.locator('input[placeholder="Category name"]');
  await expect(categoryInput.first()).toBeVisible({ timeout: 5_000 });
  await expect(categoryInput.first()).toHaveValue('test_category_1');

  // Step 2 — Click "Delete override" (user settings reset label)
  // The button says "Delete override" for personal config (not team config)
  const resetBtn = page.getByRole('button', { name: /reset|delete override/i });
  await expect(resetBtn).toBeVisible({ timeout: 5_000 });
  await resetBtn.click();

  // A confirmation inline UI appears — click "Confirm"
  const confirmBtn = page.getByRole('button', { name: /confirm/i });
  await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
  await confirmBtn.click();

  // Wait for mutation to complete (spinner gone)
  await expect(page.locator('button .animate-spin')).not.toBeVisible({
    timeout: 10_000,
  });

  // Step 3 — Verify category is gone from analytics
  await page.goto(`/#/repos/${repoId}?mtab=analytics&av=files&ar=1w`);
  await waitForSpinnerGone(page);

  // test_category_1 metric toggle buttons must NOT be visible
  await expect(page.getByText('test_category_1')).not.toBeVisible({
    timeout: 5_000,
  });

  // Static metrics are still there
  await expect(page.getByText(/Edited|Lines/i).first()).toBeVisible({
    timeout: 5_000,
  });
});

// ────────────────────────────────────────────────────────────
// Test 3: user-defined PNG category appears in session log view
// ────────────────────────────────────────────────────────────

test('png file category is applied in session log view', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Step 1 — Navigate to settings, File Categories sub-tab
  await page.goto(`/#/repos/${repoId}?mtab=settings&stab=file-categories`);
  await waitForSpinnerGone(page);
  await expect(page.getByText('File Categories')).toBeVisible({ timeout: 8_000 });

  // Step 2 — Add "png_files" category with pattern .*\.png$
  const addBtn = page.getByRole('button', { name: /add category/i });
  await expect(addBtn).toBeVisible({ timeout: 5_000 });
  await addBtn.click();

  const nameInputs = page.locator('input[placeholder="Category name"]');
  const patternInputs = page.locator('input[placeholder="Comma-separated patterns"]');

  await nameInputs.last().fill('png_files');
  await patternInputs.last().fill('.*\\.png$');

  // Save
  const saveBtn = page.getByRole('button', { name: /^save$/i });
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 });
  await saveBtn.click();

  // Wait for save to complete
  await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('.text-destructive', { hasText: /failed/i }),
  ).not.toBeVisible({ timeout: 3_000 });

  // Step 3 — Navigate to the seeded session that has a .png file read
  await page.goto(`/#/repos/${repoId}?session=${encodeURIComponent(pngSessionId)}`);
  await waitForSpinnerGone(page);

  // The bare `?session=` navigation now lands on Summary — select Logs explicitly.
  await page.getByRole('button', { name: 'Logs', exact: true }).click();

  // Wait for the session log view to be rendered (look for the turns list)
  await expect(page.locator('.animate-spin').first()).not.toBeVisible({ timeout: 15_000 });

  // Step 4 — Verify a section labelled "Png_files" is visible in the session log
  // (category label = first letter uppercased: "png_files" → "Png_files")
  await expect(page.getByText('Png_files').first()).toBeVisible({ timeout: 10_000 });

  // Cleanup — reset category override
  await page.goto(`/#/repos/${repoId}?mtab=settings&stab=file-categories`);
  await waitForSpinnerGone(page);

  const resetBtn = page.getByRole('button', { name: /reset|delete override/i });
  if (await resetBtn.isVisible({ timeout: 3_000 })) {
    await resetBtn.click();
    const confirmBtn = page.getByRole('button', { name: /confirm/i });
    if (await confirmBtn.isVisible({ timeout: 3_000 })) {
      await confirmBtn.click();
      await expect(page.locator('button .animate-spin')).not.toBeVisible({ timeout: 10_000 });
    }
  }

  // Step 5 — No console errors
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('401') && !e.includes('mcpCallsByServer'),
  );
  expect(realErrors).toHaveLength(0);
});
