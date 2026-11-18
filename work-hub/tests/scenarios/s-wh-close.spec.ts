// @S-WH-05 — closing workstreams: unsaved files and a busy agent first, Bring into main (also with
// a conflict), Already merged elsewhere, Close for now and Reopen, Discard; then the AC-7 reference
// walk with buttons and plain chat messages only (AC-7, AC-24–AC-26).
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import {
  containerState,
  dockerTry,
  EDITOR,
  expect,
  fakeLoginInUi,
  gitMain,
  gitStream,
  gotoWorkspace,
  listWorkstreams,
  openFromTree,
  openWorkstreamInUi,
  say,
  signedInPage,
  signIn,
  test,
  TERMINAL,
  treeRow,
  waitForLiveTerminal,
  waitForTerminalText,
  workspaceWithFakeLogin,
  workstreamBranch,
  workstreamContainer,
} from './fixtures';

test.describe.configure({ timeout: 1_800_000 });

const toast = (page: Page, text: string | RegExp) => page.getByTestId('toast').filter({ hasText: text });
const dialog = (page: Page) => page.getByTestId('close-workstream-dialog');

/**
 * Clicks "Close workstream" and waits for the check. With `confirmBusy`, a "still working"
 * question (the agent printed something in the last seconds) is answered with Continue.
 */
async function startClose(page: Page, { confirmBusy = true } = {}): Promise<string> {
  await page.getByTestId('close-workstream').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).not.toHaveAttribute('data-phase', 'checking', { timeout: 30_000 });
  let phase = (await dialog(page).getAttribute('data-phase')) ?? '';
  if (phase === 'busy' && confirmBusy) {
    await page.getByTestId('close-busy-continue').click();
    await expect(dialog(page)).not.toHaveAttribute('data-phase', 'busy');
    phase = (await dialog(page).getAttribute('data-phase')) ?? '';
  }
  return phase;
}

const mainHead = (workspaceId: string) => gitMain(workspaceId, ['rev-parse', 'main']).stdout.trim();

const historyRow = (page: Page, streamId: string) => page.locator(`[data-testid="history-row"][data-stream-id="${streamId}"]`);

/** The workstream's Docker objects (container and volumes) that still exist. */
function streamObjects(streamId: string): string[] {
  const left: string[] = [];
  if (dockerTry(['inspect', workstreamContainer(streamId)]).status === 0) left.push(workstreamContainer(streamId));
  for (const v of [`wh-st-${streamId}-repo`, `wh-st-${streamId}-home`]) {
    if (dockerTry(['volume', 'inspect', v]).status === 0) left.push(v);
  }
  return left;
}

test('@S-WH-05 @mode-a closing workstreams and the AC-7 walk', async ({ browser, stand, api }) => {
  await signIn(stand, api);
  const ws = await workspaceWithFakeLogin(api, 'Closing');
  const { context, page, offOrigin } = await signedInPage(browser, stand, api);
  await gotoWorkspace(page, ws.id);

  const report = await openWorkstreamInUi(page, api, ws.id, 'Report');
  const reportBranch = await workstreamBranch(stand, report.id);

  await test.step('1. files the agent has not saved are listed first (AC-24)', async () => {
    await say(page, 'make x.txt first draft', 'Wrote x.txt');
    const phase = await startClose(page);
    expect(phase).toBe('uncommitted');
    await expect(dialog(page)).toContainText('The agent has not saved these files yet:');
    await expect(page.getByTestId('close-uncommitted-list')).toHaveText('x.txt');
    await expect(dialog(page)).not.toContainText(/\b(commit|merge|rebase|branch)\b/i);
    await page.getByTestId('close-back-to-chat').click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await listWorkstreams(api, ws.id)).find((s) => s.id === report.id)?.state).toBe('open');

    // The dialog lists the files before any option. The server refuses the options that would
    // lose them until "Close anyway" (`force`); "Close for now" keeps the files in place.
    for (const mode of ['bring_into_main', 'merged_elsewhere']) {
      const r = await api.post(`/api/v1/workstreams/${report.id}/close`, { mode });
      expect(r.status, mode).toBe(409);
      expect(r.body, mode).toMatchObject({ error: 'uncommitted', paths: ['x.txt'] });
    }
  });

  await test.step('2. a busy agent is confirmed first (AC-24)', async () => {
    await say(page, 'busy 20', /Working\.\.\. \d+s left/);
    const phase = await startClose(page, { confirmBusy: false });
    expect(phase).toBe('busy');
    await expect(page.getByTestId('close-busy')).toContainText('The agent is still working in this chat.');
    await page.getByTestId('close-back-to-chat').click();
    await expect(dialog(page)).toHaveCount(0);
    await waitForTerminalText(page, 'Done after 20s.', TERMINAL, 60_000);
  });

  await test.step('3. Bring into main adds the work to main and closes (AC-24)', async () => {
    await say(page, 'commit draft', 'Commit finished: exit 0');
    expect(await startClose(page)).toBe('options');
    await expect(page.getByTestId('close-bring-into-main')).toContainText('Add this work to main');
    await page.getByTestId('close-bring-into-main').click();
    await expect(toast(page, 'Report was brought into main.')).toBeVisible({ timeout: 120_000 });
    await expect(page).toHaveURL(new RegExp(`#/w/${ws.id}$`));
    await expect(treeRow(page, 'x.txt')).toBeVisible();
    expect(gitMain(ws.id, ['show', 'main:x.txt']).stdout.trim()).toBe('first draft');

    await page.getByTestId('topbar-history').click();
    await expect(historyRow(page, report.id)).toHaveAttribute('data-state', 'closed');
    await expect(historyRow(page, report.id).getByTestId('history-added-to-main')).toBeVisible();
    await historyRow(page, report.id).click();
    await expect(page.getByTestId('history-reopen')).toBeVisible();
    await expect.poll(() => containerState(workstreamContainer(report.id)), { timeout: 30_000 }).toBe('exited');
  });

  await test.step('4. a conflict keeps main and the workstream; after combining, it goes in (AC-24)', async () => {
    await page.getByTestId('history-reopen').click();
    await expect(page).toHaveURL(new RegExp(`/s/${report.id}$`), { timeout: 120_000 });

    // The working branch changes the same line.
    await page.getByTestId('switcher-chip-main').click();
    await openFromTree(page, 'x.txt');
    await page.locator(EDITOR).locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('main version');
    await page.locator(EDITOR).getByTestId('editor-save').click();
    await expect(page.locator('[data-testid="file-tab"][data-path="x.txt"]')).not.toHaveAttribute('data-dirty', 'true');
    const mainBefore = mainHead(ws.id);

    await page.locator(`[data-testid="switcher-chip"][data-stream-id="${report.id}"]`).click();
    await say(page, 'make x.txt stream version', 'Wrote x.txt');
    await say(page, 'commit stream version', 'Commit finished: exit 0');
    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-bring-into-main').click();
    const conflict = page.getByTestId('close-conflict');
    await expect(conflict).toBeVisible({ timeout: 120_000 });
    await expect(conflict).toContainText('Main has changed since this workstream started.');
    await expect(conflict).toContainText('Combine the latest main into this work');

    expect(mainHead(ws.id)).toBe(mainBefore);
    expect(gitMain(ws.id, ['show', 'main:x.txt']).stdout.trim()).toBe('main version');
    expect((await listWorkstreams(api, ws.id)).find((s) => s.id === report.id)?.state).toBe('open');
    expect(gitStream(report.id, ['rev-parse', 'main']).stdout.trim()).toBe(mainBefore);

    await dialog(page).getByTestId('close-back-to-chat').click();
    await expect(dialog(page)).toHaveCount(0);
    await say(page, 'run git merge main', /Run finished: exit \d+/);
    await say(page, 'commit combined', 'Commit finished: exit 0');
    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-bring-into-main').click();
    await expect(toast(page, 'Report was brought into main.')).toBeVisible({ timeout: 120_000 });
    expect(gitMain(ws.id, ['merge-base', '--is-ancestor', reportBranch, 'main']).status).toBe(0);
    expect(mainHead(ws.id)).not.toBe(mainBefore);
  });

  await test.step('5. Already merged elsewhere frees everything and changes nothing (AC-24a)', async () => {
    const elsewhere = await openWorkstreamInUi(page, api, ws.id, 'Elsewhere');
    await say(page, 'make y.txt elsewhere', 'Wrote y.txt');
    await say(page, 'commit y', 'Commit finished: exit 0');
    const before = mainHead(ws.id);
    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-merged-elsewhere').click();
    await expect(toast(page, 'Elsewhere is done.')).toBeVisible({ timeout: 120_000 });
    expect(mainHead(ws.id)).toBe(before);
    expect(gitMain(ws.id, ['cat-file', '-e', 'main:y.txt']).status).not.toBe(0);
    expect(streamObjects(elsewhere.id)).toEqual([]);

    await page.getByTestId('topbar-history').click();
    await expect(historyRow(page, elsewhere.id)).toHaveAttribute('data-state', 'done');
    await historyRow(page, elsewhere.id).click();
    await expect(page.getByTestId('replay-view')).toBeVisible();
    await expect(page.getByTestId('history-reopen')).toHaveCount(0);
    await page.getByTestId('history-back').click();
  });

  let later = report;
  await test.step('6. Close for now changes no branch; Reopen brings the chat and files back (AC-24a, AC-26)', async () => {
    later = await openWorkstreamInUi(page, api, ws.id, 'Later');
    await say(page, 'make z.txt later', 'Wrote z.txt');
    await say(page, 'commit z', 'Commit finished: exit 0');
    await say(page, 'note this', 'You said: note this');
    const before = mainHead(ws.id);
    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-for-now').click();
    await expect(toast(page, 'Later is closed. You can reopen it from History.')).toBeVisible({ timeout: 120_000 });
    expect(mainHead(ws.id)).toBe(before);
    expect(gitMain(ws.id, ['branch', '--list', await workstreamBranch(stand, later.id)]).stdout.trim()).toBe('');
    await expect.poll(() => containerState(workstreamContainer(later.id)), { timeout: 30_000 }).toBe('exited');

    await page.getByTestId('topbar-history').click();
    await historyRow(page, later.id).click();
    await page.getByTestId('history-reopen').click();
    await expect(page).toHaveURL(new RegExp(`/s/${later.id}$`), { timeout: 120_000 });
    // The earlier output is back in the terminal's scrollback, the files are in place, the agent
    // remembers.
    await waitForLiveTerminal(page);
    const term = page.locator(TERMINAL).locator('.xterm-screen');
    await term.hover();
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
    await waitForTerminalText(page, 'You said: note this', TERMINAL, 10_000);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
    await expect(treeRow(page, 'z.txt')).toBeVisible();
    await say(page, 'recall', 'You said before: note this', 120_000);
  });

  await test.step('7. Discard: Cancel keeps it; confirm removes it for good (AC-25, AC-26)', async () => {
    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-discard').click();
    await expect(page.getByTestId('close-discard-confirm')).toContainText('Discard Later?');
    await page.getByTestId('close-discard-cancel').click();
    await expect(page.getByTestId('close-for-now')).toBeVisible();
    await dialog(page).getByTestId('close-back-to-chat').click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await listWorkstreams(api, ws.id)).find((s) => s.id === later.id)?.state).toBe('open');
    expect(containerState(workstreamContainer(later.id))).toBe('running');

    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-discard').click();
    await page.getByTestId('close-discard-confirm-button').click();
    await expect(toast(page, 'Later was discarded.')).toBeVisible({ timeout: 120_000 });
    expect(streamObjects(later.id)).toEqual([]);
    expect(gitMain(ws.id, ['branch', '--list', await workstreamBranch(stand, later.id)]).stdout.trim()).toBe('');

    await page.getByTestId('topbar-history').click();
    await expect(historyRow(page, later.id)).toHaveAttribute('data-state', 'discarded');
    await historyRow(page, later.id).click();
    await expect(page.getByTestId('history-reopen')).toHaveCount(0);
    await expect(page.getByTestId('history-discard')).toHaveCount(0);
  });

  await test.step('8. AC-7: from a new workspace to a result in main with buttons and plain chat only', async () => {
    await page.goto('/#/');
    await page.getByTestId('new-workspace').click();
    await page.getByTestId('new-workspace-name').fill('Dashboards');
    await page.getByTestId('new-workspace-create').click();
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 180_000 });
    // New login → Enter on the method menu → the code, all typed in the login terminal.
    await fakeLoginInUi(page);
    await expect(toast(page, /^Logged in to /)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('login-banner')).toHaveCount(0);

    await page.getByTestId('switcher-open-workstream').click();
    await page.getByTestId('open-workstream-name').fill('Q3 dashboard');
    await page.getByTestId('open-workstream-submit').click();
    await expect(page.getByTestId('pinned-tab-chat')).toHaveText('Chat · Q3 dashboard', { timeout: 180_000 });

    await say(page, 'make dashboard.html <h1>Q3 revenue</h1>', 'Wrote dashboard.html');
    await say(page, 'run cat dashboard.html', 'Run finished: exit 0');
    await expect(treeRow(page, 'dashboard.html')).toBeVisible({ timeout: 10_000 });
    await treeRow(page, 'dashboard.html').click();
    await expect(page.locator(EDITOR)).toContainText('<h1>Q3 revenue</h1>');
    await treeRow(page, 'dashboard.html').click({ button: 'right' });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tree-download').click()]);
    expect(dl.suggestedFilename()).toBe('dashboard.html');
    expect(fs.readFileSync(await dl.path(), 'utf8')).toContain('<h1>Q3 revenue</h1>');

    await page.getByTestId('pinned-tab-chat').click();
    await say(page, 'commit the dashboard', 'Commit finished: exit 0');
    expect(await startClose(page)).toBe('options');
    await page.getByTestId('close-bring-into-main').click();
    await expect(toast(page, 'Q3 dashboard was brought into main.')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('switcher-chip-main')).toHaveAttribute('aria-current', 'page');
    await expect(treeRow(page, 'dashboard.html')).toBeVisible();
    await openFromTree(page, 'dashboard.html');
    await expect(page.locator(EDITOR)).toContainText('<h1>Q3 revenue</h1>');
  });

  expect(offOrigin).toEqual([]);
  await context.close();
});
