// Team setup through the UI in the owner's / invitee's Playwright context.
// Every step waits for the confirming UI state and throws a descriptive error otherwise, because
// `teams` is an infra fail-fast phase.
const UI_TIMEOUT_MS = 20000;
const POLL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the server stores for a repo URL: `normalizeRepoUrl` strips a trailing `.git`. */
export function storedRepoUrl(url) {
  return String(url).trim().replace(/\/+$/, '').replace(/\.git$/i, '');
}

/** Team id from a `#/teams/<id>` URL, or null. */
export function teamIdFromUrl(url) {
  const m = String(url).match(/#\/teams\/(\d+)(?:[/?]|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Polls `probe()` until it returns a truthy value and returns it. Throws `message` (plus the last
 * probe error, if any) after `timeoutMs`.
 */
async function waitUntil(probe, message, timeoutMs = UI_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${message}${lastError ? ` (${lastError.message})` : ''}`);
    }
    await sleep(POLL_MS);
  }
}

async function firstText(locator) {
  if ((await locator.count()) === 0) return '';
  return ((await locator.first().textContent()) || '').trim();
}

async function openTab(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.waitFor({ state: 'visible' });
  await tab.click();
  await waitUntil(
    async () => (await tab.getAttribute('aria-selected')) === 'true',
    `team page: the "${name}" tab did not become selected`,
  );
}

/** The `#/teams` list row (`TeamCard`) of `name` whose role label is `roleLabel`. */
function teamRow(page, name, roleLabel) {
  return page
    .locator('li')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByText(roleLabel, { exact: true }) });
}

/** Opens a team's detail page and waits for its heading. */
export async function openTeam(page, teamId, name) {
  await page.goto(`/#/teams/${teamId}`);
  const heading = page.getByRole('heading', { level: 1, name, exact: true });
  try {
    await heading.waitFor({ state: 'visible' });
  } catch {
    throw new Error(`team "${name}" (#${teamId}): detail page never showed its heading`);
  }
}

/**
 * Creates a team via "Add Team" in the left nav. Confirms the team row ("Owner") on `#/teams`,
 * then leaves the page on the team's detail page. Returns { teamId }.
 */
export async function createTeam(page, name) {
  await page.goto('/#/teams');
  await page.getByRole('button', { name: 'Add Team' }).click();
  const input = page.getByPlaceholder('Team name');
  await input.waitFor({ state: 'visible' });
  await input.fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  const teamId = await waitUntil(async () => {
    const id = teamIdFromUrl(page.url());
    if (id) return id;
    const dialogError = await firstText(page.getByRole('dialog').locator('.text-destructive'));
    if (dialogError) throw new Error(dialogError);
    return null;
  }, `create team "${name}": the app never navigated to the new team`);

  await page.goto('/#/teams');
  try {
    await teamRow(page, name, 'Owner').first().waitFor({ state: 'visible' });
  } catch {
    throw new Error(`create team "${name}": no "Owner" row for it on #/teams`);
  }
  await openTeam(page, teamId, name);
  return { teamId };
}

/**
 * On the current team's Members tab, selects the Transparent card in `TeamAccessModeCards` and
 * waits until it is the selected mode. Must run before any invite — the card locks once the team
 * has non-owner members.
 */
export async function setTransparent(page) {
  await openTab(page, 'Members');
  const cards = page.getByTestId('team-access-mode-cards');
  try {
    await cards.waitFor({ state: 'visible' });
  } catch {
    throw new Error('set Transparent: access-mode cards not shown (is this page the team owner\'s?)');
  }
  const radio = cards.getByRole('radio', { name: 'Transparent', exact: true });
  await radio.waitFor({ state: 'attached' });
  if (await radio.isChecked()) return;
  if (await radio.isDisabled()) {
    const note = await firstText(page.getByTestId('transparent-lock-note'));
    throw new Error(`set Transparent: the Transparent card is disabled${note ? ` — ${note}` : ''}`);
  }
  // A controlled radio flips only after the mutation and the teams refetch, so click and poll
  // instead of `check()`, which asserts the state synchronously.
  await radio.click();
  await waitUntil(async () => {
    if (await radio.isChecked()) return true;
    const err = await firstText(cards.locator('.text-destructive'));
    if (err) throw new Error(err);
    return false;
  }, 'set Transparent: the Transparent card never became the selected mode');
}

/**
 * On the current team's Members tab, invites `email` with "Invite member", then confirms the
 * pending invitation row on the Invitations tab. Leaves the page on the Members tab.
 */
export async function invite(page, email) {
  await openTab(page, 'Members');
  const input = page.getByPlaceholder('Email address');
  await input.waitFor({ state: 'visible' });
  await input.fill(email);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();

  await waitUntil(async () => {
    const err = await firstText(page.locator('form').locator('xpath=following-sibling::p[contains(@class,"text-destructive")]'));
    if (err) throw new Error(err);
    if (await page.getByRole('dialog').filter({ hasText: 'Not registered yet' }).count()) {
      throw new Error('the server asked to force-add an unregistered user');
    }
    return (await input.inputValue()) === '';
  }, `invite ${email}: the invite form never cleared`);

  await openTab(page, 'Invitations');
  const row = page
    .locator('li')
    .filter({ has: page.getByText(email, { exact: true }) })
    .filter({ has: page.getByText('pending', { exact: true }) });
  try {
    await row.first().waitFor({ state: 'visible' });
  } catch {
    throw new Error(`invite ${email}: no pending invitation row on the Invitations tab`);
  }
  await openTab(page, 'Members');
}

/**
 * As the invitee: opens the notification bell, presses Accept on `teamName`'s invitation, ticks
 * the acknowledgement in `TeamDisclosureModal` and presses "Accept invitation". Confirms the
 * team row with the "Member" label on `#/teams` and — when `email` is given — the invitee's own
 * member row on the team's Members tab. Returns { teamId }.
 */
export async function acceptInvite(page, teamName, { email = null } = {}) {
  // Invitations are fetched on load (and only re-polled every 60 s), so reload to see a fresh one.
  await page.goto('/#/teams');
  await page.reload();
  const bell = page.getByRole('button', { name: 'Notifications' });
  await bell.waitFor({ state: 'visible' });
  await bell.click();

  const item = page.locator('li').filter({ has: page.getByText(teamName, { exact: true }) });
  try {
    await item.first().waitFor({ state: 'visible' });
  } catch {
    throw new Error(`accept invite to "${teamName}": no pending invitation in the notification bell`);
  }
  await item.first().getByRole('button', { name: 'Accept', exact: true }).click();

  const modal = page.getByTestId('team-disclosure-modal');
  try {
    await modal.waitFor({ state: 'visible' });
  } catch {
    throw new Error(`accept invite to "${teamName}": the disclosure modal did not open`);
  }
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await waitUntil(async () => {
    if ((await modal.count()) === 0) return true;
    const err = await firstText(modal.locator('.text-destructive'));
    if (err) throw new Error(err);
    return false;
  }, `accept invite to "${teamName}": the disclosure modal never closed`);

  // The notification dropdown stays open behind a full-screen backdrop (`fixed inset-0`) that
  // swallows clicks; a hash change does not close it, so reload to drop the UI state.
  await page.goto('/#/teams');
  await page.reload();
  const row = teamRow(page, teamName, 'Member').first();
  try {
    await row.waitFor({ state: 'visible' });
  } catch {
    throw new Error(`accept invite to "${teamName}": no "Member" row for it on #/teams`);
  }
  await row.click();
  const teamId = await waitUntil(
    async () => teamIdFromUrl(page.url()),
    `accept invite to "${teamName}": the team row did not open the team`,
  );
  if (email) {
    await openTeam(page, teamId, teamName);
    await openTab(page, 'Members');
    const memberRow = page.locator('li').filter({ has: page.getByText(email, { exact: true }) });
    try {
      await memberRow.first().waitFor({ state: 'visible' });
    } catch {
      throw new Error(`accept invite to "${teamName}": ${email} is not listed on the Members tab`);
    }
  }
  return { teamId };
}

/**
 * On the current team's Repositories tab, links a repo by URL (before or after ingestion) and
 * waits for its row, shown under the server-normalized URL. Returns { storedUrl }.
 */
export async function linkRepo(page, url) {
  const storedUrl = storedRepoUrl(url);
  await openTab(page, 'Repositories');
  const row = page.locator('tr').filter({ has: page.getByRole('cell', { name: storedUrl, exact: true }) });
  if ((await row.count()) > 0) return { storedUrl };

  const input = page.getByPlaceholder(/^Paste repository URL/);
  await input.waitFor({ state: 'visible' });
  await input.fill(url);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await waitUntil(async () => {
    if ((await row.count()) > 0) return true;
    const err = await firstText(page.locator('form').locator('xpath=following-sibling::p[contains(@class,"text-destructive")]'));
    if (err) throw new Error(err);
    return false;
  }, `link repo ${url}: no "${storedUrl}" row on the Repositories tab`);
  return { storedUrl };
}
