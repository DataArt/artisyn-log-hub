/**
 * nav.ts — the All views map (`#/map`) and the Home widgets as a person uses them, for S-NAV-01.
 *
 *  - `openMap(page)` presses the top-nav "All views" button and waits for the map filter.
 *  - `mapFilter(page)` / `mapNode(page, id)` address the filter and a tree / question node by the
 *    test ids of DD-4 (`map-filter`, `map-node-<nodeId>`, node ids per DD-10).
 *  - `expandMapNode(page, id)` opens a collapsed container (a click toggles it).
 *  - `homeWidget(page, name)` is a Home widget card (`home-repos`, `home-attention`, …).
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** Opens the map through the top-nav "All views" button; the rail comes from the current route. */
export async function openMap(page: Page): Promise<void> {
  await page.getByTestId('nav-all-views').click();
  await expect(page).toHaveURL(/#\/map/);
  await expect(mapFilter(page)).toBeVisible();
}

/** The map's filter input. */
export function mapFilter(page: Page): Locator {
  return page.getByTestId('map-filter');
}

/** A map node (tree row or question button) by its DD-10 id, e.g. `repo:12/session`. */
export function mapNode(page: Page, id: string): Locator {
  return page.getByTestId(`map-node-${id}`);
}

/** Opens the container `id` when it is collapsed. */
export async function expandMapNode(page: Page, id: string): Promise<void> {
  const node = mapNode(page, id);
  await expect(node).toBeVisible();
  if ((await node.getAttribute('aria-expanded')) !== 'true') {
    // A greyed container (`aria-disabled`, its context missing) still toggles on click; Playwright
    // treats `aria-disabled` as "not enabled", so the click skips that actionability check.
    const greyed = (await node.getAttribute('aria-disabled')) === 'true';
    await node.click({ force: greyed });
  }
  await expect(node).toHaveAttribute('aria-expanded', 'true');
}

export type HomeWidgetName = 'repos' | 'questions' | 'recent' | 'pinned' | 'attention' | 'week' | 'get-started';

/** A Home widget card. */
export function homeWidget(page: Page, name: HomeWidgetName): Locator {
  return page.getByTestId(`home-${name}`);
}

/** Waits until a Home widget shows its content: not busy, no skeleton lines left. */
export async function expectHomeWidgetFilled(page: Page, name: HomeWidgetName): Promise<void> {
  const widget = homeWidget(page, name);
  await expect(widget, `${name} widget`).toBeVisible();
  await expect(widget, `${name} widget is no longer busy`).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 });
  await expect(widget.getByTestId('home-widget-skeleton'), `${name} widget has no placeholder left`).toHaveCount(0);
  await expect(widget.getByRole('alert'), `${name} widget shows no error`).toHaveCount(0);
}

/** `https://git.example/scn/x/repo` → `x/repo`, as Home prints a repository name. */
export function shortRepoName(repoUrl: string): string {
  const parts = repoUrl
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean);
  return parts.slice(-2).join('/') || repoUrl;
}
