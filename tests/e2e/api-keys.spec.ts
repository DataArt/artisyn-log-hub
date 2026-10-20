import { test, expect } from '@playwright/test';
import { storageStatePath } from './helpers/credentials';

// Static, read-only page — no seeding needed. Runs as `primary` via saved
// storageState. Only the api-key generation happy path is @core; the
// remaining static-presence checks stay extended.
test.use({ storageState: storageStatePath('primary') });

test.describe('API Keys page — Install tab (default)', () => {
  test('npx command code block contains localhost:5173 and artisyn-hooks-installer.tgz', async ({
    page,
  }) => {
    await page.goto('/#/api-keys');

    await page.waitForSelector('code', { timeout: 8_000 });

    // Find the code element that holds the npx install command (not the upgrade command box,
    // which also contains "artisyn-hooks-installer.tgz" and matches a plain "install" substring)
    const codeEl = page.locator('code').filter({
      hasText: 'artisyn-hooks-installer.tgz',
    }).filter({ hasNotText: 'upgrade' });
    await expect(codeEl).toBeVisible({ timeout: 5_000 });

    const cmdText = await codeEl.innerText();
    expect(cmdText).toContain('localhost:5173');
    expect(cmdText).toContain('artisyn-hooks-installer.tgz');
  });

  test('copy button shows visual feedback after click', async ({ page }) => {
    // Inject mock clipboard BEFORE any navigation so it is available when components mount.
    // On http:// origins Chromium blocks navigator.clipboard; this mock makes writeText resolve
    // immediately so the useCopyToClipboard hook can flip the `copied` flag.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: () => Promise.resolve(),
          readText: () => Promise.resolve(''),
        },
        configurable: true,
        writable: true,
      });
    });

    await page.goto('/#/api-keys');

    // Wait for the copy button (titled "Copy") to appear
    const copyBtn = page.locator('button[title="Copy"]').first();
    await expect(copyBtn).toBeVisible({ timeout: 8_000 });

    // Before click: Copy icon (lucide-copy class)
    await expect(copyBtn.locator('svg.lucide-copy')).toBeVisible();

    await copyBtn.click();

    // After click, the button should render the Check icon (lucide-check class)
    // replacing the Copy icon — this confirms the copied state fired
    await expect(copyBtn.locator('svg.lucide-check')).toBeVisible({
      timeout: 3_000,
    });
  });
});

test.describe('API Keys page — Full Auto Install section', () => {
  test('the Full Auto Install card comes before the manual three-step card', async ({
    page,
  }) => {
    await page.goto('/#/api-keys');

    const auto = page.getByText('Full Auto Install');
    const manual = page.getByText('Run the installer');
    await expect(auto).toBeVisible({ timeout: 8_000 });
    await expect(manual).toBeVisible();

    // A new user is nudged to this tab, so the one-liner must be the first
    // thing they meet — assert DOM order, not just presence.
    const manualHandle = await manual.elementHandle();
    if (!manualHandle) throw new Error('"Run the installer" element vanished');
    const autoFirst = await auto.evaluate(
      (el, other) =>
        (el.compareDocumentPosition(other) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
      manualHandle,
    );
    expect(autoFirst).toBe(true);
  });

  test('"Give Me String" button is present and enabled', async ({
    page,
  }) => {
    await page.goto('/#/api-keys');

    const btn = page.getByRole('button', { name: 'Give Me String' });
    await expect(btn).toBeVisible({ timeout: 8_000 });
    // Button should be enabled — no input to fill, it auto-generates a key
    await expect(btn).toBeEnabled();
  });

  test('security warning about terminal history is visible', async ({
    page,
  }) => {
    await page.goto('/#/api-keys');

    // The Full Auto subheading always contains "terminal history" in the security note
    const subheading = page.getByText(/terminal history/).first();
    await expect(subheading).toBeVisible({ timeout: 8_000 });
  });
});
