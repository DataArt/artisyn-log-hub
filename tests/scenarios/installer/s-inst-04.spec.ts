// S-INST-04. Uninstall cuts out only its own and breaks nothing of the user's
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INST-04; layer «installer
// (CLI)»; mode A only — the installer does not depend on the auth mode).
//
// The project starts as S-INST-01's plus the user's `env.MY_VAR`, and a hook group that mixes an
// entry of the pre-plugin installer with the user's own hook under the same matcher (the S-INST-03
// migration case, design step 7): install removes the legacy entry, and uninstall must leave the
// user's one where it is.
//
// Code facts that differ from the design text:
//   - every uninstall that finds `.claude/settings.json` rewrites `.claude/settings.json.bak` with
//     the file's current content, so a repeated uninstall changes nothing but that backup (step 5);
//   - the [win] lock of step 4 holds `plugin.json` open with `FileShare.None` from PowerShell; on
//     POSIX the plugin directory is made read-only (0o500) instead, which needs a non-root user.
//
// Replaces:
//   - artisyn-hooks-installer/src/__tests__/install.test.ts — `uninstall subcommand` (2), uninstall
//     of `OTEL port allocation, env block and uninstall` (2)
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '../fixtures';
import { makeFakeGitRepo, makeFakeHome, pluginRoot, tempDirs, writeFakeClaude } from '../helpers/hook-process';
import {
  fakeClaudeCalls,
  readJson,
  runInstaller,
  treeHashes,
  unpackInstaller,
  USER_SETTINGS,
  writeClaudeSettings,
} from '../helpers/installer';

const USER_POST_HOOK = { type: 'command', command: 'my-post-hook.sh' };
const COLLECTOR = 'https://collector.corp:4318/v1/logs';

/** USER_SETTINGS plus env.MY_VAR and a PostToolUse group shared with a pre-plugin installer entry. */
function startingSettings(): Record<string, unknown> {
  return {
    ...USER_SETTINGS,
    hooks: {
      ...USER_SETTINGS.hooks,
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node .claude/telemetry_tool/lifecycle-hook.js' }, USER_POST_HOOK] }],
    },
    env: { MY_VAR: '1' },
  };
}

/** The user's part of the settings after install removed the legacy entry. */
const USER_HOOKS_AFTER_INSTALL = {
  ...USER_SETTINGS.hooks,
  PostToolUse: [{ matcher: '*', hooks: [USER_POST_HOOK] }],
};

/** [win] Holds `file` open with FileShare.None until the returned release() is called. */
async function lockFileWindows(file: string, marker: string): Promise<() => Promise<void>> {
  const script =
    `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); ` +
    `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value locked; Start-Sleep -Seconds 60`;
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise<void>((resolve) => proc.on('close', () => resolve()));
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(marker)) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('PowerShell did not take the file lock within 15 s');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return async () => {
    proc.kill();
    await closed;
  };
}

test('@S-INST-04 uninstall removes only the installer’s files and keys and keeps everything of the user @mode-a', async ({ stand }) => {
  test.setTimeout(240_000);
  const dirs = tempDirs();
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const home = makeFakeHome(dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');
    const run = (cwd: string, args: string[]) => runInstaller(cli, cwd, args, { home, fakeClaudeDir: fakeClaude.dir });

    const repo = makeFakeGitRepo(dirs);
    const settingsFile = writeClaudeSettings(repo, startingSettings());
    const installed = await run(repo, ['install', '--server-url', 'http://127.0.0.1:9', '--api-key', 'K-UNINSTALL']);
    expect(installed.code, installed.output).toBe(0);
    expect(readJson(settingsFile).hooks, 'install dropped only the legacy entry').toEqual(USER_HOOKS_AFTER_INSTALL);
    const callsAfterInstall = fakeClaudeCalls(fakeClaude.callsLog).length;

    await test.step('1. uninstall: .artisyn/marketplace and .artisyn/config (otel-port.json too) are gone, the plugin keys are removed', async () => {
      const res = await run(repo, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(fs.existsSync(path.join(repo, '.artisyn', 'marketplace'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.artisyn', 'config'))).toBe(false);
      const settings = readJson(settingsFile);
      expect(settings).not.toHaveProperty('enabledPlugins');
      expect(settings).not.toHaveProperty('extraKnownMarketplaces');
    });

    await test.step('2 (with 7). the user’s permissions, hooks (the one sharing the installer’s matcher group included), customKey and env.MY_VAR byte for byte; the nine OTEL keys gone', async () => {
      const settings = readJson(settingsFile);
      expect(JSON.stringify(settings.permissions)).toBe(JSON.stringify(USER_SETTINGS.permissions));
      expect(JSON.stringify(settings.hooks)).toBe(JSON.stringify(USER_HOOKS_AFTER_INSTALL));
      expect(JSON.stringify(settings.customKey)).toBe(JSON.stringify(USER_SETTINGS.customKey));
      expect(settings.env).toEqual({ MY_VAR: '1' });
    });

    await test.step('5. a second uninstall on a clean project: exit 0, nothing changes but the settings backup', async () => {
      const before = treeHashes(repo);
      const res = await run(repo, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(res.output).not.toMatch(/Unexpected error|TypeError|ENOENT/);
      const after = treeHashes(repo);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
      expect(changed.filter((k) => k !== '.claude/settings.json.bak')).toEqual([]);
    });

    await test.step('6. after uninstall no hook script remains to run, and uninstall never called claude', async () => {
      expect(fs.existsSync(path.join(pluginRoot(repo), 'scripts', 'send-logs-hook.js'))).toBe(false);
      expect(fakeClaudeCalls(fakeClaude.callsLog)).toHaveLength(callsAfterInstall);
    });

    await test.step('3. the user re-pointed the OTEL logs endpoint to their own collector: env stays untouched and a Note says so', async () => {
      const other = makeFakeGitRepo(dirs);
      const otherSettings = writeClaudeSettings(other, { ...USER_SETTINGS, env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: COLLECTOR } });
      const inst = await run(other, ['install', '--api-key', 'K-COLLECTOR']);
      expect(inst.code, inst.output).toBe(0);
      const envAfterInstall = readJson(otherSettings).env;
      expect((envAfterInstall as Record<string, string>).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'install keeps the user value').toBe(COLLECTOR);
      const res = await run(other, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(JSON.stringify(readJson(otherSettings).env)).toBe(JSON.stringify(envAfterInstall));
      expect(res.stdout).toContain(`Note: .claude/settings.json env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is "${COLLECTOR}"`);
    });

    await test.step('4. a plugin file that cannot be deleted: settings are still cleaned, a warning names the leftover; the next uninstall removes it', async () => {
      const locked = makeFakeGitRepo(dirs);
      const lockedSettings = writeClaudeSettings(locked, USER_SETTINGS);
      const inst = await run(locked, ['install', '--api-key', 'K-LOCK']);
      expect(inst.code, inst.output).toBe(0);
      const plugin = pluginRoot(locked);
      let release: () => Promise<void>;
      if (process.platform === 'win32') {
        release = await lockFileWindows(path.join(plugin, '.claude-plugin', 'plugin.json'), path.join(dirs.make('lock'), 'locked.txt'));
      } else {
        test.skip(os.userInfo().uid === 0, 'root ignores directory permissions');
        fs.chmodSync(plugin, 0o500);
        release = async () => fs.chmodSync(plugin, 0o700);
      }
      try {
        const res = await run(locked, ['uninstall']);
        expect(res.code, res.output).toBe(0);
        expect(res.output).toContain('could not remove');
        expect(res.output).toContain('.artisyn');
        expect(res.output).toContain('retried on the next');
        expect(fs.existsSync(path.join(locked, '.artisyn', 'marketplace'))).toBe(true);
        const settings = readJson(lockedSettings);
        expect(settings).not.toHaveProperty('enabledPlugins');
        expect(settings).not.toHaveProperty('env');
      } finally {
        await release();
      }
      const again = await run(locked, ['uninstall']);
      expect(again.code, again.output).toBe(0);
      expect(fs.existsSync(path.join(locked, '.artisyn', 'marketplace'))).toBe(false);
    });

    await test.step('8. uninstall of a never-upgraded install under the legacy shared «artisyn» name removes its keys and keeps the user’s own marketplace', async () => {
      const legacy = makeFakeGitRepo(dirs);
      const legacySettings = writeClaudeSettings(legacy, USER_SETTINGS);
      const inst = await run(legacy, ['install', '--api-key', 'K-LEGACY']);
      expect(inst.code, inst.output).toBe(0);
      // Turn it into what an installer before the per-repo name wrote.
      const manifest = path.join(legacy, '.artisyn', 'marketplace', '.claude-plugin', 'marketplace.json');
      fs.writeFileSync(manifest, JSON.stringify({ ...readJson(manifest), name: 'artisyn' }, null, 2));
      const userMarketplace = { source: { source: 'github', repo: 'me/mine' } };
      fs.writeFileSync(legacySettings, JSON.stringify({
        ...readJson(legacySettings),
        enabledPlugins: { 'log-hub-hooks@artisyn': true, 'mine@elsewhere': true },
        extraKnownMarketplaces: { artisyn: { source: { source: 'directory', path: './.artisyn/marketplace' } }, elsewhere: userMarketplace },
      }, null, 2));
      const res = await run(legacy, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('Removed enabledPlugins["log-hub-hooks@artisyn"] / extraKnownMarketplaces.artisyn');
      const settings = readJson(legacySettings);
      expect(settings.enabledPlugins).toEqual({ 'mine@elsewhere': true });
      expect(settings.extraKnownMarketplaces).toEqual({ elsewhere: userMarketplace });
    });
  } finally {
    dirs.cleanup();
  }
});
