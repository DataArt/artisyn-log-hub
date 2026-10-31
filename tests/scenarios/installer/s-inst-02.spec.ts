// S-INST-02. Secrets: the key only in the local config, 0o600, a tracked file blocks, a server
// change warns (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INST-02;
// layer «installer (CLI)»; mode A only — the installer does not depend on the auth mode).
//
// Runs on every OS: the design's POSIX-only step 3 (`mode & 0o777 === 0o600`) is checked only on
// POSIX; on Windows it is replaced by «the file is git-ignored» (the installer calls no chmod
// there). Step 6 (a tracked local config aborts) breaks the project for further installs, so it
// runs last. Step 9 (atomic writes under a concurrent reader) is a separate test at the end of the
// file: it found a Windows-only product bug and is pinned there with `test.fail`.
//
// Code facts that differ from the design text:
//   - the destination warning reads `Warning: this changes the telemetry destination:
//     http://a:3000 -> http://b:3000`;
//   - the tracked-file abort happens after the installer has already re-extracted the plugin and
//     rewritten the config files (same content); since hook 2.30.0 the receiver port lives in the
//     per-user `~/.artisyn/otel/port.json` (task 2026-10-30-otel-shared-receiver) and the project
//     has no `otel-port.json` any more, so no file of the project changes.
//
// Replaces:
//   - artisyn-hooks-installer/src/__tests__/install.test.ts — secrets and `config gitignore
//     protection` (4), `CLI flags` reinstall (4: A then B, C wins, trailing slash, warning),
//     `atomic config write under concurrent read` (1), shell-history warning (1), `--server-url`
//     repoints (2)
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import { makeFakeGitRepo, makeFakeHome, tempDirs, writeFakeClaude } from '../helpers/hook-process';
import { filesContaining, readJson, runInstaller, treeHashes, unpackInstaller, USER_SETTINGS, writeClaudeSettings } from '../helpers/installer';

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Scenario', GIT_AUTHOR_EMAIL: 's@arrakis.test', GIT_COMMITTER_NAME: 'Scenario', GIT_COMMITTER_EMAIL: 's@arrakis.test' },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
}

test('@S-INST-02 the API key lives only in log-hub.local.json, a tracked secret file blocks, a new server warns @mode-a', async ({ stand }) => {
  test.setTimeout(300_000);
  const dirs = tempDirs();
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const home = makeFakeHome(dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');
    const repo = makeFakeGitRepo(dirs);
    writeClaudeSettings(repo, USER_SETTINGS);
    const configDir = path.join(repo, '.artisyn', 'config');
    const base = path.join(configDir, 'log-hub.json');
    const local = path.join(configDir, 'log-hub.local.json');
    const install = (args: string[], env: Record<string, string> = {}) =>
      runInstaller(cli, repo, ['install', ...args], { home, fakeClaudeDir: fakeClaude.dir, env });

    const first = await test.step('1. install --server-url http://a:3000 --api-key SECRET-KEY-1 warns about the shell history', async () => {
      const res = await install(['--server-url', 'http://a:3000', '--api-key', 'SECRET-KEY-1']);
      expect(res.code, res.output).toBe(0);
      expect(res.output).toContain('It may be visible in your shell history.');
      return res;
    });

    await test.step('2. SECRET-KEY-1 appears nowhere in the project but log-hub.local.json, nor in the output', async () => {
      expect(filesContaining(repo, 'SECRET-KEY-1')).toEqual(['.artisyn/config/log-hub.local.json']);
      expect(first.output).not.toContain('SECRET-KEY-1');
    });

    await test.step('3. POSIX: log-hub.local.json is 0o600; Windows: no chmod, the file is git-ignored', async () => {
      if (process.platform === 'win32') {
        expect(spawnSync('git', ['check-ignore', '-q', '.artisyn/config/log-hub.local.json'], { cwd: repo }).status).toBe(0);
      } else {
        expect(fs.statSync(local).mode & 0o777).toBe(0o600);
      }
    });

    await test.step('4. git status: log-hub.json is a new file, log-hub.local.json, otel-port.json, .claude/settings.local.json and its .bak are ignored', async () => {
      const status = git(repo, ['status', '--porcelain', '--untracked-files=all']).split(/\r?\n/);
      expect(status).toContain('?? .artisyn/config/log-hub.json');
      expect(status.some((l) => l.includes('log-hub.local.json'))).toBe(false);
      expect(status.some((l) => l.includes('otel-port.json'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json')), 'install wrote the OTEL env there').toBe(true);
      expect(status.some((l) => l.includes('.claude/settings.local.json'))).toBe(false);
      expect(status.some((l) => l.includes('.claude/settings.local.json.bak'))).toBe(false);
    });

    await test.step('5. a root .gitignore that already ignores the file → no duplicate entry; an existing .artisyn/config/.gitignore is appended once', async () => {
      const other = makeFakeGitRepo(dirs);
      fs.mkdirSync(path.join(other, '.claude'));
      fs.writeFileSync(path.join(other, '.gitignore'), 'log-hub.local.json\n');
      const res = await runInstaller(cli, other, ['install', '--api-key', 'K-OTHER'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      const otherIgnore = path.join(other, '.artisyn', 'config', '.gitignore');
      expect(fs.existsSync(otherIgnore) ? lines(otherIgnore) : []).not.toContain('log-hub.local.json');

      const third = makeFakeGitRepo(dirs);
      fs.mkdirSync(path.join(third, '.claude'));
      fs.mkdirSync(path.join(third, '.artisyn', 'config'), { recursive: true });
      fs.writeFileSync(path.join(third, '.artisyn', 'config', '.gitignore'), 'my-own-file');
      for (let i = 0; i < 2; i += 1) {
        const r = await runInstaller(cli, third, ['install', '--api-key', 'K-THIRD'], { home, fakeClaudeDir: fakeClaude.dir });
        expect(r.code, r.output).toBe(0);
      }
      const ignore = lines(path.join(third, '.artisyn', 'config', '.gitignore'));
      expect(ignore[0]).toBe('my-own-file');
      expect(ignore.filter((l) => l === 'log-hub.local.json')).toHaveLength(1);
      expect(ignore, 'no per-project port store since hook 2.30.0').not.toContain('otel-port.json');
    });

    await test.step('7. reinstall with --server-url http://b:3000 only: the destination warning, the key kept, serverUrl = b in log-hub.local.json, log-hub.json untouched; the same URL with a slash → no warning', async () => {
      const res = await install(['--server-url', 'http://b:3000']);
      expect(res.code, res.output).toBe(0);
      expect(res.output).toContain('this changes the telemetry destination: http://a:3000 -> http://b:3000');
      expect(readJson(local).apiKey).toBe('SECRET-KEY-1');
      expect(readJson(local).serverUrl).toBe('http://b:3000');
      expect(readJson(base).serverUrl).toBe('');
      const same = await install(['--server-url', 'http://b:3000/']);
      expect(same.code).toBe(0);
      expect(same.output).not.toContain('changes the telemetry destination');
    });

    await test.step('8. --api-key SECRET-KEY-2 replaces the key, an omitted flag keeps the value, foreign keys in both files survive', async () => {
      fs.writeFileSync(base, JSON.stringify({ ...readJson(base), myKey: 1 }, null, 2));
      fs.writeFileSync(local, JSON.stringify({ ...readJson(local), myKey: 1 }, null, 2));
      const res = await install(['--api-key', 'SECRET-KEY-2']);
      expect(res.code, res.output).toBe(0);
      expect(readJson(local)).toEqual({
        apiKey: 'SECRET-KEY-2',
        serverUrl: 'http://b:3000',
        otelReceiverPort: readJson<{ port: number }>(path.join(home, '.artisyn', 'otel', 'port.json')).port,
        myKey: 1,
      });
      expect(readJson(base).myKey).toBe(1);
      expect(filesContaining(repo, 'SECRET-KEY-1')).toEqual([]);
    });

    // Step 9 (atomic writes under a concurrent reader) is the separate test below: on Windows it
    // fails on a product bug (task Notes), which must not hide the other steps.

    await test.step('10. an apiKey the user put into log-hub.json by mistake is neither moved nor erased, and never printed', async () => {
      fs.writeFileSync(base, JSON.stringify({ ...readJson(base), apiKey: 'MANUAL-KEY-9' }, null, 2));
      const res = await install([]);
      expect(res.code, res.output).toBe(0);
      expect(readJson(base).apiKey).toBe('MANUAL-KEY-9');
      expect(readJson(local).apiKey).toBe('SECRET-KEY-2');
      expect(res.output).not.toContain('MANUAL-KEY-9');
      expect(res.output).not.toContain('SECRET-KEY-2');
    });

    await test.step('6. log-hub.local.json committed with git add -f → install aborts with the git rm --cached hint; no project file changed', async () => {
      git(repo, ['add', '-f', '.artisyn/config/log-hub.local.json']);
      git(repo, ['commit', '-q', '-m', 'oops, the secret']);
      const before = treeHashes(repo);
      const res = await install([]);
      expect(res.code).toBe(1);
      expect(res.output).toContain('git rm --cached .artisyn/config/log-hub.local.json');
      const after = treeHashes(repo);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
      expect(changed).toEqual([]);
    });
  } finally {
    dirs.cleanup();
  }
});

// Step 9. Atomic writes: a hook reading `log-hub.json` while an install rewrites it must never see
// a torn file, and must not make the install fail. The installer writes a temp file and renames it
// over the target. On Windows that rename fails with EPERM while any reader has the target open, so
// the install dies with «Unexpected error: EPERM: operation not permitted, rename …» and leaves a
// `.log-hub.json.tmp-*` behind — a product bug (task Notes), pinned here with `test.fail` until the
// installer retries the rename. Up to ten installs run under the reader so the race is hit
// reliably; on POSIX every one must succeed.
test('@S-INST-02 [step 9] an install under a polling reader neither tears log-hub.json nor fails @mode-a', async ({ stand }) => {
  test.fail(process.platform === 'win32', 'installer atomicWrite: rename over a file a reader holds open fails with EPERM on Windows (task Notes)');
  test.setTimeout(300_000);
  const dirs = tempDirs();
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const home = makeFakeHome(dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');
    const repo = makeFakeGitRepo(dirs);
    fs.mkdirSync(path.join(repo, '.claude'));
    const base = path.join(repo, '.artisyn', 'config', 'log-hub.json');
    const install = (url: string) =>
      runInstaller(cli, repo, ['install', '--server-url', url, '--api-key', 'K-ATOMIC'], { home, fakeClaudeDir: fakeClaude.dir });
    const seed = await install('http://a:3000');
    expect(seed.code, seed.output).toBe(0);

    let reads = 0;
    let torn = 0;
    let done = false;
    const poll = (async () => {
      while (!done) {
        let raw: string | null = null;
        try {
          raw = fs.readFileSync(base, 'utf8');
        } catch {
          raw = null; // a missing file is not a torn read
        }
        if (raw !== null) {
          reads += 1;
          try {
            JSON.parse(raw);
          } catch {
            torn += 1;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const failures: string[] = [];
    try {
      for (let i = 0; i < 10 && failures.length === 0; i += 1) {
        const res = await install(i % 2 === 0 ? 'http://b:3000' : 'http://a:3000');
        if (res.code !== 0) failures.push(res.output.trim());
      }
    } finally {
      done = true;
      await poll;
    }
    expect(reads).toBeGreaterThan(0);
    expect(torn, 'no torn read').toBe(0);
    expect(failures, 'every install under the reader succeeds').toEqual([]);
  } finally {
    dirs.cleanup();
  }
});
