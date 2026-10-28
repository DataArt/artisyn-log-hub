// Tour 3 — repository owner: the personal repository without the session detail (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 3, §1.1, §1.2, §1.6; checks §2.2).
//
// The owner is a plain user (never admin), so every screen shows what an owner — not an admin —
// sees. Main page, the catch-all redirect, the session list in its four view modes, the four main
// tabs, the six Settings sub-tabs, the Hook State page and both API-keys tabs. The repository and
// settings tab bars are compared with the registry (06 §2.4, layer B).
//
// Data: golden GS-01, GS-02 and GS-05 in one repository (DD D1–D2), plus a session that carries a
// `hook-status` line with an issue (the way the hook reports its state, as in S-HSTATE-03) and a
// second API key with a known name.
//
// Replaces:
//   - tests/e2e/repo-panel.spec.ts («tab opens» cases)
//   - tests/e2e/api-keys.spec.ts («tab opens» cases)
//   - tests/e2e/hook-state.spec.ts (list in the menu, detail renders: 2 of 3)
//   - client/src/viewer/__tests__/components/HookStatePage.test.tsx («renders» case)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadGoldenRepo } from '../helpers/session-view';
import { skipNewUserNudge } from '../helpers/teams';
import { TourWalker, expectTabsOnScreen, registryTabIds } from './tour-kit';
import { HOOK_STATUS_FAILED_FILE, uploadHookStatusSession } from './tour-seed';

const GS01_PROMPT = 'Add a /health endpoint to the app and document it';
const VIEW_MODES = ['date', 'user', 'plain', 'branch'] as const;

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-03 owner: repo tour @mode-a', async ({ stand, api, db, users, page }) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'tour03-owner' });

  const params = await test.step('setup: GS-01, GS-02, GS-05; a hook-status with an issue; a named API key', async () => {
    const repo = await uploadGoldenRepo(api, db, owner, ['gs-01', 'gs-02', 'gs-05']);
    const apiKeyName = `tour03-key-${run}`;
    const key = await createApiKey(owner.api, { name: apiKeyName });
    // Uploaded yesterday, so it is the newest session: «By date» opens only the newest day.
    const newestPrompt = `hook status ${run}`;
    await uploadHookStatusSession(
      api,
      key.key,
      { sessionId: `tour03-${run}-hook`, prompt: newestPrompt, repoUrl: repo.repoUrl },
      { db, userId: owner.id },
    );
    return { repoId: repo.repoId, repoUrl: repo.repoUrl, firstPrompt: newestPrompt, apiKeyName };
  });

  const walker = new TourWalker({ story: 'tour-03', mode: stand.mode, params });
  walker.attach(page);
  await skipNewUserNudge(page);
  await owner.signIn(page);

  await walker.screen(page, 'main');
  await walker.screen(page, 'redirect.unknown-path');

  await walker.screen(page, 'repo.sessions', {
    go: async () => {
      await page.goto('/#/main');
      await page.getByRole('button', { name: params.repoUrl, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#/repos/${params.repoId}$`));
      // The list remembers its mode per browser; start from «By date» so the prompt is visible.
      await page.locator('select').filter({ has: page.locator('option[value="plain"]') }).selectOption('date');
    },
    check: async () => {
      // The repo Tools/MCP and OKF tabs' rows belong to tour 4 (analytics & reports), their
      // triggers show here too.
      await expectTabsOnScreen(page, 'repo', [...registryTabIds(walker, 'repo'), 'tools', 'okf']);
      const select = page.locator('select').filter({ has: page.locator('option[value="plain"]') });
      for (const mode of VIEW_MODES) {
        await select.selectOption(mode);
        // «By branch» lists branches (GS-05 is on feature/billing); the others list sessions, and
        // «Plain list» shows every one of them, the golden GS-01 included.
        const prompt = mode === 'plain' ? GS01_PROMPT : params.firstPrompt;
        const anchor = mode === 'branch' ? page.getByText('feature/billing', { exact: true }) : page.getByText(prompt);
        await expect(anchor.filter({ visible: true }).first(), `view mode ${mode}`).toBeVisible();
      }
    },
  });

  for (const tab of ['analytics', 'reports', 'settings'] as const) {
    await walker.screen(page, `repo.${tab}`, {
      go: async () => {
        await page.getByTestId(`tab-repo-${tab}`).click();
        await expect(page).toHaveURL(new RegExp(`mtab=${tab}`));
      },
    });
  }

  const settingsTabs = registryTabIds(walker, 'settings');
  for (const stab of settingsTabs) {
    await walker.screen(page, `repo.settings.${stab}`, {
      go: async () => {
        await page.getByTestId(`tab-settings-${stab}`).click();
      },
      check: stab === 'display' ? () => expectTabsOnScreen(page, 'settings', settingsTabs) : undefined,
    });
  }

  await walker.screen(page, 'hook-state', {
    check: async () => {
      await expect(page.getByRole('heading', { name: 'Hook State' })).toBeVisible();
      await expect(page.getByText(HOOK_STATUS_FAILED_FILE)).toBeVisible();
    },
  });

  await walker.screen(page, 'api-keys.install', {
    go: async () => {
      await page.goto('/#/main');
      await page.getByRole('button', { name: 'My API Keys' }).click();
      await expect(page).toHaveURL(/#\/api-keys$/);
    },
    check: () => expectTabsOnScreen(page, 'apikeys', registryTabIds(walker, 'apikeys')),
  });
  await walker.screen(page, 'api-keys.keys', {
    go: async () => {
      await page.getByTestId('tab-apikeys-keys').click();
    },
  });

  walker.finish();
});
