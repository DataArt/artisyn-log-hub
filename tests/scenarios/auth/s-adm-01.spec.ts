// S-ADM-01. The admin panel is visible to an admin only; its tabs and deep links work
// (docs/qaa-overview/scenarios/01-auth-access-admin.md §S-ADM-01; any mode → A and C, DD SC4).
//
// Code facts that differ from the design text:
//   - step 8: `useAdminTabState.setTab` writes `?tab=` with `replace: true`, so switching tabs adds
//     no history entries and «Back» leaves the admin panel for the page before it. The step pins
//     that behaviour (the tab still lives in the URL — step 7 covers that).
//   - steps 11–13 (AC5 of task 2026-10-26-pricing-fetch-tiered): the price dialog sorts the tier rows
//     before sending, so the only non-increasing input it can be given is a repeated threshold; that
//     is caught in the dialog («Two tiers share the threshold …») and no request is sent.
//   - step 1: a brand-new user is sent from /#/main to /#/api-keys once per browser session
//     (`useNewUserNudge`); the scenario marks the nudge as done so the redirect under test is the
//     AdminGuard one.
//
// Replaces:
//   - tests/e2e/admin-panel.spec.ts (≈9 of 17: link, redirect, tabs, deep links, no-tab, Data
//     Retention tab, nav click, no console errors, regular-user guard ×2)
//   - server/test/admin-panel.e2e-spec.ts (403/401 blocks, ≈9)
//   - client/src/viewer/__tests__/unit/use-admin-tab-state.test.ts (2 of 8)
import type { Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect, type ScenarioUser } from '../fixtures';
import { addTeamRepo, inviteAndAccept, skipNewUserNudge } from '../helpers/teams';
import { insertRow } from '../helpers/db-seed';
import { ADMIN_TABS } from '../../../client/src/viewer/tab-ids';

const TAB_LABELS: Record<(typeof ADMIN_TABS)[number], string> = {
  'system-info': 'System Info',
  'all-repos': 'Repos',
  'all-teams': 'Teams',
  'all-users': 'Users',
  'error-logs': 'Error Logs',
  'upload-queue': 'Upload Queue',
  'data-retention': 'Data Retention',
  auth: 'Auth',
  'model-pricing': 'Model Pricing',
};

const tab = (page: Page, id: string) => page.getByTestId(`tab-admin-${id}`);

/** One long-context tier as the admin enters it (USD/MTok above 150000 prompt tokens). */
const UI_TIER = { aboveTokens: 150_000, priceIn: 6, priceOut: 22.5, priceCacheR: 0.6, priceCacheW5m: 7.5, priceCacheW1h: 12 };
const TIER_LABELS: Record<keyof typeof UI_TIER, string> = {
  aboveTokens: 'Above (tokens)',
  priceIn: 'Input',
  priceOut: 'Output',
  priceCacheR: 'Cache read',
  priceCacheW5m: '5m write',
  priceCacheW1h: '1h write',
};

interface AdminPricingRow {
  modelId: string;
  source: string;
  overrideActive: boolean;
  effective: { priceIn: number; tiers: unknown[] | null } | null;
  base: { tiers: unknown[] | null } | null;
}

/** The model's row of `GET /api/v1/admin/model-pricing`. */
async function adminPricingRow(admin: ScenarioUser, modelId: string): Promise<AdminPricingRow> {
  const res = await admin.api.get('/api/v1/admin/model-pricing');
  expect(res.status()).toBe(200);
  const { models } = (await res.json()) as { models: AdminPricingRow[] };
  const row = models.find((m) => m.modelId === modelId);
  if (!row) throw new Error(`${modelId} is not in the admin model-pricing list`);
  return row;
}

/** Opens Admin → Model Pricing filtered down to `modelId` and returns its table row. */
async function pricingTableRow(page: Page, modelId: string) {
  await page.goto('/#/admin?tab=model-pricing');
  await page.reload();
  await page.getByPlaceholder('Filter by model ID…').fill(modelId);
  const row = page.locator('tbody tr', { hasText: modelId });
  await expect(row).toHaveCount(1);
  return row;
}

/** Clicks «Add tier» in the open price dialog and types `tier` into the new row `n` (1-based). */
async function addTier(page: Page, n: number, tier: typeof UI_TIER): Promise<void> {
  const dialog = page.getByTestId('model-price-dialog');
  await dialog.getByTestId('pricing-tier-add').click();
  for (const [key, label] of Object.entries(TIER_LABELS) as Array<[keyof typeof UI_TIER, string]>) {
    await dialog.getByLabel(`Tier ${n} ${label}`, { exact: true }).fill(String(tier[key]));
  }
}

test('@S-ADM-01 admin panel only for admins, tabs and deep links work @mode-a @mode-c', async ({ api, db, users, page }) => {
  test.setTimeout(180_000);
  const runId = randomBytes(4).toString('hex');
  const admin = await users.user('admin', { label: 'adm1' });
  const regular = await users.user('user', { label: 'adm1-regular' });
  const teamOwner = await users.user('user', { label: 'adm1-teamowner' });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await skipNewUserNudge(page);

  await test.step('1. UI (REGULAR): no «Admin Panel» in the left menu; /#/admin bounces to /#/main', async () => {
    await regular.signIn(page);
    await page.goto('/#/main');
    await expect(page.getByRole('button', { name: 'Add Team' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Admin Panel' })).toHaveCount(0);
    await page.goto('/#/admin');
    await expect(page).toHaveURL(/#\/main$/);
  });

  await test.step('2. API: every admin route → 403 for REGULAR, 401 anonymously', async () => {
    const gets = [
      '/api/v1/admin/repos',
      '/api/v1/admin/teams',
      '/api/v1/admin/users',
      '/api/v1/admin/system',
      '/api/v1/admin/error-logs',
      '/api/v1/admin/logs-archive',
      '/api/v1/admin/upload-queue',
      '/api/v1/admin/upload-queue/stats',
      '/api/v1/admin/auth',
    ];
    for (const path of gets) {
      expect((await regular.api.get(path)).status(), `REGULAR GET ${path}`).toBe(403);
      expect((await api.get(path)).status(), `anonymous GET ${path}`).toBe(401);
    }
    const role = `/api/v1/admin/users/${admin.id}/role`;
    const del = `/api/v1/admin/users/${admin.id}/delete`;
    expect((await regular.api.patch(role, { data: { role: 'user' } })).status()).toBe(403);
    expect((await regular.api.post(del, { data: { confirmEmail: admin.email } })).status()).toBe(403);
    expect((await api.patch(role, { data: { role: 'user' } })).status()).toBe(401);
    expect((await api.post(del, { data: { confirmEmail: admin.email } })).status()).toBe(401);
    expect((await admin.api.get('/api/v1/auth/me')).status()).toBe(200);
  });

  await test.step('3. API: GET /admin/retention → 200 for a team owner, 403 for REGULAR', async () => {
    expect((await teamOwner.api.post('/api/v1/teams', { data: { name: `Adm1-${runId}` } })).status()).toBe(201);
    const res = await teamOwner.api.get('/api/v1/admin/retention');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.retentionDays).toBe('number');
    expect(Array.isArray(body.dailySeries)).toBe(true);
    expect((await regular.api.get('/api/v1/admin/retention')).status()).toBe(403);
  });

  await test.step('4. UI (ADMIN): «Admin Panel» → #/admin with System Info active', async () => {
    await page.context().clearCookies();
    await admin.signIn(page);
    await page.goto('/#/main');
    await page.reload();
    await page.getByRole('button', { name: 'Admin Panel' }).click();
    await expect(page).toHaveURL(/#\/admin$/);
    await expect(tab(page, 'system-info')).toHaveAttribute('data-state', 'active');
  });

  await test.step('5. UI: all 9 tabs activate; no NaN / undefined / null on screen, no page errors', async () => {
    await expect(page.getByRole('tab')).toHaveText(ADMIN_TABS.map((id) => TAB_LABELS[id]));
    for (const id of ADMIN_TABS) {
      await tab(page, id).click();
      await expect(tab(page, id), id).toHaveAttribute('data-state', 'active');
      const panel = page.getByRole('tabpanel');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('Loading…')).toHaveCount(0, { timeout: 15_000 });
      expect(await panel.innerText(), id).not.toMatch(/\bNaN\b|\bundefined\b|\bnull\b/);
    }
    expect(pageErrors).toEqual([]);
  });

  await test.step('6. UI: Teams puts tab=all-teams in the hash; back on System Info the parameter is gone', async () => {
    await tab(page, 'all-teams').click();
    await expect(page).toHaveURL(/#\/admin\?tab=all-teams$/);
    await tab(page, 'system-info').click();
    await expect(page).toHaveURL(/#\/admin$/);
  });

  await test.step('7. UI: ?tab=all-teams opens Teams; ?tab=bogus opens System Info and keeps the hash', async () => {
    await page.goto('/#/admin?tab=all-teams');
    await expect(tab(page, 'all-teams')).toHaveAttribute('data-state', 'active');
    await page.goto('/#/admin?tab=bogus');
    await expect(tab(page, 'system-info')).toHaveAttribute('data-state', 'active');
    await expect(page).toHaveURL(/#\/admin\?tab=bogus$/);
  });

  await test.step('8. UI: tab switches replace the history entry — Back leaves the panel for the previous page', async () => {
    await page.goto('/#/teams');
    await page.getByRole('button', { name: 'Admin Panel' }).click();
    await expect(page).toHaveURL(/#\/admin$/);
    await tab(page, 'all-teams').click();
    await tab(page, 'all-users').click();
    await expect(page).toHaveURL(/#\/admin\?tab=all-users$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/teams$/);
    expect(pageErrors).toEqual([]);
  });

  const teamName = `Adm1-${runId}`;
  const teamId = ((await (await teamOwner.api.get('/api/v1/teams')).json()) as Array<{ id: number; name: string }>).find(
    (t) => t.name === teamName,
  )!.id;

  await test.step('9. UI: an orphan team link (never uploaded) is a Repos row with the team name and no link; the admin removes it', async () => {
    const orphanUrl = `https://git.arrakis.test/scn/${runId}/never-uploaded`;
    await addTeamRepo(teamOwner, teamId, orphanUrl);
    await page.goto('/#/admin?tab=all-repos');
    await page.getByPlaceholder('Filter by repository URL…').fill(orphanUrl);
    const row = page.locator('tbody tr', { hasText: orphanUrl });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(teamName);
    await expect(row.locator('a')).toHaveCount(0);
    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByPlaceholder('Type "confirm" to confirm').fill('confirm');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect((await (await teamOwner.api.get(`/api/v1/teams/${teamId}/repositories`)).json()) as unknown[]).toEqual([]);
  });

  await test.step('10. UI: Admin → Teams «Set new owner» hands the team to a member; a non-member is refused (400)', async () => {
    await inviteAndAccept(teamOwner, regular, teamId);
    await page.goto('/#/admin?tab=all-teams');
    await page.getByPlaceholder('Filter by team name…').fill(teamName);
    const row = page.locator('tbody tr', { hasText: teamName });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Set new owner' }).click();
    const dialog = page.getByTestId('admin-set-team-owner-dialog');
    await expect(dialog).toContainText(`Current owner: ${teamOwner.email}`);
    await dialog.getByLabel('New owner').selectOption({ label: regular.email });
    await dialog.getByRole('button', { name: 'Set owner' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText(regular.email);
    const team = (await (await regular.api.get(`/api/v1/teams/${teamId}`)).json()) as { ownerId: number };
    expect(team.ownerId).toBe(regular.id);
    const refused = await admin.api.post(`/api/v1/admin/teams/${teamId}/owner`, { data: { userId: admin.id } });
    expect(refused.status()).toBe(400);
    expect(pageErrors).toEqual([]);
  });

  const uiModel = `scn-tier-ui-${runId}`;
  const ovModel = `scn-tier-ov-${runId}`;

  await test.step(`11. UI: «Set price» on the unpriced ${uiModel} with one tier above 150000 → the table shows a «> 150k tokens» line with the tier rates under the model row, the admin GET has the tier`, async () => {
    await insertRow(db, 'model_pricing_meta', { model_id: uiModel, first_seen_at: new Date() });
    const row = await pricingTableRow(page, uiModel);
    await row.getByTestId('model-pricing-action-set').click();
    const dialog = page.getByTestId('model-price-dialog');
    await dialog.locator('input[name="priceIn"]').fill('3');
    await dialog.locator('input[name="priceOut"]').fill('15');
    await addTier(page, 1, UI_TIER);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByTestId('pricing-tier-label')).toHaveText('> 150k tokens');
    await expect(row.getByTestId('pricing-tier-priceIn')).toHaveText('$6.00');
    const saved = await adminPricingRow(admin, uiModel);
    expect(saved.source).toBe('manual');
    expect(saved.effective?.tiers).toEqual([UI_TIER]);
  });

  await test.step('12. UI: «Edit» with a second tier at the same threshold → the dialog shows the tier error and nothing is saved', async () => {
    const row = await pricingTableRow(page, uiModel);
    await row.getByTestId('model-pricing-action-edit').click();
    const dialog = page.getByTestId('model-price-dialog');
    await expect(dialog.getByTestId('pricing-tier-row')).toHaveCount(1);
    await addTier(page, 2, { ...UI_TIER, priceIn: 9 });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByTestId('pricing-tiers-error')).toHaveText('Two tiers share the threshold 150,000');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await adminPricingRow(admin, uiModel)).effective?.tiers).toEqual([UI_TIER]);
  });

  await test.step(`13. UI: «Override» on the anthropic-sourced ${ovModel} with one tier → effective.tiers holds it, base.tiers stays null`, async () => {
    await insertRow(db, 'model_pricing', {
      model_id: ovModel,
      price_in: 1,
      price_out: 5,
      price_cache_r: 0.1,
      price_cache_w: 1.25,
      price_cache_w_5m: 1.25,
      price_cache_w_1h: 2,
      price_web_search: 0.01,
      effective_from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      source: 'anthropic',
    });
    const row = await pricingTableRow(page, ovModel);
    await row.getByTestId('model-pricing-action-override').click();
    const dialog = page.getByTestId('model-price-dialog');
    await expect(dialog.getByTestId('pricing-tiers-empty')).toBeVisible();
    await addTier(page, 1, UI_TIER);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByTestId('pricing-tier-label')).toHaveText('> 150k tokens');
    await expect(row.getByTestId('pricing-tier-priceIn')).toHaveText('$6.00');
    const saved = await adminPricingRow(admin, ovModel);
    expect(saved.overrideActive).toBe(true);
    expect(saved.effective?.tiers).toEqual([UI_TIER]);
    expect(saved.base).not.toBeNull();
    expect(saved.base?.tiers).toBeNull();
    expect(pageErrors).toEqual([]);
  });
});
