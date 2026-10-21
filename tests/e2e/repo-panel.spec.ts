import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import * as crypto from 'crypto';
import {
  BASE_URL,
  E2E_API_KEY_PREFIX,
  ROLES,
  storageStatePath,
} from './helpers/credentials';
import { seedRepoWithSessions, type SeededRepo } from './helpers/seed';
import { ensureUser } from './helpers/auth';
import { isNoAuthMode } from './helpers/auth-mode';
import { deleteUserByEmail, waitForUploadQueueDrained } from './helpers/db';
import {
  DATA_COLLECTION_NOTICE_SETTING,
  consentSettingValue,
} from './helpers/notice-hash';
import { buildSeedRepoUrl, workerIndex } from './helpers/repo-url';

// Runs as the repo owner (`primary`) via saved storageState. Seeds its
// own repo + a claude turn session, then creates a run-unique team and adds the
// seeded repo to it so the team-route + Team Repos nav tests have real data.
test.use({ storageState: storageStatePath('primary') });

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;
let repoUrl: string;
let sessionId: string;
let teamId: number;
let teamName: string;

/** Claude turn NDJSON (as an array) — one Bash tool_use turn + turn duration,
 *  so the session Charts tab renders a Gantt bar / heatmap / agent tree. */
function buildClaudeEvents(sid: string): Record<string, unknown>[] {
  const ts = new Date().toISOString();
  return [
    {
      type: 'user',
      uuid: `${sid}-u1`,
      parentUuid: null,
      sessionId: sid,
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: 'List the files' }] },
    },
    {
      type: 'assistant',
      uuid: `${sid}-a1`,
      parentUuid: `${sid}-u1`,
      sessionId: sid,
      timestamp: ts,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 40 },
        content: [
          { type: 'tool_use', id: `${sid}-tool1`, name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'system',
      subtype: 'turn_duration',
      uuid: `${sid}-s1`,
      parentUuid: `${sid}-a1`,
      sessionId: sid,
      timestamp: ts,
      durationMs: 1200,
    },
  ];
}

test.beforeAll(async () => {
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  sessionId = `repo-panel-s1-${crypto.randomUUID().slice(0, 8)}`;
  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'primary',
    specSlug: 'repo-panel',
    sessions: [
      {
        sessionId,
        firstPrompt: 'E2E test session prompt',
        daysAgo: 0,
        claudeEvents: buildClaudeEvents(sessionId),
      },
    ],
  });
  repoId = seeded.repoId;
  repoUrl = seeded.repoUrl;

  // A run/worker-unique team name derived from the (already-unique) repo URL.
  teamName = `e2e-team-${repoUrl.split('/e2e/')[1].replace(/\//g, '-')}`;
  // Idempotency: a `fullyParallel` retry re-runs beforeAll — clear a prior team.
  const teamsResp = await ownerCtx.get('/api/v1/teams');
  if (teamsResp.ok()) {
    const teams = (await teamsResp.json()) as Array<{ id: number; name: string }>;
    for (const t of teams.filter((t) => t.name === teamName)) {
      await ownerCtx.delete(`/api/v1/teams/${t.id}`);
    }
  }
  const teamResp = await ownerCtx.post('/api/v1/teams', { data: { name: teamName } });
  const team = (await teamResp.json()) as { id: number };
  teamId = team.id;
  await ownerCtx.post(`/api/v1/teams/${teamId}/repositories`, { data: { repoUrl } });
});

test.afterAll(async () => {
  try {
    if (teamId) {
      await ownerCtx.delete(`/api/v1/teams/${teamId}`).catch(() => {});
    }
    await seeded?.cleanup();
  } finally {
    await ownerCtx?.dispose();
  }
});

// ────────────────────────────────────────────────────────────
// Repository View — personal route
// ────────────────────────────────────────────────────────────

test.describe('Repository View — personal route', () => {
  test('404 state when navigating to a non-existent repoId', async ({
    page,
  }) => {
    await page.goto('/#/repos/99999');

    await expect(page.getByText('Repository not found')).toBeVisible({
      timeout: 8_000,
    });
  });
});

// ────────────────────────────────────────────────────────────
// Left nav — Team repos (via per-team expand/collapse)
// ────────────────────────────────────────────────────────────

test.describe('Left nav — Team Repos section', () => {
  test('Team Repos section is visible when a team is selected', async ({
    page,
  }) => {
    await page.goto(`/#/teams/${teamId}/repos/${repoId}`);

    // Active team is auto-expanded — a repo button with a title (URL) is visible
    await expect(page.locator('nav button[title]').first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('@core Team Repos section collapses and expands on header click', async ({
    page,
  }) => {
    await page.goto(`/#/teams/${teamId}/repos/${repoId}`);

    // Active team auto-expands — its repo button (with a title) is visible.
    await expect(page.locator('nav button[title]').first()).toBeVisible({
      timeout: 8_000,
    });

    // The active team's chevron toggle is the sibling button immediately before
    // the team-name button; scoping to it ignores the other teams dt belongs to.
    const teamNameBtn = page.getByRole('button', { name: teamName, exact: true });
    const chevron = teamNameBtn.locator('xpath=preceding-sibling::button[1]');
    await expect(chevron).toHaveAttribute('aria-label', 'Collapse', { timeout: 5_000 });

    // Scope to this team's own repo-list container (the sibling `div.flex-col`
    // rendered right after its header row) rather than the whole nav. The
    // `primary` login is shared by several spec files that run in parallel
    // (repo-panel, session-log-view, help-modal, api-keys, analytics-*), each
    // creating/tearing down its own team — a nav-wide `button[title]` count
    // would flap as those sibling teams appear/disappear mid-assertion.
    const repoButtonsInTeam = teamNameBtn.locator(
      'xpath=../following-sibling::div[1][contains(concat(" ", normalize-space(@class), " "), " flex-col ")]//button[@title]',
    );

    // The per-team repo query only fires once the team is expanded, so the
    // container above renders empty for a beat after the chevron already reads
    // "Collapse". Wait for the seeded row to arrive before snapshotting the
    // count — otherwise `before` is 0 and the post-collapse expectation below
    // becomes an unsatisfiable `toHaveCount(-1)`.
    await expect(repoButtonsInTeam.first()).toBeVisible({ timeout: 8_000 });

    // Collapsing the active team removes its one seeded repo row.
    const before = await repoButtonsInTeam.count();
    await chevron.click();
    await expect(repoButtonsInTeam).toHaveCount(before - 1, { timeout: 5_000 });
    await expect(chevron).toHaveAttribute('aria-label', 'Expand');

    // Expand again
    await chevron.click();
    await expect(repoButtonsInTeam).toHaveCount(before, { timeout: 5_000 });
  });

  test('Team Repos section shows repo entries when team has repos', async ({
    page,
  }) => {
    await page.goto(`/#/teams/${teamId}/repos/${repoId}`);

    // At least one repo entry button with a title should appear
    const repoButtons = page.locator('nav button[title]');
    await expect(repoButtons.first()).toBeVisible({ timeout: 5_000 });
  });

  test('Team Repos section is hidden when no team is selected', async ({
    page,
  }) => {
    // Navigate to API keys — no team route, no team auto-expanded
    await page.goto('/#/api-keys');

    // With no team selected the per-team repos are not expanded, so the
    // Collapse button (for an expanded team) must be absent.
    await expect(
      page.getByRole('button', { name: 'Collapse', exact: true }),
    ).not.toBeVisible({ timeout: 5_000 });
  });

  test('active repo entry is highlighted in Team Repos', async ({ page }) => {
    await page.goto(`/#/teams/${teamId}/repos/${repoId}`);

    // The active repo sub-item has bg-accent and a title attribute
    const activeEntry = page.locator('nav button[title].bg-accent');
    await expect(activeEntry).toBeVisible({ timeout: 5_000 });
  });
});

// ────────────────────────────────────────────────────────────
// Left nav — My Repos section
// ────────────────────────────────────────────────────────────

test.describe('Left nav — My Repos section', () => {
  test('My Repos section is visible when user has repos', async ({ page }) => {
    await page.goto(`/#/repos/${repoId}`);

    await expect(page.getByText('My Repos')).toBeVisible({ timeout: 8_000 });
  });

  test('@core My Repos section collapses and expands on header click', async ({
    page,
  }) => {
    await page.goto(`/#/repos/${repoId}`);

    const header = page.getByRole('button', { name: 'My Repos' });
    await expect(header).toBeVisible({ timeout: 8_000 });

    // Scope to the seeded repo's own entry (title = its unique URL) so the
    // assertion is unaffected by the shared user's other My Repos / hook rows.
    const repoEntry = page.locator(`nav button[title="${repoUrl}"]`).first();
    await expect(repoEntry).toBeVisible({ timeout: 5_000 });

    // Collapse
    await header.click();
    await expect(repoEntry).not.toBeVisible({ timeout: 3_000 });

    // Expand
    await header.click();
    await expect(repoEntry).toBeVisible({ timeout: 3_000 });
  });

  test('My Repos section shows repo entries', async ({ page }) => {
    await page.goto(`/#/repos/${repoId}`);

    await expect(page.getByText('My Repos')).toBeVisible({ timeout: 8_000 });

    const repoButtons = page.locator('nav button[title]');
    await expect(repoButtons.first()).toBeVisible({ timeout: 5_000 });
  });
});

// ────────────────────────────────────────────────────────────
// Back/forward navigation
// ────────────────────────────────────────────────────────────

test.describe('Back/forward navigation', () => {
  test('back from session view returns to analytics tab', async ({ page }) => {
    // Land on analytics tab
    await page.goto(`/#/repos/${repoId}?mtab=analytics`);
    await expect(page.getByRole('tab', { name: 'Analytics' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(
      page.getByRole('tab', { name: 'Analytics', selected: true }),
    ).toBeVisible({ timeout: 5_000 });

    // Navigate to a session (simulates onSessionClick using navigate() — pushState)
    await page.goto(`/#/repos/${repoId}?session=${sessionId}`);
    await expect(page.getByRole('tab', { name: 'Sessions' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(
      page.getByRole('tab', { name: 'Sessions', selected: true }),
    ).toBeVisible({ timeout: 5_000 });

    // Back should return to analytics tab
    await page.goBack();
    await expect(
      page.getByRole('tab', { name: 'Analytics', selected: true }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('forward from analytics returns to session view', async ({ page }) => {
    await page.goto(`/#/repos/${repoId}?mtab=analytics`);
    await expect(
      page.getByRole('tab', { name: 'Analytics', selected: true }),
    ).toBeVisible({ timeout: 8_000 });

    await page.goto(`/#/repos/${repoId}?session=${sessionId}`);
    await expect(
      page.getByRole('tab', { name: 'Sessions', selected: true }),
    ).toBeVisible({ timeout: 5_000 });

    // Back to analytics, then forward returns to sessions
    await page.goBack();
    await expect(
      page.getByRole('tab', { name: 'Analytics', selected: true }),
    ).toBeVisible({ timeout: 8_000 });

    await page.goForward();
    await expect(
      page.getByRole('tab', { name: 'Sessions', selected: true }),
    ).toBeVisible({ timeout: 8_000 });
  });
});

// ────────────────────────────────────────────────────────────
// Session favorites
// ────────────────────────────────────────────────────────────

test.describe('Session favorites', () => {
  test('toggle favorite via star button — gold star appears in session list', async ({
    page,
  }) => {
    await page.goto(`/#/repos/${repoId}?session=${sessionId}`);

    // Wait for the session detail to load (tab bar with toggle button)
    await page.waitForSelector('[aria-label="Toggle favorite"]', {
      timeout: 10_000,
    });

    // Ensure the session is not favorited before the test (cleanup from prior runs)
    // Use page.request so the same session cookie is used
    const cleanupBefore = await page.request.post(
      `/api/v1/repositories/${repoId}/sessions/${sessionId}/favorite`,
      { data: { favorite: false } },
    );
    expect(cleanupBefore.ok()).toBe(true);
    await page.reload();
    await page.waitForSelector('[aria-label="Toggle favorite"]', {
      timeout: 10_000,
    });

    // Verify initial state: not favorited
    const toggleBtn = page.locator('[aria-label="Toggle favorite"]');
    await expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');

    // Click to favorite
    await toggleBtn.click();

    // Wait for the star to update (mutation completes, cache patches)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[aria-label="Toggle favorite"]');
        return btn?.getAttribute('aria-pressed') === 'true';
      },
      { timeout: 5_000 },
    );

    // Verify gold star appears in session list item
    const sessionItem = page.locator('[data-testid="session-item"]').first();
    await expect(sessionItem.locator('[aria-label="Favorite"]')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('star remains after page reload', async ({ page }) => {
    // Ensure session is favorited via page.request (authenticated, shares cookies with the page)
    const setFav = await page.request.post(
      `/api/v1/repositories/${repoId}/sessions/${sessionId}/favorite`,
      { data: { favorite: true } },
    );
    expect(setFav.ok()).toBe(true);

    await page.goto(`/#/repos/${repoId}`);

    // Wait for session list to load
    await page.waitForSelector('[data-testid="session-item"]', {
      timeout: 10_000,
    });

    // Gold star should be visible in the session list
    const sessionItem = page.locator('[data-testid="session-item"]').first();
    await expect(sessionItem.locator('[aria-label="Favorite"]')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('unfavorite removes the star from session list', async ({ page }) => {
    // Ensure session is favorited first via page.request (authenticated)
    const setFav = await page.request.post(
      `/api/v1/repositories/${repoId}/sessions/${sessionId}/favorite`,
      { data: { favorite: true } },
    );
    expect(setFav.ok()).toBe(true);

    await page.goto(`/#/repos/${repoId}?session=${sessionId}`);

    // Wait for the toggle button
    await page.waitForSelector('[aria-label="Toggle favorite"]', {
      timeout: 10_000,
    });

    // Verify the star is filled (aria-pressed=true)
    const toggleBtn = page.locator('[aria-label="Toggle favorite"]');
    await expect(toggleBtn).toHaveAttribute('aria-pressed', 'true');

    // Click to unfavorite
    await toggleBtn.click();

    // Wait for the star to go back to empty
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[aria-label="Toggle favorite"]');
        return btn?.getAttribute('aria-pressed') === 'false';
      },
      { timeout: 5_000 },
    );

    // Star should no longer be visible in session list
    const sessionItem = page.locator('[data-testid="session-item"]').first();
    await expect(
      sessionItem.locator('[aria-label="Favorite"]'),
    ).not.toBeVisible({ timeout: 3_000 });

    // API cleanup: ensure it's unfavorited (already done by the UI toggle above)
    const cleanup = await page.request.post(
      `/api/v1/repositories/${repoId}/sessions/${sessionId}/favorite`,
      { data: { favorite: false } },
    );
    expect(cleanup.ok()).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Session interaction
// ────────────────────────────────────────────────────────────

test.describe('Session interaction', () => {
  test('clicking a session item shows detail in right panel', async ({
    page,
  }) => {
    await page.goto(`/#/repos/${repoId}`);

    await page.waitForSelector('[data-testid="session-item"]', {
      timeout: 10_000,
    });

    const sessionButton = page
      .locator('[data-testid="session-item"]')
      .first();
    await sessionButton.click();

    // Session tabs (Summary / Logs / Call Tree / Info / Raw Logs) appear only when a session is selected
    await expect(page.getByRole('button', { name: 'Logs', exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('switching repos resets session selection', async ({ page }) => {
    await page.goto(`/#/repos/${repoId}`);

    await page.waitForSelector('[data-testid="session-item"]', {
      timeout: 10_000,
    });
    const sessionButton = page.locator('[data-testid="session-item"]').first();
    await sessionButton.click();

    // Session tabs (Summary / Logs / Call Tree / Info / Raw Logs) appear only when a session is selected
    await expect(page.getByRole('button', { name: 'Logs', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.goto(`/#/teams/${teamId}/repos/${repoId}`);

    await page.waitForSelector('#session-list', { timeout: 8_000 });

    await expect(
      page.getByText('Select a session to view details'),
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ────────────────────────────────────────────────────────────
// Session pane follows the URL (B)
// ────────────────────────────────────────────────────────────

/** A one-turn claude transcript whose assistant reply names `model` — the model is the
 *  per-session marker the header's Model stat and the Raw Logs row both render. */
function buildModelMarkedEvents(sid: string, model: string): Record<string, unknown>[] {
  const ts = new Date().toISOString();
  return [
    {
      type: 'user',
      uuid: `${sid}-u1`,
      parentUuid: null,
      sessionId: sid,
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: 'Pane follows URL' }] },
    },
    {
      type: 'assistant',
      uuid: `${sid}-a1`,
      parentUuid: `${sid}-u1`,
      sessionId: sid,
      timestamp: ts,
      message: {
        role: 'assistant',
        model,
        usage: { input_tokens: 100, output_tokens: 40 },
        content: [{ type: 'text', text: 'done' }],
      },
    },
  ];
}

/** A `HeaderStat` value (`<p>label</p><div>value</div>`) in the session header. */
function headerStat(page: Page, label: string) {
  return page.locator(
    `xpath=//p[normalize-space(text())="${label}"]/following-sibling::div`,
  );
}

/** Raw Logs rows (table cells) naming `model` — the session list never renders a `td`. */
function rawLogsCells(page: Page, model: string) {
  return page.locator('td').filter({ hasText: model });
}

test.describe('Session pane follows the URL', () => {
  const MODEL_A = 'claude-sonnet-4-6';
  const MODEL_B = 'claude-haiku-4-5';
  let navSeeded: SeededRepo;
  let navCtx: APIRequestContext;
  let navRepoId: number;
  let sessionA: string;
  let sessionB: string;

  test.beforeAll(async () => {
    navCtx = await pwRequest.newContext({ baseURL: BASE_URL });
    const suffix = `w${workerIndex()}-${crypto.randomUUID().slice(0, 8)}`;
    sessionA = `repo-panel-nav-a-${suffix}`;
    sessionB = `repo-panel-nav-b-${suffix}`;
    navSeeded = await seedRepoWithSessions(navCtx, {
      role: 'primary',
      specSlug: 'repo-panel-nav',
      sessions: [
        {
          sessionId: sessionA,
          firstPrompt: 'Pane nav session A',
          daysAgo: 0,
          claudeEvents: buildModelMarkedEvents(sessionA, MODEL_A),
        },
        {
          sessionId: sessionB,
          firstPrompt: 'Pane nav session B',
          daysAgo: 0,
          claudeEvents: buildModelMarkedEvents(sessionB, MODEL_B),
        },
      ],
    });
    navRepoId = navSeeded.repoId;
  });

  test.afterAll(async () => {
    try {
      await navSeeded?.cleanup();
    } finally {
      await navCtx?.dispose();
    }
  });

  test('A → B (Raw Logs) → Back shows A in the pane and the header', async ({
    page,
  }) => {
    await page.goto(`/#/repos/${navRepoId}?session=${sessionA}&tab=raw-logs`);
    await expect(headerStat(page, 'Model')).toContainText(MODEL_A, {
      timeout: 15_000,
    });
    await expect(rawLogsCells(page, MODEL_A).first()).toBeVisible({
      timeout: 10_000,
    });

    // Select B from the list — a pushed history entry; the Raw Logs tab is kept.
    await page
      .locator('[data-testid="session-item"]')
      .filter({ hasText: 'Pane nav session B' })
      .click();
    await expect(page).toHaveURL(new RegExp(`session=${sessionB}`));
    await expect(page).toHaveURL(/tab=raw-logs/);
    await expect(headerStat(page, 'Model')).toContainText(MODEL_B, {
      timeout: 10_000,
    });
    await expect(rawLogsCells(page, MODEL_B).first()).toBeVisible({
      timeout: 10_000,
    });

    // Back → the URL names A again, and both the header and the pane follow it.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`session=${sessionA}`));
    await expect(headerStat(page, 'Model')).toContainText(MODEL_A, {
      timeout: 10_000,
    });
    await expect(headerStat(page, 'Model')).not.toContainText(MODEL_B);
    await expect(rawLogsCells(page, MODEL_A).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(rawLogsCells(page, MODEL_B)).toHaveCount(0);
  });

  test('editing ?session= switches the pane without a reload', async ({ page }) => {
    await page.goto(`/#/repos/${navRepoId}?session=${sessionA}`);
    await expect(headerStat(page, 'Model')).toContainText(MODEL_A, {
      timeout: 15_000,
    });

    // A marker on `window` survives only if the page is not reloaded.
    await page.evaluate(() => {
      (window as unknown as { __noReloadMarker?: number }).__noReloadMarker = 1;
    });
    await page.evaluate(
      ([repo, sid]) => {
        window.location.hash = `#/repos/${repo}?session=${sid}`;
      },
      [String(navRepoId), sessionB] as const,
    );

    await expect(headerStat(page, 'Model')).toContainText(MODEL_B, {
      timeout: 10_000,
    });
    const marker = await page.evaluate(
      () => (window as unknown as { __noReloadMarker?: number }).__noReloadMarker,
    );
    expect(marker).toBe(1);
  });

  test('an invalid ?session= shows the not-found pane, and Close clears it', async ({
    page,
  }) => {
    const missing = `repo-panel-missing-${crypto.randomUUID().slice(0, 8)}`;
    await page.goto(`/#/repos/${navRepoId}?session=${missing}`);

    const notFound = page.getByTestId('session-not-found');
    await expect(notFound).toBeVisible({ timeout: 15_000 });
    await expect(notFound).toContainText('Session not found');

    await notFound.getByRole('button', { name: 'Close' }).click();
    await expect(notFound).toHaveCount(0);
    await expect(page.getByText('Select a session to view details')).toBeVisible({
      timeout: 5_000,
    });
    expect(page.url()).not.toContain('session=');
  });
});

// ────────────────────────────────────────────────────────────
// Left nav — "My Repos" appears after a first upload (C)
// ────────────────────────────────────────────────────────────

test.describe('Left nav — My Repos after a first upload', () => {
  // A brand-new identity: no storageState, so it starts with no repos at all.
  test.use({ storageState: { cookies: [], origins: [] } });

  const email = `e2e-first-upload-${Date.now()}-${crypto
    .randomUUID()
    .slice(0, 8)}@arrakis.test`;
  const creds = { email, password: ROLES.regular.password };
  const firstRepoUrl = buildSeedRepoUrl('repo-panel-first-upload');
  let userCtx: APIRequestContext;

  test.beforeAll(async () => {
    userCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    await ensureUser(userCtx, creds);
    // The consent screen replaces the whole shell until the notice is accepted.
    const consent = await userCtx.put(
      `/api/v1/user-settings/${DATA_COLLECTION_NOTICE_SETTING}`,
      { data: { value: consentSettingValue() } },
    );
    expect(consent.ok()).toBe(true);
  });

  test.afterAll(async () => {
    try {
      // The repo first (admin-only delete), then the user — its API key cascades.
      const reposResp = await userCtx.get('/api/v1/repositories');
      const repos = reposResp.ok()
        ? ((await reposResp.json()) as Array<{ id: number; repoUrl: string }>)
        : [];
      const repo = repos.find((r) => r.repoUrl === firstRepoUrl);
      if (repo) {
        const adminCtx = await pwRequest.newContext({
          baseURL: BASE_URL,
          storageState: { cookies: [], origins: [] },
        });
        try {
          const sessionResp = isNoAuthMode()
            ? await adminCtx.post('/api/v1/auth/identify', {
                data: { email: ROLES.admin.email },
              })
            : await adminCtx.post('/api/v1/auth/login', {
                data: { email: ROLES.admin.email, password: ROLES.admin.password },
              });
          if (sessionResp.ok()) {
            await adminCtx.delete(`/api/v1/admin/repos/${repo.id}`);
          }
        } finally {
          await adminCtx.dispose();
        }
      }
    } finally {
      await userCtx?.dispose();
      await deleteUserByEmail(email);
    }
  });

  test('a new user\'s first upload makes "My Repos" appear without a reload', async ({
    page,
  }) => {
    // Window focus refetches at once; the 60 s poll is the fallback bound (65 s).
    test.setTimeout(120_000);

    const { cookies } = await userCtx.storageState();
    await page.context().addCookies(cookies);

    await page.goto('/#/api-keys');
    await expect(page.getByRole('button', { name: 'Add Team' })).toBeVisible({
      timeout: 10_000,
    });
    const myReposHeader = page.getByRole('button', { name: 'My Repos' });
    await expect(myReposHeader).toHaveCount(0);

    // The first upload, while the page stays open.
    const keyResp = await userCtx.post('/api/v1/api-keys', {
      data: { name: `${E2E_API_KEY_PREFIX}repo-panel-first-upload-w${workerIndex()}` },
    });
    expect(keyResp.ok()).toBe(true);
    const { key: apiKey } = (await keyResp.json()) as { key: string };
    const sid = `repo-panel-first-upload-w${workerIndex()}-${crypto
      .randomUUID()
      .slice(0, 8)}`;
    const ts = new Date().toISOString();
    const body = [
      { git: { repo: firstRepoUrl, branch: 'main' }, event: 'test', timestamp: ts },
      { event: 'prompt', prompt: 'First upload', timestamp: ts },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const params = new URLSearchParams({ sessionId: sid, type: 'artisyn' });
    const upload = await userCtx.post(`/api/v2/logs?${params.toString()}`, {
      headers: { 'content-type': 'text/plain', 'x-api-key': apiKey },
      data: body,
    });
    expect(upload.ok()).toBe(true);
    await waitForUploadQueueDrained(sid, 'artisyn');

    // A window focus event. TanStack Query v5 listens for `visibilitychange`; `focus` is
    // dispatched too so the test does not hinge on that library detail.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(myReposHeader).toBeVisible({ timeout: 65_000 });
    await expect(page.locator(`nav button[title="${firstRepoUrl}"]`)).toBeVisible({
      timeout: 5_000,
    });
  });
});
