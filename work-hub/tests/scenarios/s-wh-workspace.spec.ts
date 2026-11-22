// @S-WH-02 — workspaces: create, name rules, agent login (one per user: new, inherited by a second
// workspace, logout from Settings, "Not now"), where the token is kept, what a container commit
// leaks, settings (working branch), isolation between users and delete (AC-5, AC-8–AC-10, AC-19,
// AC-20–AC-20c, AC-20e, AC-30, AC-31) and the file area on the host (AC-3b); then remote
// repositories through the git proxy: clone, no secret anywhere, attach, grants and another user's
// container (FR-3–FR-6).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  appendInEditor,
  attachRemote,
  createPatConnection,
  createWorkspace,
  docker,
  dockerExec,
  dockerTry,
  EDITOR,
  expect,
  FAKE_GIT_HTTP,
  FAKE_PAT,
  fakeLoginInUi,
  getWorkspace,
  gitIn,
  gitMain,
  gotoWorkspace,
  openFromTree,
  openWorkstreamInUi,
  paintedBackground,
  restartServer,
  say,
  setGrants,
  signedInPage,
  signIn,
  test,
  TERMINAL,
  treeRow,
  uniqueEmail,
  WhApi,
  workspaceContainer,
  workstreamContainer,
  type Connection,
  type Remote,
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

/** A part of the fake agent's token (tests/fake-agent/claude.mjs `FAKE_TOKEN`). */
const FAKE_TOKEN_MARK = 'Fake_Work-Hub-token_';

/**
 * Files under `root` (paths relative to it) whose bytes contain `needle`, except those `skip`
 * accepts. Only regular files are read; symbolic links are not followed.
 */
function filesContaining(root: string, needle: string, skip: (rel: string) => boolean): string[] {
  const found: string[] = [];
  const mark = Buffer.from(needle, 'utf8');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && !skip(rel) && fs.readFileSync(abs).includes(mark)) found.push(rel);
    }
  };
  walk(root);
  return found;
}

async function backgroundOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
}

test('@S-WH-02 @mode-a workspaces, agent login, settings and delete', async ({ browser, stand, api }) => {
  const me = await signIn(stand, api);
  const { context, page, offOrigin } = await signedInPage(browser, stand, api);

  let alphaId = '';
  let betaId = '';
  let gammaId = '';

  await test.step('3a. a user without a login is asked for it; nothing to copy; a fake login works (AC-19)', async () => {
    await startCreate(page, 'Alpha');
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('agent-login-new')).toBeEnabled();
    await expect(page.getByText('Copy from my workspace')).toHaveCount(0);
    await expect(page.getByTestId('agent-login-sources')).toHaveCount(0);
    await fakeLoginInUi(page);
    await expect(page.getByTestId('toast').filter({ hasText: /^Logged in to / })).toBeVisible({ timeout: 60_000 });
    alphaId = await workspaceIdFromUrl(page);
    await expect(page.getByTestId('agent-login-dialog')).toHaveCount(0);
    await expect(page.getByTestId('login-banner')).toHaveCount(0);
    expect((await getWorkspace(api, alphaId)).loginState).toBe('ok');
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

    // The dialog starts on "Empty repository": a name is all it asks for (cloning is step 12).
    await page.goto('/#/');
    await page.getByTestId('new-workspace').click();
    const dialog = page.getByTestId('new-workspace-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('new-workspace-start-empty')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByTestId('clone-source')).toHaveCount(0);
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

  await test.step('4. a second workspace is logged in without any step (AC-20)', async () => {
    await startCreate(page, 'Beta');
    betaId = await workspaceIdFromUrl(page);
    await expect(treeRow(page, '.gitignore')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('agent-login-dialog')).toHaveCount(0);
    await expect(page.getByTestId('login-banner')).toHaveCount(0);
    expect((await getWorkspace(api, betaId)).loginState).toBe('ok');
  });

  let alphaStreamId = '';
  await test.step('5. the agent answers; the token is only in the secret store (AC-20, AC-20a, AC-31)', async () => {
    await gotoWorkspace(page, alphaId);
    const stream = await openWorkstreamInUi(page, api, alphaId, 'Sign out');
    alphaStreamId = stream.id;
    await say(page, 'hello', 'You said: hello');

    // AC-31: the page and the terminal are white.
    expect(await backgroundOf(page, 'body')).toBe(WHITE);
    expect(await paintedBackground(page, `${TERMINAL} .xterm`)).toBe(WHITE);

    // AC-20: no file of the data directory but secrets/*.enc holds the token (homes, repos,
    // recordings included), and no container file does either.
    const leaks = filesContaining(stand.dataDir, FAKE_TOKEN_MARK, (rel) => /^secrets[\\/].*\.enc$/.test(rel));
    expect(leaks).toEqual([]);
    for (const container of [workspaceContainer(alphaId), workspaceContainer(betaId), workstreamContainer(alphaStreamId)]) {
      const probe = dockerExec(container, [
        'sh', '-c',
        `grep -rlsI -D skip ${FAKE_TOKEN_MARK} "$HOME" /workspace /tmp; test -e /tmp/wh-login.raw && echo raw; echo checked`,
      ]);
      expect(probe.stdout.trim(), container).toBe('checked');
    }
  });

  await test.step('6. Settings: "Log out of" — Cancel keeps it, Log out logs every workspace out (AC-20e)', async () => {
    await page.goto(`/#/w/${alphaId}/settings`);
    await expect(page.getByTestId('settings-login-state')).toHaveText('Logged in');
    const confirm = page.getByRole('dialog').filter({ hasText: 'Log out of' });

    await page.getByTestId('settings-logout').click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('settings-login-state')).toHaveText('Logged in');
    expect((await getWorkspace(api, alphaId)).loginState).toBe('ok');

    await page.getByTestId('settings-logout').click();
    await confirm.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByTestId('toast').filter({ hasText: /^Logged out of / })).toBeVisible();
    await expect(page.getByTestId('settings-login-state')).toHaveText('Not logged in');
    await expect(page.getByTestId('settings-logout')).toHaveCount(0);
    expect((await getWorkspace(api, alphaId)).loginState).toBe('missing');
    // One login per user: the other workspace is logged out too.
    expect((await getWorkspace(api, betaId)).loginState).toBe('missing');

    // Reopen the workspace from the list: the login question is back.
    await page.goto('/#/');
    await page
      .locator(`[data-testid="workspace-card"][data-workspace-id="${alphaId}"]`)
      .getByRole('link', { name: 'Open' })
      .click();
    await expect(page.getByTestId('login-banner')).toBeVisible();
    await expect(page.getByTestId('login-banner')).toContainText('This workspace needs a');
  });

  await test.step('7. "Not now": files still open and save; a workstream asks for the login (AC-20b)', async () => {
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

  await test.step('7b. a commit of the workspace container holds no project files and no login (AC-20c)', async () => {
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

  // Steps 12–17: remote repositories through the git proxy and the stand's fake git host (FR-3–FR-6).
  const conn = await createPatConnection(api, 'Fake host');
  let clonedId = '';

  await test.step('12. clone from a token connection on branch dev (FR-4)', async () => {
    await page.goto('/#/');
    await page.getByTestId('new-workspace').click();
    await page.getByTestId('new-workspace-name').fill('Cloned');
    await page.getByTestId('new-workspace-start-clone').click();
    await page.getByTestId('clone-connection').click();
    await page.getByRole('option', { name: /^Fake host · / }).click();
    await page.getByTestId('clone-url').fill(FAKE_GIT_HTTP);
    await page.getByTestId('clone-url').blur();
    await expect(page.getByTestId('clone-branch')).toContainText('main', { timeout: 120_000 });
    await page.getByTestId('clone-branch').click();
    await page.getByRole('option', { name: 'dev', exact: true }).click();
    await page.getByTestId('new-workspace-create').click();
    // The user logged out in step 6: the login question follows the clone.
    await expect(page.getByTestId('agent-login-dialog')).toBeVisible({ timeout: 300_000 });
    await page.getByTestId('agent-login-not-now').click();
    clonedId = await workspaceIdFromUrl(page);
    await expect(treeRow(page, 'DEV.md')).toBeVisible({ timeout: 60_000 });

    expect((await getWorkspace(api, clonedId)).workingBranch).toBe('dev');
    expect(gitMain(clonedId, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()).toBe('dev');
    expect(gitMain(clonedId, ['log', '-1', '--format=%s']).stdout.trim()).toBe('Dev branch');
    const remotes = await api.expectStatus<Remote[]>('GET', `/api/v1/workspaces/${clonedId}/remotes`, 200);
    expect(remotes).toEqual([
      expect.objectContaining({ name: 'origin', connectionId: conn.id, url: FAKE_GIT_HTTP, defaultBranch: 'main' }),
    ]);
    expect(gitMain(clonedId, ['remote', 'get-url', 'origin']).stdout.trim()).toBe(`http://wh-git/git/${remotes[0].id}.git`);
    const granted = await api.expectStatus<Connection>('GET', `/api/v1/connections/${conn.id}`, 200);
    expect(granted.grants.map((g) => g.workspaceId)).toEqual([clonedId]);
  });

  await test.step('13. no secret in the container, its commit or the host folders; the capability only in /tmp (FR-3, FR-4)', async () => {
    const container = workspaceContainer(clonedId);
    const env = dockerExec(container, ['env']).stdout;
    expect(env).not.toContain(FAKE_PAT);
    const config = gitMain(clonedId, ['config', '-l']).stdout;
    expect(config).not.toContain(FAKE_PAT);
    expect(config).toContain('credential.http://wh-git.helper=');
    const probe = dockerExec(container, ['sh', '-c', `grep -rlsI -D skip ${FAKE_PAT} "$HOME" /workspace /tmp; echo checked`]);
    expect(probe.stdout.trim()).toBe('checked');
    // Host folders of the workspace, the homes and the recordings.
    expect(filesContaining(stand.dataDir, FAKE_PAT, (rel) => /^secrets[\\/].*\.enc$/.test(rel))).toEqual([]);

    // The capability: mode 0600 in the container's /tmp, and nowhere else.
    expect(dockerExec(container, ['stat', '-c', '%a', '/tmp/wh-git-capability']).stdout.trim()).toBe('600');
    const capability = dockerExec(container, ['cat', '/tmp/wh-git-capability']).stdout.trim();
    expect(capability.length).toBeGreaterThan(20);
    expect(env).not.toContain(capability);
    expect(config).not.toContain(capability);
    const capProbe = dockerExec(container, ['sh', '-c', `grep -rlsF -D skip ${capability} "$HOME" /workspace; echo checked`]);
    expect(capProbe.stdout.trim()).toBe('checked');
    expect(filesContaining(stand.dataDir, capability, () => false)).toEqual([]);

    // A commit of the container (what a checkpoint image would hold) has neither.
    const tag = `whs-scenario-commit:${crypto.randomBytes(4).toString('hex')}`;
    docker(['commit', container, tag]);
    try {
      const inImage = dockerTry([
        'run', '--rm', '--entrypoint', 'sh', tag, '-c',
        `grep -rlsI -D skip -e ${FAKE_PAT} -e ${capability} /home /root /workspace /tmp /etc; test -e /tmp/wh-git-capability && echo capability; echo checked`,
      ]);
      expect(inImage.status, inImage.stderr).toBe(0);
      expect(inImage.stdout.trim()).toBe('checked');
    } finally {
      dockerTry(['image', 'rm', '-f', tag]);
    }
  });

  await test.step('14. a wrong URL creates no workspace (FR-4)', async () => {
    const before = await api.expectStatus<{ id: string }[]>('GET', '/api/v1/workspaces', 200);
    await page.goto('/#/');
    await page.getByTestId('new-workspace').click();
    await page.getByTestId('new-workspace-name').fill('Wrong');
    await page.getByTestId('new-workspace-start-clone').click();
    await page.getByTestId('clone-connection').click();
    await page.getByRole('option', { name: /^Fake host · / }).click();
    await page.getByTestId('clone-url').fill('http://other.test/git/app.git');
    await page.getByTestId('new-workspace-create').click();
    await expect(page.getByTestId('clone-source-error')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('new-workspace-name')).toHaveValue('Wrong');
    await page.getByTestId('new-workspace-dialog').getByRole('button', { name: 'Cancel' }).click();

    const missing = await api.post('/api/v1/workspaces', {
      name: 'Missing',
      source: { connectionId: conn.id, url: 'http://git.test/git/missing.git', branch: null },
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    const after = await api.expectStatus<{ id: string }[]>('GET', '/api/v1/workspaces', 200);
    expect(after.map((w) => w.id).sort()).toEqual(before.map((w) => w.id).sort());
    const folders = fs.readdirSync(path.join(stand.dataDir, 'users', me.email.toLowerCase()));
    expect(folders.filter((f) => f.startsWith('wrong-') || f.startsWith('missing-'))).toEqual([]);
  });

  let second: Connection | null = null;
  await test.step('15. attach a remote to an empty workspace, then fetch; a connection not granted here is not offered (FR-5)', async () => {
    second = await createPatConnection(api, 'Fake host 2');
    await gotoWorkspace(page, betaId);
    await expect(treeRow(page, '.gitignore')).toBeVisible({ timeout: 120_000 });
    await page.goto(`/#/w/${betaId}/settings`);
    await expect(page.getByTestId('remotes-empty')).toBeVisible();
    await page.getByTestId('remote-attach').click();
    const attach = page.getByTestId('attach-remote-dialog');
    await expect(attach.getByTestId('attach-remote-name')).toHaveValue('origin');
    const radio = (id: string) => attach.locator(`[data-testid="attach-remote-connection"][data-connection-id="${id}"]`);
    // Neither connection is granted to this workspace yet.
    await expect(radio(conn.id)).toBeDisabled();
    await expect(radio(second.id)).toBeDisabled();
    await radio(conn.id).locator('xpath=ancestor::div[1]').getByTestId('attach-remote-grant').click();
    await expect(radio(conn.id)).toBeEnabled();
    await expect(radio(second.id)).toBeDisabled();
    await radio(conn.id).check();
    await attach.getByTestId('attach-remote-url').fill(FAKE_GIT_HTTP);
    await attach.getByTestId('attach-remote-submit').click();
    await expect(attach).toHaveCount(0);
    await expect(page.getByTestId('remote-card').filter({ hasText: 'origin' })).toBeVisible();

    const fetch = gitMain(betaId, ['fetch', 'origin']);
    expect(fetch.status, fetch.stderr).toBe(0);
    expect(gitMain(betaId, ['rev-parse', '--verify', 'refs/remotes/origin/dev']).status).toBe(0);
  });

  await test.step('16. a remote whose connection is no longer granted cannot fetch: "no grant" (FR-5)', async () => {
    if (!second) throw new Error('step 15 did not create the second connection');
    await setGrants(api, second.id, [betaId]);
    await attachRemote(api, betaId, second.id, { name: 'second' });
    expect(gitMain(betaId, ['fetch', 'second']).status).toBe(0);
    await setGrants(api, second.id, []);
    const fetch = gitMain(betaId, ['fetch', 'second']);
    expect(fetch.status).not.toBe(0);
    expect(fetch.stderr).toContain('Work Hub: this workspace has no grant for the connection of this remote');
    // The remote of the granted connection still works.
    expect(gitMain(betaId, ['fetch', 'origin']).status).toBe(0);
  });

  await test.step("17. another user's container cannot use this user's remote (FR-6)", async () => {
    const [origin] = await api.expectStatus<Remote[]>('GET', `/api/v1/workspaces/${clonedId}/remotes`, 200);
    const other = await WhApi.create(stand.url);
    try {
      await signIn(stand, other, uniqueEmail('intruder'));
      const theirs = await createWorkspace(other, 'Intruder');
      const container = workspaceContainer(theirs.id);
      // Their repo has no remote yet, hence no helper: give git the one Work Hub installs, which
      // sends their container's own capability.
      const helper = `credential.http://wh-git.helper=!f() { test "$1" = get && printf 'username=wh\\npassword=%s\\n' "$(cat /tmp/wh-git-capability)"; }; f`;
      const viaOwnCapability = gitIn(container, '/workspace/repo', ['-c', helper, 'ls-remote', `http://wh-git/git/${origin.id}.git`]);
      expect(viaOwnCapability.status).not.toBe(0);
      expect(viaOwnCapability.stderr).toContain('Work Hub: this workspace has no grant for the connection of this remote');
      const forged = gitIn(container, '/workspace/repo', ['ls-remote', `http://wh:forged@wh-git/git/${origin.id}.git`]);
      expect(forged.status).not.toBe(0);
      expect(forged.stderr).toContain('Work Hub: unknown or revoked capability');
    } finally {
      await other.dispose();
    }
  });

  await test.step('18. every request stayed on the stand origin (AC-30)', async () => {
    expect(await backgroundOf(page, 'body')).toBe(WHITE);
    expect(offOrigin).toEqual([]);
  });

  await context.close();
});
