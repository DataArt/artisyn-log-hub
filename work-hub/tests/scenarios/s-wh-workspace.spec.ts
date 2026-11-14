// @S-WH-02 — workspaces: create, name rules, agent login (new, copied, "Not now"), what a container
// commit leaks, settings (working branch), isolation between users and delete (AC-5, AC-8–AC-10,
// AC-19, AC-20–AC-20c, AC-30, AC-31) and the file area on the host (AC-3b).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  appendInEditor,
  docker,
  dockerExec,
  dockerTry,
  EDITOR,
  expect,
  fakeLoginInUi,
  getWorkspace,
  gitMain,
  gotoWorkspace,
  openFromTree,
  openWorkstreamInUi,
  paintedBackground,
  restartServer,
  say,
  signedInPage,
  signIn,
  test,
  TERMINAL,
  treeRow,
  uniqueEmail,
  waitForTerminalText,
  WhApi,
  workspaceContainer,
} from './fixtures';

test.describe.configure({ timeout: 1_800_000 });

/** "New workspace" → name → Create: leaves the dialog on its next phase. */
async function startCreate(page: Page, name: string): Promise<void> {
  await page.goto('/#/');
  await page.getByTestId('new-workspace').click();
  await page.getByTestId('new-workspace-name').fill(name);
  await page.getByTestId('new-workspace-create').click();
}

/** The workspace id of the page's `#/w/<id>` URL. */
async function workspaceIdFromUrl(page: Page): Promise<string> {
  await expect(page).toHaveURL(/#\/w\/[0-9a-f-]{36}/, { timeout: 180_000 });
  const m = /#\/w\/([0-9a-f-]{36})/.exec(page.url());
  if (!m) throw new Error(`no workspace id in ${page.url()}`);
  return m[1];
}

/** Every Docker object labelled with the workspace (any instance), by kind. */
function objectsOfWorkspace(id: string) {
  const label = ['--filter', `label=artisyn.workhub.workspace=${id}`];
  const names = (args: string[]) => docker(args).split(/\r?\n/).filter((s) => s.trim() !== '');
  return {
    containers: names(['ps', '-a', '--format', '{{.Names}}', ...label]),
    volumes: names(['volume', 'ls', '--format', '{{.Name}}', ...label]),
    images: names(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', ...label]),
    byName: [
      ...names(['ps', '-a', '--format', '{{.Names}}']),
      ...names(['volume', 'ls', '--format', '{{.Name}}']),
      ...names(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']),
    ].filter((n) => n.includes(id)),
  };
}

/** The workspace's folder in the file area: `users/<email>/<slug>-<first 6 hex of the id>`. */
function workspaceFolder(dataDir: string, email: string, slug: string, id: string): string {
  return path.join(dataDir, 'users', email.toLowerCase(), `${slug}-${id.slice(0, 6)}`);
}

/** `git` on the host (not in a container), in a folder of the file area. */
function hostGit(dir: string, args: string[]) {
  return spawnSync('git', ['-c', 'safe.directory=*', '-C', dir, ...args], { encoding: 'utf8' });
}

const WHITE = 'rgb(255, 255, 255)';

async function backgroundOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
}

test('@S-WH-02 @mode-a workspaces, agent login, settings and delete', async ({ browser, stand, api }) => {
  const me = await signIn(stand, api);
  const { context, page, offOrigin } = await signedInPage(browser, stand, api);

  let alphaId = '';
  let betaId = '';
  let gammaId = '';

  await test.step('3a. the first workspace offers no login to copy; a fake login works', async () => {
    await startCreate(page, 'Alpha');
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('agent-login-new')).toBeEnabled();
    await expect(page.getByText('Copy from my workspace')).toHaveCount(0);
    await expect(page.getByTestId('agent-login-sources')).toHaveCount(0);
    await fakeLoginInUi(page);
    await waitForTerminalText(page, 'Login successful.');
    alphaId = await workspaceIdFromUrl(page);
    await expect(page.getByTestId('toast').filter({ hasText: /^Logged in to / })).toBeVisible();
    await expect(page.getByTestId('login-banner')).toHaveCount(0);
  });

  await test.step('1. a new workspace starts empty on main with one commit (AC-8, AC-9)', async () => {
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await expect(treeRow(page, '.devcontainer')).toBeVisible();
    await expect(page.getByTestId('switcher-chip-main')).toHaveText('main (working branch)');

    const log = gitMain(alphaId, ['log', '--format=%s']);
    expect(log.status).toBe(0);
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
    const files = gitMain(alphaId, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim().split('\n');
    expect(files).toContain('.gitignore');

    // The dialog offers no clone or repository option.
    await page.goto('/#/');
    await page.getByTestId('new-workspace').click();
    const dialog = page.getByTestId('new-workspace-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/clone|repository url|git url/i)).toHaveCount(0);
    await expect(dialog.locator('input')).toHaveCount(1);
  });

  await test.step('1b. the workspace is a plain folder on the host, readable with Docker stopped (AC-3b)', async () => {
    const dir = workspaceFolder(stand.dataDir, me.email, 'alpha', alphaId);
    expect(fs.existsSync(path.join(dir, 'workspace', 'repo', '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'home'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    expect(meta).toMatchObject({ id: alphaId, name: 'Alpha', owner: me.email, workingBranch: 'main' });

    // With the container stopped the repository is still an ordinary git repository.
    docker(['stop', '-t', '1', workspaceContainer(alphaId)]);
    const log = hostGit(path.join(dir, 'workspace', 'repo'), ['log', '--format=%s']);
    expect(log.status).toBe(0);
    expect(log.stdout.trim()).toBe('Start workspace');
    // The next action starts it again on demand.
    await gotoWorkspace(page, alphaId);
    await expect(treeRow(page, '.gitignore')).toBeVisible({ timeout: 120_000 });

    // Step 2 continues in the "New workspace" dialog that step 1 left open.
    await page.goto('/#/');
    await page.getByTestId('new-workspace').click();
    await expect(page.getByTestId('new-workspace-dialog')).toBeVisible();
  });

  await test.step('2. name errors (AC-8)', async () => {
    const dialog = page.getByTestId('new-workspace-dialog');
    const error = page.getByTestId('new-workspace-name-error');
    await page.getByTestId('new-workspace-name').fill('   ');
    await page.getByTestId('new-workspace-create').click();
    await expect(error).toHaveText('Enter a name.');

    await page.getByTestId('new-workspace-name').fill('x'.repeat(101));
    await page.getByTestId('new-workspace-create').click();
    await expect(error).toHaveText('Use at most 100 characters.');

    await page.getByTestId('new-workspace-name').fill('  alpha ');
    await page.getByTestId('new-workspace-create').click();
    await expect(error).toHaveText('You already have a workspace with this name.');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('workspace-card')).toHaveCount(1);
  });

  await test.step('3b. the login survives a reload and a server restart (AC-19, AC-20)', async () => {
    await gotoWorkspace(page, alphaId);
    await page.reload();
    await expect(page.getByTestId('workstream-switcher')).toBeVisible();
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await expect(page.getByTestId('login-banner')).toHaveCount(0);

    await restartServer(stand);
    await page.reload();
    await expect(page.getByTestId('workstream-switcher')).toBeVisible();
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await expect(page.getByTestId('login-banner')).toHaveCount(0);
    expect((await getWorkspace(api, alphaId)).loginState).toBe('ok');
  });

  await test.step('4. a second workspace copies the login of the first (AC-20)', async () => {
    await startCreate(page, 'Beta');
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 180_000 });
    const sources = page.getByTestId('agent-login-sources');
    await expect(sources).toBeVisible();
    await sources.getByRole('button', { name: 'Alpha' }).click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Copied the' })).toBeVisible();
    betaId = await workspaceIdFromUrl(page);
    await expect(page.getByTestId('login-banner')).toHaveCount(0);
    const status = dockerExec(workspaceContainer(betaId), ['claude', 'auth', 'status']);
    expect(status.status, status.stdout + status.stderr).toBe(0);
  });

  await test.step('5. "Not now": files still open and save; a workstream asks for the login (AC-20b)', async () => {
    await startCreate(page, 'Gamma');
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('agent-login-not-now').click();
    gammaId = await workspaceIdFromUrl(page);
    await expect(page.getByTestId('login-banner')).toContainText('This workspace needs a');

    await openFromTree(page, '.gitignore');
    await appendInEditor(page, '\n# kept by Gamma');
    await expect(page.locator('[data-testid="file-tab"][data-path=".gitignore"]')).toHaveAttribute('data-dirty', 'true');
    await page.locator(EDITOR).getByTestId('editor-save').click();
    await expect(page.locator('[data-testid="file-tab"][data-path=".gitignore"]')).not.toHaveAttribute('data-dirty', 'true');
    expect(gitMain(gammaId, ['log', '-1', '--format=%s']).stdout.trim()).toBe('Edit .gitignore');
    expect(gitMain(gammaId, ['show', 'HEAD:.gitignore']).stdout).toContain('# kept by Gamma');

    await page.getByTestId('switcher-open-workstream').click();
    await page.getByTestId('open-workstream-name').fill('Needs login');
    await page.getByTestId('open-workstream-submit').click();
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('agent-login-not-now').click();
    await expect(page.getByTestId('agent-login-dialog')).toHaveCount(0);
    // Back on the name form: "Open" would try again; Cancel leaves it.
    await expect(page.getByTestId('open-workstream-name')).toHaveValue('Needs login');
    await page.getByTestId('open-workstream-dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('open-workstream-dialog')).toHaveCount(0);
    const streams = await api.expectStatus<unknown[]>('GET', `/api/v1/workspaces/${gammaId}/workstreams`, 200);
    expect(streams).toEqual([]);
  });

  await test.step('6. a commit of the workspace container holds no project files and no login (AC-20c)', async () => {
    const tag = `whs-scenario-commit:${crypto.randomBytes(4).toString('hex')}`;
    docker(['commit', workspaceContainer(alphaId), tag]);
    try {
      const probe = dockerTry([
        'run', '--rm', '--entrypoint', 'sh', tag, '-c',
        'test -e /workspace/repo && echo repo; test -e "$HOME/.claude/.credentials.json" && echo credentials; echo checked',
      ]);
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.trim()).toBe('checked');
    } finally {
      dockerTry(['image', 'rm', '-f', tag]);
    }
  });

  let alphaStreamId = '';
  await test.step('7. logged out in a workstream and in the workspace → the banner is back (AC-20c)', async () => {
    await gotoWorkspace(page, alphaId);
    const stream = await openWorkstreamInUi(page, api, alphaId, 'Sign out');
    alphaStreamId = stream.id;
    await say(page, 'hello', 'You said: hello');

    // AC-31: the page and the terminal are white.
    expect(await backgroundOf(page, 'body')).toBe(WHITE);
    expect(await paintedBackground(page, `${TERMINAL} .xterm`)).toBe(WHITE);

    await say(page, 'logout', 'Logged out.');
    const rm = dockerExec(workspaceContainer(alphaId), ['sh', '-c', 'rm -f "$HOME/.claude/.credentials.json"']);
    expect(rm.status).toBe(0);

    // Reopen the workspace from the list.
    await page.goto('/#/');
    await page
      .locator(`[data-testid="workspace-card"][data-workspace-id="${alphaId}"]`)
      .getByRole('link', { name: 'Open' })
      .click();
    await expect(page.getByTestId('login-banner')).toBeVisible();
    await expect(page.getByTestId('login-banner')).toContainText('This workspace needs a');
  });

  await test.step('8. settings switch the working branch (AC-10)', async () => {
    const make = dockerExec(
      workspaceContainer(gammaId),
      ['sh', '-c', 'git switch -q -c draft && echo draft > draft-only.txt && git add draft-only.txt && git commit -q -m draft && git switch -q main'],
      { workdir: '/workspace/repo' },
    );
    expect(make.status, make.stderr).toBe(0);

    await page.goto(`/#/w/${gammaId}/settings`);
    await expect(page.getByTestId('settings-name')).toHaveValue('Gamma');
    await page.getByTestId('settings-branch').click();
    await page.getByRole('option', { name: 'draft' }).click();
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Saved' })).toBeVisible();

    await gotoWorkspace(page, gammaId);
    await expect(page.getByTestId('switcher-chip-main')).toHaveText('draft (working branch)');
    await expect(treeRow(page, 'draft-only.txt')).toBeVisible();

    await page.goto(`/#/w/${gammaId}/settings`);
    await page.getByTestId('settings-branch').click();
    await page.getByRole('option', { name: 'main' }).click();
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Saved' })).toBeVisible();
    await gotoWorkspace(page, gammaId);
    await expect(page.getByTestId('switcher-chip-main')).toHaveText('main (working branch)');
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await expect(treeRow(page, 'draft-only.txt')).toHaveCount(0);
  });

  await test.step('9. another user sees none of it (AC-5)', async () => {
    const other = await WhApi.create(stand.url);
    try {
      await signIn(stand, other, uniqueEmail('other'));
      expect(await other.expectStatus<unknown[]>('GET', '/api/v1/workspaces', 200)).toEqual([]);
      const urls = [
        `/api/v1/workspaces/${alphaId}`,
        `/api/v1/workspaces/${alphaId}/workstreams`,
        `/api/v1/workspaces/${alphaId}/views/main/fs/list?dir=`,
        `/api/v1/workspaces/${alphaId}/views/${alphaStreamId}/fs/list?dir=`,
        `/api/v1/workstreams/${alphaStreamId}/recording/meta`,
      ];
      for (const url of urls) {
        const r = await other.get(url);
        expect(r.status, url).toBe(404);
        expect(r.body, url).toMatchObject({ error: 'not_found' });
      }
      const close = await other.post(`/api/v1/workstreams/${alphaStreamId}/close/check`);
      expect(close.status).toBe(404);

      const otherPage = await signedInPage(browser, stand, other);
      await otherPage.page.goto('/#/');
      await expect(otherPage.page.getByTestId('workspaces-empty')).toBeVisible();
      await otherPage.page.goto(`/#/w/${alphaId}`);
      await expect(otherPage.page.getByText("This item doesn't exist or isn't yours.")).toBeVisible();
      await otherPage.page.goto(`/#/w/${alphaId}/s/${alphaStreamId}`);
      await expect(otherPage.page.getByText("This item doesn't exist or isn't yours.")).toBeVisible();
      expect(otherPage.offOrigin).toEqual([]);
      await otherPage.context.close();
    } finally {
      await other.dispose();
    }
  });

  await test.step('10. delete: Cancel keeps it, Delete removes every Docker object (AC-8a)', async () => {
    await page.goto('/#/');
    const card = page.locator(`[data-testid="workspace-card"][data-workspace-id="${alphaId}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId('workspace-delete').click();
    const dialog = page.getByTestId('delete-workspace-dialog');
    await expect(dialog).toContainText('Delete Alpha?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeVisible();
    expect((await getWorkspace(api, alphaId)).name).toBe('Alpha');
    expect(objectsOfWorkspace(alphaId).containers.length).toBeGreaterThan(0);
    // The workstream's files are a folder inside the workspace's folder (AC-3b).
    const dir = workspaceFolder(stand.dataDir, me.email, 'alpha', alphaId);
    const streams = fs.readdirSync(path.join(dir, 'workstreams'));
    const streamDir = streams.find((d) => d.endsWith(`-${alphaStreamId.slice(0, 6)}`));
    expect(streamDir).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'workstreams', streamDir!, 'workspace', 'worktree', '.gitignore'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'workstreams', streamDir!, 'workstream.json'), 'utf8'))).toMatchObject({
      id: alphaStreamId,
    });

    await card.getByTestId('workspace-delete').click();
    await page.getByTestId('delete-workspace-confirm').click();
    await expect(dialog).toHaveCount(0, { timeout: 120_000 });
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('workspace-card')).toHaveCount(2);
    expect((await api.get(`/api/v1/workspaces/${alphaId}`)).status).toBe(404);
    expect(objectsOfWorkspace(alphaId)).toEqual({ containers: [], volumes: [], images: [], byName: [] });
    expect(fs.existsSync(workspaceFolder(stand.dataDir, me.email, 'alpha', alphaId))).toBe(false);
    expect(dockerTry(['inspect', `wh-st-${alphaStreamId}`]).status).not.toBe(0);
  });

  await test.step('11. every request stayed on the stand origin (AC-30)', async () => {
    expect(await backgroundOf(page, 'body')).toBe(WHITE);
    expect(offOrigin).toEqual([]);
  });

  await context.close();
});
