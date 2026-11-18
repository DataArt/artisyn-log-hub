// @S-WH-04 — workstreams: configure checkpoints, isolation, names and branches, the chat terminal
// (input, colours, resize, clipboard), surviving reloads and restarts, takeover, results, failures
// and history (AC-3, AC-3a, AC-4, AC-13, AC-14, AC-20a, AC-20d, AC-21–AC-23a, AC-27, AC-28).
import type { Page } from '@playwright/test';
import {
  appendInEditor,
  containerState,
  docker,
  dockerExec,
  dockerTry,
  EDITOR,
  existsIn,
  expect,
  gitMain,
  gitStream,
  gotoWorkspace,
  instanceObjects,
  listWorkstreams,
  openFromTree,
  openWorkstreamInUi,
  restartServer,
  say,
  signedInPage,
  signIn,
  terminalText,
  test,
  TERMINAL,
  treeRow,
  waitForLiveTerminal,
  waitForTerminalText,
  withDb,
  workspaceContainer,
  workspaceWithFakeLogin,
  workstreamContainer,
  type WhApi,
  type WorkstreamSummary,
} from './fixtures';

test.describe.configure({ timeout: 2_400_000 });

const toast = (page: Page, text: string | RegExp) => page.getByTestId('toast').filter({ hasText: text });

/** Configure → the fake agent installs `tool` → Finish configuration → "Saved". */
async function configureWith(page: Page, tool: string): Promise<void> {
  await page.getByTestId('topbar-configure').click();
  await expect(page.getByTestId('pinned-tab-configure')).toBeVisible();
  await say(page, `install ${tool}`, `Installed ${tool}`);
  await page.getByRole('button', { name: 'Finish configuration' }).click();
  await expect(toast(page, /^Saved$/)).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('pinned-tab-configure')).toHaveCount(0);
}

async function sessionIdOf(stand: Parameters<typeof withDb>[0], streamId: string): Promise<string> {
  return withDb(stand, async (db) => {
    const r = await db.query<{ s: string }>('SELECT agent_session_id::text AS s FROM workstreams WHERE id = $1', [streamId]);
    return r.rows[0].s;
  });
}

const psArgs = (container: string) => dockerExec(container, ['ps', '-eo', 'args']).stdout;

/** The chat pane's PID in a workstream container. */
const panePid = (streamId: string) =>
  dockerExec(workstreamContainer(streamId), ['tmux', 'display-message', '-p', '-t', 'chat', '#{pane_pid}']).stdout.trim();

/** The last `COLS=<n>` printed in the terminal. */
async function lastCols(page: Page): Promise<number> {
  const all = [...(await terminalText(page, TERMINAL)).matchAll(/COLS=(\d+)/g)];
  return all.length === 0 ? -1 : Number(all[all.length - 1][1]);
}

async function openStreamApi(api: WhApi, workspaceId: string, name: string): Promise<WorkstreamSummary> {
  return api.expectStatus<WorkstreamSummary>('POST', `/api/v1/workspaces/${workspaceId}/workstreams`, 201, { name });
}

/** Selects the History row of `streamId` and returns its replay's visible text once loaded. */
async function replayText(page: Page, streamId: string): Promise<string> {
  await page.locator(`[data-testid="history-row"][data-stream-id="${streamId}"]`).click();
  const replay = page.getByTestId('replay-view');
  await expect(replay).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  return replay.locator('.xterm-rows').innerText();
}

test('@S-WH-04 @mode-a workstreams and the chat', async ({ browser, stand, api }) => {
  await signIn(stand, api);
  const ws = await workspaceWithFakeLogin(api, 'Streams');
  const { context, page, offOrigin } = await signedInPage(browser, stand, api);
  await gotoWorkspace(page, ws.id);

  await test.step('1. Configure installs a tool; a second Configure is refused; no rollback (AC-20d)', async () => {
    await page.getByTestId('topbar-configure').click();
    await expect(page.getByTestId('pinned-tab-configure')).toBeVisible();
    await say(page, 'install tool-a', 'Installed tool-a');

    const again = await api.post(`/api/v1/workspaces/${ws.id}/configure`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'configure_running', message: 'The container is already being configured.' });
    const second = await context.newPage();
    await gotoWorkspace(second, ws.id);
    await expect(second.getByTestId('configure-tab')).toContainText('The container is already being configured.');
    await second.close();

    await page.getByRole('button', { name: 'Finish configuration' }).click();
    await expect(toast(page, /^Saved$/)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('pinned-tab-configure')).toHaveCount(0);
    expect(docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `wh-ckpt-${ws.id}`])).toBe(`wh-ckpt-${ws.id}:1`);
    await expect(page.getByRole('button', { name: /roll ?back|undo|restore/i })).toHaveCount(0);
    await expect(page.getByText(/roll ?back/i)).toHaveCount(0);
  });

  let a: WorkstreamSummary;
  await test.step('2. workstream A: the chat tab is pinned first; it has the configured tool (AC-3, AC-14, AC-21)', async () => {
    a = await openWorkstreamInUi(page, api, ws.id, 'Stream A');
    const tabs = page.locator('[role="tablist"] [role="tab"]');
    await expect(tabs.first()).toHaveAttribute('data-testid', 'pinned-tab-chat');
    await expect(tabs.first()).toHaveText('Chat · Stream A');
    await expect(tabs.first().getByTestId('tab-close')).toHaveCount(0);
    await expect(tabs.first()).not.toHaveAttribute('draggable', 'true');

    await openFromTree(page, '.gitignore');
    await expect(tabs.first()).toHaveAttribute('data-testid', 'pinned-tab-chat');
    await page.locator('[data-testid="file-tab"][data-path=".gitignore"]').getByTestId('tab-close').click();
    await expect(page.getByTestId('file-tab')).toHaveCount(0);
    await expect(tabs.first()).toHaveAttribute('data-testid', 'pinned-tab-chat');
    await tabs.first().click();

    // AC-20a: answered at once, with no login step.
    await say(page, 'first in A', 'You said: first in A');
    expect(existsIn(workstreamContainer(a.id), '/opt/tool-a')).toBe(true);
  });

  let b: WorkstreamSummary;
  await test.step('3. later saves and configurations do not reach an open workstream (AC-3, AC-20d)', async () => {
    await page.getByTestId('switcher-chip-main').click();
    await openFromTree(page, '.gitignore');
    await appendInEditor(page, '\n# main only');
    await page.locator(EDITOR).getByTestId('editor-save').click();
    await expect(page.locator('[data-testid="file-tab"][data-path=".gitignore"]')).not.toHaveAttribute('data-dirty', 'true');
    expect(gitMain(ws.id, ['show', 'HEAD:.gitignore']).stdout).toContain('# main only');
    expect(dockerExec(workstreamContainer(a.id), ['cat', '/workspace/worktree/.gitignore']).stdout).not.toContain('# main only');

    await configureWith(page, 'tool-b');
    expect(existsIn(workstreamContainer(a.id), '/opt/tool-b')).toBe(false);

    b = await openWorkstreamInUi(page, api, ws.id, 'Stream B');
    expect(existsIn(workstreamContainer(b.id), '/opt/tool-b')).toBe(true);
    expect(existsIn(workstreamContainer(b.id), '/opt/tool-a')).toBe(true);
    expect(dockerExec(workstreamContainer(b.id), ['cat', '/workspace/worktree/.gitignore']).stdout).toContain('# main only');
    // AC-20a in B too.
    await say(page, 'first in B', 'You said: first in B');
  });

  let cyrillic: WorkstreamSummary;
  let discarded: WorkstreamSummary;
  await test.step('4. names: 100 characters of any script work; branches get unique slugs (AC-21, AC-21a)', async () => {
    const name100 = 'Отчёт — итоги, план! '.repeat(10).slice(0, 99) + 'я';
    expect([...name100]).toHaveLength(100);
    await page.getByTestId('switcher-open-workstream').click();
    const nameError = page.getByTestId('open-workstream-name-error');
    await page.getByTestId('open-workstream-name').fill(`${name100}я`);
    await page.getByTestId('open-workstream-submit').click();
    await expect(nameError).toHaveText('Use at most 100 characters.');
    await page.getByTestId('open-workstream-name').fill('  ');
    await page.getByTestId('open-workstream-submit').click();
    await expect(nameError).toHaveText('Enter a name.');
    await page.getByTestId('open-workstream-name').fill('stream a');
    await page.getByTestId('open-workstream-submit').click();
    await expect(nameError).toHaveText('This workspace already has a workstream with this name.');
    await page.getByTestId('open-workstream-dialog').getByRole('button', { name: 'Cancel' }).click();

    cyrillic = await openWorkstreamInUi(page, api, ws.id, name100);
    expect(cyrillic.name).toBe(name100);
    await say(page, 'hello from cyrillic', 'You said: hello from cyrillic');
    expect(gitStream(cyrillic.id, ['branch', '--show-current']).stdout.trim()).toMatch(/^ws\/[a-z0-9]+(-[a-z0-9]+)*$/);

    const one = await openStreamApi(api, ws.id, 'Fix the bug!');
    const two = await openStreamApi(api, ws.id, 'fix the bug?');
    expect(gitStream(one.id, ['branch', '--show-current']).stdout.trim()).toBe('ws/fix-the-bug');
    expect(gitStream(two.id, ['branch', '--show-current']).stdout.trim()).toBe('ws/fix-the-bug-2');
    // "D": discarded, for the history check of step 13; the other is discarded too to save room.
    discarded = await api.expectStatus<WorkstreamSummary>('POST', `/api/v1/workstreams/${one.id}/discard`, 200);
    await api.expectStatus('POST', `/api/v1/workstreams/${two.id}/discard`, 200);
    expect(discarded.state).toBe('discarded');
  });

  await test.step('5a. work in A stays in A (AC-4)', async () => {
    await gotoWorkspace(page, ws.id, a.id);
    await say(page, 'make a.txt from A', 'Wrote a.txt');
    await say(page, 'busy 30', /Working\.\.\. \d+s left/);
    const sessionA = await sessionIdOf(stand, a.id);
    expect(psArgs(workstreamContainer(a.id))).toContain(sessionA);
    expect(psArgs(workstreamContainer(b.id))).not.toContain(sessionA);
    expect(psArgs(workspaceContainer(ws.id))).not.toContain(sessionA);
    expect(existsIn(workstreamContainer(a.id), '/workspace/worktree/a.txt')).toBe(true);
    expect(existsIn(workstreamContainer(b.id), '/workspace/worktree/a.txt')).toBe(false);
    expect(existsIn(workspaceContainer(ws.id), '/workspace/repo/a.txt')).toBe(false);
  });

  await test.step('6. the switcher lists the working branch and the open workstreams (AC-13)', async () => {
    const switcher = page.getByTestId('workstream-switcher');
    await expect(page.getByTestId('switcher-chip-main')).toHaveText('main (working branch)');
    await expect(switcher.getByTestId('switcher-chip')).toHaveText(['Stream A', 'Stream B', cyrillic.name]);
    await switcher.locator(`[data-stream-id="${b.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${b.id}$`));
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await expect(treeRow(page, 'a.txt')).toHaveCount(0);
    await switcher.locator(`[data-stream-id="${a.id}"]`).click();
    await expect(treeRow(page, 'a.txt')).toBeVisible();
    await page.getByTestId('switcher-chip-main').click();
    await expect(treeRow(page, 'a.txt')).toHaveCount(0);
    await switcher.locator(`[data-stream-id="${a.id}"]`).click();
  });

  await test.step('5b. closing B leaves A working (AC-4)', async () => {
    const closed = await api.expectStatus<WorkstreamSummary>('POST', `/api/v1/workstreams/${b.id}/close`, 200, { mode: 'for_now' });
    expect(closed.state).toBe('closed');
    expect(containerState(workstreamContainer(b.id))).toBe('exited');
    await waitForTerminalText(page, 'Done after 30s.', TERMINAL, 60_000);
    await say(page, 'still here', 'You said: still here');
  });

  await test.step('7. the chat is a real terminal: input, menus, colours, resize, clipboard (AC-22, AC-22a)', async () => {
    await say(page, 'typed text', 'You said: typed text');

    await say(page, 'ask first', 'Pick an answer:');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitForTerminalText(page, 'You picked: No', TERMINAL);
    await say(page, 'ask again', 'Pick an answer:');
    await page.keyboard.press('Escape');
    await waitForTerminalText(page, '* Cancelled', TERMINAL);

    // Colours arrive as ANSI cells in the xterm buffer.
    expect(await page.locator(TERMINAL).locator('.xterm-rows span[class*="xterm-fg-"]').count()).toBeGreaterThan(0);

    await say(page, 'run echo COLS=$(tput cols)', 'Run finished: exit 0');
    const wide = await lastCols(page);
    expect(wide).toBeGreaterThan(20);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect
      .poll(async () => {
        await say(page, 'run echo COLS=$(tput cols)', 'Run finished: exit 0');
        return lastCols(page);
      }, { timeout: 30_000 })
      .toBeLessThan(wide);
    await page.setViewportSize({ width: 1400, height: 900 });

    // Copy a line through the xterm selection, then paste it back as a message.
    const row = page.locator(TERMINAL).locator('.xterm-rows > div').filter({ hasText: 'You picked: No' }).last();
    await row.click({ clickCount: 3, force: true });
    await page.evaluate(() => document.execCommand('copy'));
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('You picked: No');
    // Ctrl+V is left to the browser (xterm must not turn it into ^V, which the agent ignores).
    const ctrlVConsumed = await page
      .locator(TERMINAL)
      .locator('textarea.xterm-helper-textarea')
      .evaluate((el) => {
        (el as HTMLTextAreaElement).focus();
        const ev = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
    expect(ctrlVConsumed).toBe(false);
    // Headless Chromium has no native Ctrl+V: hand xterm the paste event the browser would fire.
    const pasted = `pasted ${copied.replace(/^[\s*]+/, '').trim()}`;
    await page
      .locator(TERMINAL)
      .locator('textarea.xterm-helper-textarea')
      .evaluate((el, text) => {
        (el as HTMLTextAreaElement).focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, pasted);
    await page.keyboard.press('Enter');
    await waitForTerminalText(page, 'You said: pasted You picked: No', TERMINAL);

    // One chat per workstream: nothing starts another.
    await expect(page.getByRole('button', { name: /new chat|another chat|start chat/i })).toHaveCount(0);
  });

  await test.step('8. a busy agent survives a reload and a server restart (AC-22b)', async () => {
    await say(page, 'busy 40', /Working\.\.\. \d+s left/);
    const pid = panePid(a.id);
    expect(pid).toMatch(/^\d+$/);
    await page.reload();
    await waitForLiveTerminal(page);
    await waitForTerminalText(page, /Working\.\.\. \d+s left/, TERMINAL);

    await restartServer(stand);
    await waitForLiveTerminal(page, 120_000);
    await waitForTerminalText(page, /Working\.\.\. \d+s left/, TERMINAL);
    expect(panePid(a.id)).toBe(pid);
    await waitForTerminalText(page, 'Done after 40s.', TERMINAL, 90_000);
    await say(page, 'remember-me-42', 'You said: remember-me-42');
  });

  await test.step('9. after Docker stops everything, a restart brings A back; closed B stays stopped (AC-22c)', async () => {
    // Leave the page first: an open chat or file poll would start A's container again at once.
    await page.goto('about:blank');
    const running = instanceObjects(stand).containers;
    docker(['stop', '-t', '2', ...running]);
    expect(containerState(workstreamContainer(a.id))).toBe('exited');
    await restartServer(stand);
    await expect.poll(() => containerState(workstreamContainer(a.id)), { timeout: 120_000 }).toBe('running');
    await gotoWorkspace(page, ws.id, a.id);
    await say(page, 'recall', 'You said before: remember-me-42', 120_000);
    expect(containerState(workstreamContainer(b.id))).toBe('exited');
  });

  await test.step('10. a second tab takes the chat over (AC-22d)', async () => {
    const second = await context.newPage();
    await gotoWorkspace(second, ws.id, a.id);
    await waitForLiveTerminal(second);
    await expect(page.getByTestId('terminal-taken-over')).toBeVisible();
    await expect(page.getByTestId('terminal-taken-over')).toContainText('This chat was opened in another tab');
    await second.close();
    await page.getByRole('button', { name: 'Take it back' }).click();
    await waitForLiveTerminal(page);
  });

  await test.step('11. results the agent makes appear, open and download; nothing is embedded (AC-23, AC-23a)', async () => {
    await say(page, 'run sh -c "echo done > out.txt"', 'Run finished: exit 0');
    await expect(treeRow(page, 'out.txt')).toBeVisible({ timeout: 10_000 });
    await openFromTree(page, 'out.txt');
    await expect(page.locator(EDITOR)).toContainText('done');
    await treeRow(page, 'out.txt').click({ button: 'right' });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tree-download').click()]);
    expect(dl.suggestedFilename()).toBe('out.txt');
    await expect(page.locator('iframe')).toHaveCount(0);
    await page.getByTestId('pinned-tab-chat').click();
  });

  await test.step('12. a failed open leaves nothing; a lost container shows "Unavailable" (AC-3a)', async () => {
    const latest = docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `wh-ckpt-${ws.id}`]).split('\n').sort().pop();
    expect(latest).toBe(`wh-ckpt-${ws.id}:2`);
    docker(['image', 'rm', '-f', latest as string]);
    const before = instanceObjects(stand);

    await page.getByTestId('switcher-open-workstream').click();
    await page.getByTestId('open-workstream-name').fill('Stream C');
    await page.getByTestId('open-workstream-submit').click();
    await expect(page.getByTestId('open-workstream-error')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('open-workstream-try-again')).toBeVisible();
    await page.getByTestId('open-workstream-dialog').getByRole('button', { name: 'Cancel' }).click();

    const rows = await withDb(stand, (db) => db.query('SELECT id FROM workstreams WHERE workspace_id = $1 AND name = $2', [ws.id, 'Stream C']));
    expect(rows.rowCount).toBe(0);
    const after = instanceObjects(stand);
    expect(after.containers.sort()).toEqual(before.containers.sort());
    expect(after.volumes.sort()).toEqual(before.volumes.sort());
    expect(gitMain(ws.id, ['branch', '--list', 'ws/stream-c*']).stdout.trim()).toBe('');

    // The Cyrillic workstream loses its container and volumes outside Work Hub.
    dockerTry(['rm', '-f', workstreamContainer(cyrillic.id)]);
    dockerTry(['volume', 'rm', `wh-st-${cyrillic.id}-repo`, `wh-st-${cyrillic.id}-home`]);
    await restartServer(stand);
    await page.reload();
    await expect(page.locator(`[data-testid="switcher-chip-unavailable"][data-stream-id="${cyrillic.id}"]`)).toContainText(
      'Unavailable',
      { timeout: 60_000 },
    );
    await gotoWorkspace(page, ws.id, cyrillic.id);
    await expect(page.getByTestId('workstream-unavailable')).toContainText('Its container could not be started.');
    await expect(page.getByTestId('workstream-try-again')).toBeVisible();
    expect((await listWorkstreams(api, ws.id)).find((s) => s.id === cyrillic.id)?.available).toBe(false);

    await page.getByTestId('topbar-history').click();
    expect(await replayText(page, cyrillic.id)).toContain('hello from cyrillic');
  });

  await test.step('13. after a restart History replays open, closed and discarded chats with colours (AC-27, AC-28)', async () => {
    await restartServer(stand);
    await page.reload();
    await expect(page.getByTestId('history-table')).toBeVisible();
    const states = Object.fromEntries((await listWorkstreams(api, ws.id)).map((s) => [s.id, s.state]));
    expect(states[a.id]).toBe('open');
    expect(states[b.id]).toBe('closed');
    expect(states[discarded.id]).toBe('discarded');
    await expect(page.locator(`[data-testid="history-row"][data-stream-id="${b.id}"] [data-testid="history-state"]`)).toHaveText('closed');
    await expect(page.locator(`[data-testid="history-row"][data-stream-id="${discarded.id}"] [data-testid="history-state"]`)).toHaveText(
      'discarded',
    );

    expect(await replayText(page, a.id)).toContain('Run finished: exit 0');
    await expect(page.getByTestId('replay-view').locator('span[class*="xterm-fg-"]').first()).toBeVisible();
    expect(await replayText(page, b.id)).toContain('You said: first in B');
    await expect(page.getByTestId('replay-view').locator('span[class*="xterm-fg-"]').first()).toBeVisible();
    expect(await replayText(page, discarded.id)).toContain('Fake agent');
    await expect(page.getByTestId('replay-view').locator('span[class*="xterm-fg-"]').first()).toBeVisible();
  });

  expect(offOrigin).toEqual([]);
  await context.close();
});
