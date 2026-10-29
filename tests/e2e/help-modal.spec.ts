import { test, expect } from '@playwright/test';
import { storageStatePath } from './helpers/credentials';

// Static `/main` Help modal — no seeding needed. Runs as `primary` via saved
// storageState. One representative open/close test is @core; the rest
// stay extended.
test.use({ storageState: storageStatePath('primary') });

test.describe('Help Modal', () => {
  test('Active article has visual highlight (blue left border or blue text)', async ({
    page,
  }) => {
    await page.goto('/#/main');

    const helpButton = page.getByRole('button', { name: 'Help' });
    await helpButton.click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // The active nav button should have the blue styling classes
    const gettingStartedButton = page.getByRole('dialog').getByRole('button', {
      name: 'Your first session',
    });

    // Check that the active button has the blue border class
    await expect(gettingStartedButton).toHaveClass(/border-blue-500/, {
      timeout: 5_000,
    });
  });

  test('@core Pressing Escape closes the modal', async ({ page }) => {
    await page.goto('/#/main');

    const helpButton = page.getByRole('button', { name: 'Help' });
    await helpButton.click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
  });

  test('Clicking the × close button closes the modal', async ({ page }) => {
    await page.goto('/#/main');

    const helpButton = page.getByRole('button', { name: 'Help' });
    await helpButton.click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // Shadcn Dialog renders a close button with aria-label="Close"
    const closeButton = page.getByRole('dialog').getByRole('button', {
      name: 'Close',
    });
    await closeButton.click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
  });
});
