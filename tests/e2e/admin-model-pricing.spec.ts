import { test, expect } from '@playwright/test';
import { storageStatePath } from './helpers/credentials';
import { deleteModelPricing, insertUnpricedModel } from './helpers/db';
import { readRunId } from './helpers/run-lock';

// Admin Panel → Model Pricing: an auto-registered (unpriced) model shows as "No price" and
// becomes a "Manual" model once the admin sets its price. The OpenRouter import is not
// exercised here: it needs outbound network access.
const RUN_ID = readRunId() ?? String(Date.now());
const MODEL_ID = `e2e-unpriced-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;

test.describe('Admin Panel — Model Pricing', () => {
  test.use({ storageState: storageStatePath('admin') });

  test.beforeAll(async () => {
    await insertUnpricedModel(MODEL_ID);
  });

  test.afterAll(async () => {
    await deleteModelPricing(MODEL_ID);
  });

  test('@core Set price on an unpriced model turns it into a Manual model', async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/#/admin?tab=model-pricing');
    const tab = page.getByRole('tab', { name: 'Model Pricing' });
    await expect(tab).toHaveAttribute('data-state', 'active', {
      timeout: 10_000,
    });

    const panel = page.getByRole('tabpanel');
    await panel.getByPlaceholder('Filter by model ID…').fill(MODEL_ID);

    const row = panel.getByRole('row').filter({ hasText: MODEL_ID });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await expect(row.getByTestId('pricing-source-badge')).toHaveText(
      'No price',
    );
    await expect(row.getByText(/auto-added · first seen/)).toBeVisible();

    await row.getByRole('button', { name: 'Set price' }).click();
    const dialog = page.getByTestId('model-price-dialog');
    await expect(
      dialog.getByText(`Set price — ${MODEL_ID}`, { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await dialog.locator('input[name="priceIn"]').fill('1');
    await dialog.locator('input[name="priceOut"]').fill('2');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(row.getByTestId('pricing-source-badge')).toHaveText('Manual', {
      timeout: 10_000,
    });
    await expect(row.getByRole('cell', { name: '$1.00', exact: true })).toBeVisible();
    // Price Out and the blank Cache W 1h (defaulted server-side to 2 × In) both read $2.00.
    await expect(
      row.getByRole('cell', { name: '$2.00', exact: true }),
    ).toHaveCount(2);
    await expect(
      row.getByRole('cell', { name: '$1.25', exact: true }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();

    expect(jsErrors).toHaveLength(0);
  });
});
