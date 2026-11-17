// @S-WH-03 — the IDE's files: tabs, save as one commit, images, changes on disk, the workstream
// view, drop from the computer, drag out and download, move inside the tree (AC-11, AC-12–AC-12b,
// AC-15–AC-18).
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import {
  appendInEditor,
  dockerExec,
  EDITOR,
  editorText,
  expect,
  gitMain,
  gotoWorkspace,
  openFromTree,
  openWorkstreamInUi,
  say,
  signedInPage,
  signIn,
  test,
  treeRow,
  workspaceContainer,
  workspaceWithFakeLogin,
} from './fixtures';

test.describe.configure({ timeout: 1_200_000 });

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const fileTab = (page: Page, path: string) => page.locator(`[data-testid="file-tab"][data-path="${path}"]`);

/** Runs `script` with `sh -c` in the workspace's checkout. */
function shMain(workspaceId: string, script: string): void {
  const r = dockerExec(workspaceContainer(workspaceId), ['sh', '-c', script], { workdir: '/workspace/repo' });
  if (r.status !== 0) throw new Error(`sh -c ${script}: ${r.stderr}`);
}

const commitCount = (workspaceId: string) => Number(gitMain(workspaceId, ['rev-list', '--count', 'HEAD']).stdout.trim());
const showMain = (workspaceId: string, path: string) =>
  dockerExec(workspaceContainer(workspaceId), ['cat', `/workspace/repo/${path}`]).stdout;

interface FakeFile {
  name: string;
  text: string;
}
interface FakeDir {
  name: string;
  children: (FakeFile | FakeDir)[];
}

/**
 * Drops files and folders "from the computer" on the tree row of `targetPath`: a real
 * DataTransfer carries the files (so its types hold "Files"), and its `items` answer
 * `webkitGetAsEntry()` with file and directory entries, as Chromium does for an OS drop.
 */
async function dropFromComputer(page: Page, targetPath: string, entries: (FakeFile | FakeDir)[]): Promise<void> {
  const target = treeRow(page, targetPath);
  await expect(target).toBeVisible();
  await target.evaluate((el, tree) => {
    type Node = { name: string; text?: string; children?: Node[] };
    const dt = new DataTransfer();
    const toEntry = (node: Node, prefix: string): unknown => {
      const fullPath = `${prefix}/${node.name}`;
      if (node.children === undefined) {
        const file = new File([node.text ?? ''], node.name, { type: 'text/plain' });
        dt.items.add(file);
        return {
          isFile: true,
          isDirectory: false,
          name: node.name,
          fullPath,
          file: (ok: (f: File) => void) => ok(file),
        };
      }
      const children = node.children.map((c) => toEntry(c, fullPath));
      return {
        isFile: false,
        isDirectory: true,
        name: node.name,
        fullPath,
        createReader: () => {
          let done = false;
          return {
            readEntries: (ok: (batch: unknown[]) => void) => {
              // Asynchronous, as the browser's: the caller asks again from inside the callback.
              const batch = done ? [] : children;
              done = true;
              setTimeout(() => ok(batch), 0);
            },
          };
        },
      };
    };
    const top = (tree as Node[]).map((n) => toEntry(n, ''));
    const items = top.map((entry) => ({ kind: 'file', type: '', webkitGetAsEntry: () => entry, getAsFile: () => null }));
    Object.defineProperty(dt, 'items', { value: items });
    const fire = (type: string) =>
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire('dragenter');
    fire('dragover');
    fire('drop');
  }, entries);
}

test('@S-WH-03 @mode-a files in the IDE', async ({ browser, stand, api }) => {
  await signIn(stand, api);
  const ws = await workspaceWithFakeLogin(api, 'Files');
  const { context, page, offOrigin } = await signedInPage(browser, stand, api);
  await gotoWorkspace(page, ws.id);

  await test.step('1. a click opens a tab; a second click focuses it (AC-11)', async () => {
    await openFromTree(page, '.gitignore');
    await expect.poll(() => editorText(page)).toContain('node_modules/');
    await treeRow(page, '.devcontainer').click();
    await openFromTree(page, '.devcontainer/devcontainer.json');
    await openFromTree(page, '.gitignore');
    await expect(fileTab(page, '.gitignore')).toHaveCount(1);
    await expect(page.getByTestId('file-tab')).toHaveCount(2);
  });

  await test.step('2. Save commits that file only and keeps other changes (AC-12, AC-12a)', async () => {
    shMain(ws.id, 'echo scratch > scratch.txt');
    const before = commitCount(ws.id);
    await appendInEditor(page, '\n# saved from the IDE');
    await expect(fileTab(page, '.gitignore')).toHaveAttribute('data-dirty', 'true');
    // One Save button, whatever is open.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(1);
    await page.locator(EDITOR).getByTestId('editor-save').click();
    await expect(fileTab(page, '.gitignore')).not.toHaveAttribute('data-dirty', 'true');

    expect(commitCount(ws.id)).toBe(before + 1);
    const stat = gitMain(ws.id, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim().split('\n');
    expect(stat).toEqual(['.gitignore']);
    expect(gitMain(ws.id, ['status', '--porcelain']).stdout).toContain('?? scratch.txt');

    await page.reload();
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await openFromTree(page, '.gitignore');
    await expect.poll(() => editorText(page)).toContain('# saved from the IDE');
  });

  await test.step('3. an uploaded PNG opens as an image (AC-12)', async () => {
    const r = await api.ctx.post(`/api/v1/workspaces/${ws.id}/views/main/fs/upload?dir=&overwrite=0`, {
      multipart: { files: { name: 'pixel.png', mimeType: 'image/png', buffer: PNG } },
      failOnStatusCode: false,
    });
    expect(r.status()).toBe(200);
    await expect(treeRow(page, 'pixel.png')).toBeVisible({ timeout: 10_000 });
    await openFromTree(page, 'pixel.png');
    await expect(page.locator('[data-testid="image-tab"]:visible img')).toBeVisible();
    await expect(page.locator('[data-testid="editor-tab"]:visible')).toHaveCount(0);
  });

  await test.step('4. changes on disk: a clean tab reloads, a dirty one asks (AC-12b)', async () => {
    await openFromTree(page, '.gitignore');
    shMain(ws.id, "printf '# from the CLI 1\\n' >> .gitignore");
    await expect.poll(() => editorText(page), { timeout: 5_000 }).toContain('# from the CLI 1');
    await expect(fileTab(page, '.gitignore')).not.toHaveAttribute('data-dirty', 'true');

    // Dirty + changed on disk → the banner; Save is refused until a choice is made.
    await appendInEditor(page, '\n# mine A');
    shMain(ws.id, "printf '# from the CLI 2\\n' >> .gitignore");
    const banner = page.locator(EDITOR).getByTestId('changed-on-disk-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await page.locator(EDITOR).getByTestId('editor-save').click();
    await expect(banner).toBeVisible();
    await expect.poll(() => showMain(ws.id, '.gitignore')).toContain('# from the CLI 2');
    expect(showMain(ws.id, '.gitignore')).not.toContain('# mine A');

    // Keep mine: the editor's text wins.
    await page.locator(EDITOR).getByTestId('keep-mine').click();
    await expect(banner).toHaveCount(0);
    await expect(fileTab(page, '.gitignore')).not.toHaveAttribute('data-dirty', 'true');
    expect(showMain(ws.id, '.gitignore')).toContain('# mine A');
    expect(gitMain(ws.id, ['log', '-1', '--format=%s']).stdout.trim()).toBe('Edit .gitignore');

    // Take theirs: the disk wins.
    await appendInEditor(page, '\n# mine B');
    shMain(ws.id, "printf '# from the CLI 3\\n' >> .gitignore");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await page.locator(EDITOR).getByTestId('take-theirs').click();
    await expect(banner).toHaveCount(0);
    await expect.poll(() => editorText(page)).toContain('# from the CLI 3');
    expect(await editorText(page)).not.toContain('# mine B');
    await expect(fileTab(page, '.gitignore')).not.toHaveAttribute('data-dirty', 'true');
  });

  await test.step('5. agent files show in the workstream view only (AC-15)', async () => {
    const stream = await openWorkstreamInUi(page, api, ws.id, 'Notes');
    await say(page, 'make notes.md x', 'Wrote notes.md');
    await expect(treeRow(page, 'notes.md')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('switcher-chip-main').click();
    await expect(page).toHaveURL(new RegExp(`#/w/${ws.id}$`));
    await expect(treeRow(page, '.gitignore')).toBeVisible();
    await expect(treeRow(page, 'notes.md')).toHaveCount(0);
    await page.locator(`[data-testid="switcher-chip"][data-stream-id="${stream.id}"]`).click();
    await expect(treeRow(page, 'notes.md')).toBeVisible();
    await page.getByTestId('switcher-chip-main').click();
    await expect(treeRow(page, '.gitignore')).toBeVisible();
  });

  await test.step('6. drop a file and a folder from the computer; a second drop asks (AC-16, AC-16a)', async () => {
    shMain(ws.id, 'mkdir -p docs && echo docs > docs/README.md && git add docs && git commit -q -m docs');
    await expect(treeRow(page, 'docs')).toBeVisible({ timeout: 10_000 });
    const before = commitCount(ws.id);
    await dropFromComputer(page, 'docs', [
      { name: 'drop-a.txt', text: 'A' },
      { name: 'pack', children: [{ name: 'inner.txt', text: 'I' }, { name: 'sub', children: [{ name: 'deep.txt', text: 'D' }] }] },
    ]);
    await expect(treeRow(page, 'docs/drop-a.txt')).toBeVisible({ timeout: 15_000 });
    await expect(treeRow(page, 'docs/pack')).toBeVisible();
    expect(commitCount(ws.id)).toBe(before + 1);
    const committed = gitMain(ws.id, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim().split('\n').sort();
    expect(committed).toEqual(['docs/drop-a.txt', 'docs/pack/inner.txt', 'docs/pack/sub/deep.txt']);
    expect(showMain(ws.id, 'docs/pack/sub/deep.txt')).toBe('D');

    await dropFromComputer(page, 'docs', [{ name: 'drop-a.txt', text: 'A2' }]);
    const dialog = page.getByTestId('overwrite-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('overwrite-paths')).toContainText('docs/drop-a.txt');
    await page.getByTestId('overwrite-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(commitCount(ws.id)).toBe(before + 1);
    expect(showMain(ws.id, 'docs/drop-a.txt')).toBe('A');
  });

  await test.step('7. drag out carries a DownloadURL; "Download" saves files and folders (AC-17)', async () => {
    const downloadUrl = await treeRow(page, 'docs/drop-a.txt').evaluate((el) => {
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return dt.getData('DownloadURL');
    });
    expect(downloadUrl).toMatch(
      new RegExp(`^application/octet-stream:drop-a\\.txt:${stand.url.replace(/[.]/g, '\\.')}/api/v1/workspaces/${ws.id}/views/main/fs/download\\?`),
    );

    await treeRow(page, 'docs/drop-a.txt').click({ button: 'right' });
    const [fileDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tree-download').click()]);
    expect(fileDl.suggestedFilename()).toBe('drop-a.txt');
    expect(fs.readFileSync(await fileDl.path(), 'utf8')).toBe('A');

    await treeRow(page, 'docs/pack').click({ button: 'right' });
    const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tree-download').click()]);
    expect(zipDl.suggestedFilename()).toBe('pack.zip');
    const zip = fs.readFileSync(await zipDl.path());
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(zip.toString('latin1')).toContain('deep.txt');
  });

  await test.step('8. a drag inside the tree moves a file in one commit; its tab follows (AC-18)', async () => {
    await openFromTree(page, 'docs/drop-a.txt');
    const before = commitCount(ws.id);
    if ((await treeRow(page, '.devcontainer').getAttribute('aria-expanded')) !== 'true') {
      await treeRow(page, '.devcontainer').click();
    }
    await expect(treeRow(page, '.devcontainer/devcontainer.json')).toBeVisible();
    await treeRow(page, 'docs/drop-a.txt').dragTo(treeRow(page, '.devcontainer'));
    await expect(treeRow(page, '.devcontainer/drop-a.txt')).toBeVisible({ timeout: 15_000 });
    await expect(treeRow(page, 'docs/drop-a.txt')).toHaveCount(0);
    await expect(fileTab(page, '.devcontainer/drop-a.txt')).toHaveCount(1);
    await expect(fileTab(page, 'docs/drop-a.txt')).toHaveCount(0);
    expect(commitCount(ws.id)).toBe(before + 1);
    expect(gitMain(ws.id, ['log', '-1', '--format=%s']).stdout.trim()).toBe('Move docs/drop-a.txt to .devcontainer/drop-a.txt');
  });

  expect(offOrigin).toEqual([]);
  await context.close();
});
