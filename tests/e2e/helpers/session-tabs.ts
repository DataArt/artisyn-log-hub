/**
 * session-tabs.ts — opening a session tab in the legacy e2e specs.
 *
 * The session bar has one level of tabs: the "View" select (the lens) and its row, every other
 * tab under "More ▾". These specs open the session first (a list click or a `?session=` link),
 * then pick the "All tabs" view and click the tab by its test id — in the row, or under More
 * when the row is too narrow.
 */
import { expect, type Page } from '@playwright/test';

export async function openSessionTab(page: Page, tab: string): Promise<void> {
  const lens = page.getByTestId('session-lens');
  await expect(lens).toBeVisible({ timeout: 15_000 });
  if ((await lens.inputValue()) !== 'all') await lens.selectOption('all');
  await expect(lens).toHaveValue('all');
  const trigger = page.getByTestId(`tab-session-${tab}`);
  if (!(await trigger.isVisible())) await page.getByTestId('session-tabs-more').click();
  await trigger.click();
  await expect(page.getByTestId(`tab-session-${tab}`)).toHaveAttribute('aria-selected', 'true');
}
