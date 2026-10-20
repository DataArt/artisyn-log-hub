/**
 * ui-auth.ts — the login form and the account menu as a person uses them (password modes B/C).
 * Selectors are the visible labels of `LoginPage.tsx` and `top-nav/UserMenu.tsx`.
 */
import { expect, type Page } from '@playwright/test';

/** Fills `/#/login` and presses «Log in» once; does not wait for the outcome. */
export async function submitLoginForm(page: Page, email: string, password: string): Promise<void> {
  if (!/#\/login/.test(page.url())) await page.goto('/#/login');
  const button = page.getByRole('button', { name: 'Log in', exact: true });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await page.getByPlaceholder('Email', { exact: true }).fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await button.click();
}

/**
 * Logs in through `/#/login` with correct credentials and waits until the app left the login
 * page. A mode-B login backoff left on 127.0.0.1 by an earlier `@backoff` scenario shows the
 * «Too many attempts» banner and disables the button; the helper waits for the button to come
 * back and submits again, as a person would.
 */
export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await submitLoginForm(page, email, password);
    const outcome = await Promise.race([
      page.waitForURL((url) => !url.hash.startsWith('#/login'), { timeout: 15_000 }).then(() => 'in' as const),
      page
        .getByText('Too many attempts')
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => 'delayed' as const),
    ]);
    if (outcome === 'in') return;
  }
  throw new Error(`Could not log in as ${email} through the UI (login backoff never cleared)`);
}

/** Opens the account menu (the e-mail button top right) and returns its `role=menu` panel. */
export async function openUserMenu(page: Page, email: string) {
  await page.getByRole('button', { name: email }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * In-app navigation without a reload: changing `location.hash` keeps the SPA (its state, its
 * cached queries and its 401 handler) alive, like clicking a link in the left menu does.
 */
export async function navigateInApp(page: Page, hashPath: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, hashPath);
}
