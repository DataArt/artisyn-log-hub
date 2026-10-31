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
// OTEL traces (2026-10-30 OTEL tabs, AC-7, AC-15): a default install also writes the three trace
// keys, and uninstall removes them with the nine. Step 9 is an install from before the trace
// question (no trace keys, no `otelTraces`) with the user's own traces collector:
// `upgrade` adds the two trace keys the user does not set and keeps the user's endpoint; uninstall
// removes only the installer's keys — the two receiver endpoints; the user's endpoint and the
// exporter switches it relies on stay, as in step 3b.
//
// Foreign collector (2026-10-30 otel-shared-receiver, DD-24, DD-27): the second test starts from a
// user-scope `~/.claude/settings.json` that already exports OTEL to the user's own collector (a fake
// OTLP/HTTP collector on a loopback port with a non-`/v1/<signal>` path, plus a header with a
// secret). `--otel-existing=proxy` moves the endpoints to the shared receiver, keeps the header,
// backs the original keys up to `~/.artisyn/otel/forward.json`, leaves the `_artisynOtel` note and
// installs the user-level SessionStart hook, which starts the receiver that forwards every request
// byte for byte; `keep`, `replace`, the non-interactive default (`keep`) and a `grpc` collector
// each get a home of their own. A manual endpoint edit gets one `endpoint-drift` warning from the
// hook and no file change; the header value never shows up in any installer output, hook.log or
// receiver.log; uninstalling the last repo restores the user file byte for byte and removes the
// per-user state and the user-level hook.
//
// Replaces:
//   - artisyn-hooks-installer/src/__tests__/install.test.ts — `uninstall subcommand` (2), uninstall
//     of `OTEL port allocation, env block and uninstall` (2)
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '../fixtures';
import {
  authedRequest,
  makeFakeGitRepo,
  makeFakeHome,
  normalizePath,
  pluginRoot,
  rawRequest,
  readHookLog,
  runNodeScript,
  runPluginEvent,
  startFakeCollector,
  startFakeLogHub,
  tempDirs,
  waitForPort,
  writeFakeClaude,
  type TempDirs,
} from '../helpers/hook-process';
import {
  fakeClaudeCalls,
  readJson,
  type InstallerRun,
  runInstaller,
  treeHashes,
  unpackInstaller,
  USER_SETTINGS,
  writeClaudeSettings,
} from '../helpers/installer';

const USER_POST_HOOK = { type: 'command', command: 'my-post-hook.sh' };
const COLLECTOR = 'https://collector.corp:4318/v1/logs';
/** A loopback endpoint on a port outside the installer's allocation range: the user's, not ours. */
const LOOPBACK_COLLECTOR = 'http://localhost:4318/v1/logs';
const CORP_COLLECTOR = 'https://collector.corp.test:4318';
/** The user's own traces collector (AC-15). */
const USER_TRACES = 'https://traces.corp.test:4318/v1/traces';

/** The nine OTEL env keys and the three trace keys the installer writes. */
const OTEL_KEYS = new Set([
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_METRIC_EXPORT_INTERVAL',
]);

/** The installer's OTEL env keys present in a settings file's `env` (absent `env` → none). */
const otelKeysIn = (env: unknown): string[] =>
  (env && typeof env === 'object' ? Object.keys(env).filter((k) => OTEL_KEYS.has(k)) : []);

const localSettingsOf = (repo: string) => path.join(repo, '.claude', 'settings.local.json');

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

    await test.step('2 (with 7). the user’s permissions, hooks (the one sharing the installer’s matcher group included), customKey and env.MY_VAR byte for byte; the nine OTEL keys and the three trace keys gone from settings.local.json', async () => {
      const settings = readJson(settingsFile);
      expect(JSON.stringify(settings.permissions)).toBe(JSON.stringify(USER_SETTINGS.permissions));
      expect(JSON.stringify(settings.hooks)).toBe(JSON.stringify(USER_HOOKS_AFTER_INSTALL));
      expect(JSON.stringify(settings.customKey)).toBe(JSON.stringify(USER_SETTINGS.customKey));
      expect(settings.env).toEqual({ MY_VAR: '1' });
      expect(fs.existsSync(localSettingsOf(repo)), 'uninstall never deletes settings.local.json').toBe(true);
      expect(otelKeysIn(readJson(localSettingsOf(repo)).env)).toEqual([]);
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

    await test.step('3. the user re-pointed the OTEL logs endpoint in settings.json to their own collector: it stays untouched, settings.local.json gets no logs endpoint, and a Note says so', async () => {
      const other = makeFakeGitRepo(dirs);
      const otherSettings = writeClaudeSettings(other, { ...USER_SETTINGS, env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: COLLECTOR } });
      const inst = await run(other, ['install', '--api-key', 'K-COLLECTOR']);
      expect(inst.code, inst.output).toBe(0);
      const envAfterInstall = readJson(otherSettings).env;
      expect((envAfterInstall as Record<string, string>).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'install keeps the user value').toBe(COLLECTOR);
      expect(inst.stdout).toContain('Note: kept your existing .claude/settings.json env values for OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
      expect(readJson(localSettingsOf(other)).env ?? {}, 'the user value is not shadowed locally').not.toHaveProperty('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
      const res = await run(other, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(JSON.stringify(readJson(otherSettings).env)).toBe(JSON.stringify(envAfterInstall));
      expect(res.stdout).toContain(`Note: .claude/settings.json env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is "${COLLECTOR}"`);
    });

    await test.step('3b. a user loopback collector on a non-Artisyn port in settings.local.json survives install and uninstall, and a Note says so', async () => {
      const own = makeFakeGitRepo(dirs);
      writeClaudeSettings(own, USER_SETTINGS);
      const local = localSettingsOf(own);
      fs.writeFileSync(local, `${JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: LOOPBACK_COLLECTOR } }, null, 2)}\n`);
      const inst = await run(own, ['install', '--api-key', 'K-LOOPBACK']);
      expect(inst.code, inst.output).toBe(0);
      expect(inst.stdout).toContain('Note: kept your existing .claude/settings.local.json env values for OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
      const envAfterInstall = readJson<{ env: Record<string, string> }>(local).env;
      expect(envAfterInstall.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(LOOPBACK_COLLECTOR);
      expect(envAfterInstall.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, 'the absent metrics endpoint is filled').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/metrics$/);
      const res = await run(own, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      const envAfterUninstall = readJson<{ env: Record<string, string> }>(local).env;
      expect(envAfterUninstall.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(LOOPBACK_COLLECTOR);
      expect(envAfterUninstall, 'the Artisyn metrics endpoint is removed').not.toHaveProperty('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
      expect(res.stdout).toContain(`Note: .claude/settings.local.json env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is "${LOOPBACK_COLLECTOR}"`);
    });

    await test.step('3c. all nine OTEL keys committed in settings.json on the user’s own collector: settings.json env is identical after install and after uninstall; settings.local.json gets none of the nine, only the three trace keys the user does not set (traces default to on), and uninstall removes them', async () => {
      const corp = makeFakeGitRepo(dirs);
      const corpEnv = {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${CORP_COLLECTOR}/v1/logs`,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${CORP_COLLECTOR}/v1/metrics`,
        OTEL_LOG_TOOL_DETAILS: '1',
        OTEL_METRIC_EXPORT_INTERVAL: '10000',
      };
      const corpSettings = writeClaudeSettings(corp, { ...USER_SETTINGS, env: corpEnv });
      const original = JSON.stringify(corpEnv);
      const local = localSettingsOf(corp);
      const localOtelKeys = () => (fs.existsSync(local) ? otelKeysIn(readJson(local).env) : []);

      const inst = await run(corp, ['install', '--api-key', 'K-CORP']);
      expect(inst.code, inst.output).toBe(0);
      expect(JSON.stringify(readJson(corpSettings).env)).toBe(original);
      expect(localOtelKeys().sort()).toEqual(['CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_TRACES_EXPORTER']);
      const res = await run(corp, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(JSON.stringify(readJson(corpSettings).env)).toBe(original);
      expect(localOtelKeys()).toEqual([]);
    });

    await test.step('9, AC-15. an install from before the trace question with the user’s own traces endpoint: upgrade adds the two missing trace keys and keeps the user’s value; uninstall removes only the installer’s keys', async () => {
      // upgrade checks the connection (POST /api/v1/log-echo): any answer will do.
      const hub = await startFakeLogHub();
      try {
        const old = makeFakeGitRepo(dirs);
        writeClaudeSettings(old, USER_SETTINGS);
        const inst = await run(old, ['install', '--server-url', hub.url, '--api-key', 'K-UPGRADE']);
        expect(inst.code, inst.output).toBe(0);
        // Turn it into what an older installer left: no trace keys, no otelTraces answer, and the
        // user pointing traces at their own collector.
        const local = localSettingsOf(old);
        const env = readJson<{ env: Record<string, string> }>(local).env;
        for (const k of ['CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', 'OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) delete env[k];
        env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = USER_TRACES;
        fs.writeFileSync(local, `${JSON.stringify({ ...readJson(local), env }, null, 2)}\n`);
        const configFile = path.join(old, '.artisyn', 'config', 'log-hub.json');
        const config = readJson<Record<string, unknown>>(configFile);
        delete config.otelTraces;
        fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

        const up = await run(old, ['upgrade']);
        expect(up.code, up.output).toBe(0);
        const after = readJson<{ env: Record<string, string> }>(local).env;
        expect(after.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
        expect(after.OTEL_TRACES_EXPORTER).toBe('otlp');
        expect(after.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'the user value is kept').toBe(USER_TRACES);
        expect(after.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/);
        expect(readJson(configFile).otelTraces, 'the answer is stored now').toBe(true);

        const res = await run(old, ['uninstall']);
        expect(res.code, res.output).toBe(0);
        const left = readJson<{ env?: Record<string, string> }>(local).env ?? {};
        // The installer owns the keys that point at its receiver: both endpoints go. The user's
        // traces endpoint stays, and so do the exporter switches it still needs (the same
        // ownership rule as step 3b).
        expect(left.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(USER_TRACES);
        expect(left).not.toHaveProperty('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
        expect(left).not.toHaveProperty('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
        expect(Object.values(left).filter((v) => String(v).includes('127.0.0.1')), 'nothing points at the receiver').toEqual([]);
      } finally {
        await hub.close();
      }
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

// =============================================================================================
// A foreign OTEL collector in the user scope (2026-10-30 otel-shared-receiver)
// =============================================================================================

/** The collector credential: must never appear in any output or log (AC-D5). */
const HEADER_SECRET = 'scn-collector-secret-7f3a91';
const USER_ENSURE_HOOK_MARKER = '.artisyn/otel/bin/otel-ensure-receiver.js';

/** A user-scope settings file that exports logs and metrics to the user's own collector. */
function foreignUserSettings(collectorUrl: string, protocol = 'http/json'): Record<string, unknown> {
  return {
    permissions: { allow: ['Bash(ls)'] },
    env: {
      MY_VAR: '1',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collectorUrl}/otlp-in/v1/logs`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${collectorUrl}/otlp-in/v1/metrics`,
      OTEL_EXPORTER_OTLP_HEADERS: `x-collector-key=${HEADER_SECRET}`,
    },
    theme: 'light',
  };
}

interface ForeignSetup {
  home: string;
  repo: string;
  userFile: string;
  /** The user file as the user wrote it. */
  seed: string;
}

function foreignSetup(dirs: TempDirs, collectorUrl: string, protocol?: string): ForeignSetup {
  const home = makeFakeHome(dirs);
  const userFile = writeClaudeSettings(home, foreignUserSettings(collectorUrl, protocol));
  const repo = makeFakeGitRepo(dirs);
  writeClaudeSettings(repo, USER_SETTINGS);
  return { home, repo, userFile, seed: fs.readFileSync(userFile, 'utf8') };
}

const otelState = (home: string, name = '') => path.join(home, '.artisyn', 'otel', name);

/** Every command of the user-level SessionStart hook (DD-21) in a parsed user settings file. */
function userEnsureHooks(settings: Record<string, unknown>): Array<{ command: string; timeout?: number }> {
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>> | undefined;
  return Object.values(hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks))
    .filter((h) => h.command.replace(/\\/g, '/').includes(USER_ENSURE_HOOK_MARKER));
}

/** Stops the shared receiver of `home` with an authenticated shutdown (DD-9), if one answers. */
async function shutdownShared(home: string): Promise<void> {
  try {
    const port = readJson<{ port: number }>(otelState(home, 'port.json')).port;
    const token = fs.readFileSync(otelState(home, 'token'), 'utf8');
    await authedRequest(port, '/artisyn/shutdown', {}, { token, home });
  } catch {
    // Nothing listens, or the state is already gone.
  }
}

test('@S-INST-04 a foreign OTEL collector: proxy, keep, replace, grpc, drift, no header values, and uninstall restores the user file @mode-a', async ({ stand }) => {
  test.setTimeout(300_000);
  const dirs = tempDirs();
  const collector = await startFakeCollector();
  const outputs: InstallerRun[] = [];
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');
    const run = async (s: ForeignSetup, args: string[]) => {
      const res = await runInstaller(cli, s.repo, args, { home: s.home, fakeClaudeDir: fakeClaude.dir });
      outputs.push(res);
      return res;
    };
    const install = (s: ForeignSetup, extra: string[] = []) => run(s, ['install', '--server-url', 'http://127.0.0.1:9', '--api-key', 'K-FOREIGN', ...extra]);
    const logsUrl = `${collector.url}/otlp-in/v1/logs`;

    const proxy = foreignSetup(dirs, collector.url);
    const port = await test.step('P1, AC-D2, AC-D3. --otel-existing=proxy: the endpoints point at the shared receiver, the header key stays, the _artisynOtel note masks the header and names the backup, forward.json holds the original keys and the upstreams, the user-level SessionStart hook is added, .artisyn-bak is the original', async () => {
      const res = await install(proxy, ['--otel-existing=proxy']);
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('Existing OTEL collector: proxy — the Log Hub receiver forwards logs, metrics to it unchanged.');
      const p = readJson<{ port: number }>(otelState(proxy.home, 'port.json')).port;
      const user = readJson<Record<string, unknown>>(proxy.userFile);
      const env = user.env as Record<string, string>;
      expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${p}/v1/logs`);
      expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(`http://127.0.0.1:${p}/v1/metrics`);
      expect(env.OTEL_EXPORTER_OTLP_HEADERS, 'proxy keeps the collector credentials').toBe(`x-collector-key=${HEADER_SECRET}`);
      expect(env.MY_VAR).toBe('1');
      expect(user.permissions).toEqual({ allow: ['Bash(ls)'] });
      expect(user.theme).toBe('light');

      const note = user._artisynOtel as { note: string; mode: string; previous: Record<string, string>; backup: string };
      expect(note.mode).toBe('proxy');
      expect(note.note).toContain('forwarding everything to your collector unchanged');
      expect(note.previous.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(logsUrl);
      expect(note.previous.OTEL_EXPORTER_OTLP_HEADERS, 'header values are masked').toBe('set');
      expect(normalizePath(note.backup)).toBe(normalizePath(otelState(proxy.home, 'forward.json')));

      const forward = readJson<{ mode: string; fingerprint: string; signals: Record<string, { endpoint: string }>; original: { env: Record<string, string> } }>(otelState(proxy.home, 'forward.json'));
      expect(forward.mode).toBe('proxy');
      expect(forward.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(forward.signals.logs.endpoint).toBe(logsUrl);
      expect(forward.signals.metrics.endpoint).toBe(`${collector.url}/otlp-in/v1/metrics`);
      expect(forward.original.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(logsUrl);

      const ensure = userEnsureHooks(user);
      expect(ensure, 'exactly one user-level SessionStart hook').toHaveLength(1);
      expect(Object.keys(user.hooks as object)).toEqual(['SessionStart']);
      expect(ensure[0].timeout).toBe(5);
      expect(fs.readFileSync(`${proxy.userFile}.artisyn-bak`, 'utf8')).toBe(proxy.seed);
      return p;
    });

    await test.step('P1b, AC-D2, AC-B2. a collector on the generic OTEL_EXPORTER_OTLP_ENDPOINT: after proxy in one repo, installing a second repo of the same home (no flag) keeps proxy — forward.json with its original keys and upstreams, the note and the user-level hook all survive', async () => {
      const home = makeFakeHome(dirs);
      const generic = foreignUserSettings(collector.url);
      const genericEnv = { ...(generic.env as Record<string, string>) };
      delete genericEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      delete genericEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
      genericEnv.OTEL_EXPORTER_OTLP_ENDPOINT = `${collector.url}/otlp-in`;
      const userFile = writeClaudeSettings(home, { ...generic, env: genericEnv });
      const seed = fs.readFileSync(userFile, 'utf8');
      const first: ForeignSetup = { home, repo: makeFakeGitRepo(dirs), userFile, seed };
      const second: ForeignSetup = { home, repo: makeFakeGitRepo(dirs), userFile, seed };
      writeClaudeSettings(first.repo, USER_SETTINGS);
      writeClaudeSettings(second.repo, USER_SETTINGS);
      try {
        const a = await install(first, ['--otel-existing=proxy']);
        expect(a.code, a.output).toBe(0);
        type Fwd = { mode: string; fingerprint: string; signals: Record<string, { endpoint: string }>; original: { env: Record<string, string> } };
        const before = readJson<Fwd>(otelState(home, 'forward.json'));
        expect(before.mode).toBe('proxy');
        expect(before.signals.logs.endpoint).toBe(`${collector.url}/otlp-in/v1/logs`);
        expect(before.original.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`${collector.url}/otlp-in`);

        const b = await install(second);
        expect(b.code, b.output).toBe(0);
        expect(b.stdout, 'the stored choice is reused, not asked again').toContain('keeping the choice "proxy"');
        const after = readJson<Fwd>(otelState(home, 'forward.json'));
        expect(after, 'forward.json keeps the proxy choice and the backup of the user keys').toEqual(before);
        const user = readJson<Record<string, unknown>>(userFile);
        expect((user._artisynOtel as { mode: string }).mode).toBe('proxy');
        expect(userEnsureHooks(user), 'the user-level hook stays').toHaveLength(1);
      } finally {
        await shutdownShared(home);
      }
    });

    await test.step('P2, AC-D2, AC-D7. the user-level hook starts the receiver from ~/.artisyn/otel/bin; an OTLP request of a session no repo registered reaches the collector byte for byte, on its own path, with the header; receiver.log records the forward without the value', async () => {
      const script = otelState(proxy.home, path.join('bin', 'otel-ensure-receiver.js'));
      const ensureRun = await runNodeScript(script, proxy.repo, '{}', { home: proxy.home });
      expect(ensureRun.code, ensureRun.stderr).toBe(0);
      try {
        await waitForPort(port, { timeoutMs: 10_000 });
        const payload = Buffer.from(JSON.stringify({
          resourceLogs: [{
            resource: { attributes: [] },
            scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: [{
              timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
              body: { stringValue: 'claude_code.user_prompt' },
              attributes: [{ key: 'session.id', value: { stringValue: 'inst04-unregistered' } }],
            }] }],
          }],
        }), 'utf8');
        const res = await rawRequest(port, '/v1/logs', payload, { headers: { 'x-collector-key': HEADER_SECRET } });
        expect(res.status, res.body).toBe(200);
        await expect.poll(() => collector.requests.filter((r) => r.path === '/otlp-in/v1/logs').length, { timeout: 15_000 }).toBe(1);
        const got = collector.requests.find((r) => r.path === '/otlp-in/v1/logs')!;
        expect(got.body.equals(payload), 'byte-identical payload').toBe(true);
        expect(got.headers['x-collector-key']).toBe(HEADER_SECRET);
        await expect.poll(() => {
          try {
            return fs.readFileSync(otelState(proxy.home, 'receiver.log'), 'utf8');
          } catch {
            return '';
          }
        }, { timeout: 10_000 }).toContain('forward signal=logs');
      } finally {
        await shutdownShared(proxy.home);
      }
    });

    await test.step('P3, AC-D8. the user re-points the logs endpoint by hand: SessionStart writes one otel endpoint-drift warning to hook.log and changes no file', async () => {
      const user = readJson<Record<string, unknown>>(proxy.userFile);
      const before = fs.readFileSync(proxy.userFile, 'utf8');
      const edited = `${JSON.stringify({ ...user, env: { ...(user.env as object), OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://moved.corp.test/v1/logs' } }, null, 2)}\n`;
      fs.writeFileSync(proxy.userFile, edited);
      const transcriptDir = dirs.make('transcript');
      const transcript = path.join(transcriptDir, 'transcript.jsonl');
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', version: '2.1.290', message: { role: 'user', content: 'hi' } })}\n`);
      const sessionId = 'inst04-drift';
      try {
        const runs = await runPluginEvent(
          pluginRoot(proxy.repo),
          { hook_event_name: 'SessionStart', session_id: sessionId, cwd: proxy.repo, transcript_path: transcript, source: 'startup' },
          { home: proxy.home, env: { ARTISYN_MANAGED_SETTINGS_DIR: dirs.make('no-managed') } },
        );
        for (const r of runs) expect(r.code, r.stderr).toBe(0);
      } finally {
        await shutdownShared(proxy.home);
      }
      const drift = readHookLog(proxy.repo).filter((l) => l.includes(sessionId) && l.includes('otel endpoint-drift'));
      expect(drift).toHaveLength(1);
      expect(fs.readFileSync(proxy.userFile, 'utf8'), 'the hook never writes the user file').toBe(edited);
      fs.writeFileSync(proxy.userFile, before);
    });

    const keep = foreignSetup(dirs, collector.url);
    await test.step('K, AC-D3. --otel-existing=keep: the user file is untouched (no backup), forward.json says keep, no user-level hook', async () => {
      const res = await install(keep, ['--otel-existing=keep']);
      expect(res.code, res.output).toBe(0);
      expect(fs.readFileSync(keep.userFile, 'utf8')).toBe(keep.seed);
      expect(fs.existsSync(`${keep.userFile}.artisyn-bak`)).toBe(false);
      expect(readJson<{ mode: string }>(otelState(keep.home, 'forward.json')).mode).toBe('keep');
    });

    const replace = foreignSetup(dirs, collector.url);
    await test.step('R, AC-D3. --otel-existing=replace: the endpoints point at the receiver, the header key is removed, the note says replace, no user-level hook, forward.json keeps the original', async () => {
      const res = await install(replace, ['--otel-existing=replace']);
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('Existing OTEL collector: replace — telemetry now goes only to Log Hub.');
      const p = readJson<{ port: number }>(otelState(replace.home, 'port.json')).port;
      const user = readJson<Record<string, unknown>>(replace.userFile);
      const env = user.env as Record<string, string>;
      expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${p}/v1/logs`);
      expect(env).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
      expect((user._artisynOtel as { mode: string }).mode).toBe('replace');
      expect(userEnsureHooks(user)).toEqual([]);
      const forward = readJson<{ mode: string; original: { env: Record<string, string> } }>(otelState(replace.home, 'forward.json'));
      expect(forward.mode).toBe('replace');
      expect(forward.original.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(logsUrl);
    });

    const silent = foreignSetup(dirs, collector.url);
    await test.step('N, AC-D4. no flag, no terminal: the masked summary (headers: set), then keep; a second run with the same collector reuses the stored choice without asking', async () => {
      const res = await install(silent);
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('An existing OTEL collector is configured for Claude Code (header values are not shown):');
      expect(res.stdout).toMatch(/logs\s+.*\/otlp-in\/v1\/logs \(user settings\) — protocol: http\/json, headers: set, exporter: otlp/);
      expect(res.stdout).toContain('Existing OTEL collector: keeping it untouched (non-interactive run)');
      expect(fs.readFileSync(silent.userFile, 'utf8')).toBe(silent.seed);
      const again = await install(silent);
      expect(again.code, again.output).toBe(0);
      expect(again.stdout).toContain('Existing OTEL collector: unchanged since the last install — keeping the choice "keep"');
      expect(fs.readFileSync(silent.userFile, 'utf8')).toBe(silent.seed);
    });

    const grpc = foreignSetup(dirs, collector.url, 'grpc');
    await test.step('G, AC-D4. a grpc collector with --otel-existing=proxy in a non-interactive run: the receiver cannot forward grpc, so it says so and keeps the collector; the user file is untouched', async () => {
      const res = await install(grpc, ['--otel-existing=proxy']);
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('Your collector is configured with grpc; the Log Hub receiver can forward only to an OTLP/HTTP (JSON) endpoint.');
      expect(res.stdout).toContain('keeping it untouched (non-interactive run)');
      expect(fs.readFileSync(grpc.userFile, 'utf8')).toBe(grpc.seed);
      expect(readJson<{ mode: string }>(otelState(grpc.home, 'forward.json')).mode).toBe('keep');
    });

    await test.step('AC-D5. the collector header value appears in no installer output, hook.log or receiver.log', async () => {
      for (const r of outputs) expect(r.output).not.toContain(HEADER_SECRET);
      const sharedLog = fs.readFileSync(otelState(proxy.home, 'receiver.log'), 'utf8');
      expect(sharedLog).toContain('forward signal=logs');
      expect(sharedLog).not.toContain(HEADER_SECRET);
      for (const s of [proxy, keep, replace, silent, grpc]) {
        expect(readHookLog(s.repo).join('\n'), s.repo).not.toContain(HEADER_SECRET);
        const repoReceiverLog = path.join(s.repo, '.artisyn', 'ai_work_dir', 'telemetry', 'otel', 'receiver.log');
        if (fs.existsSync(repoReceiverLog)) expect(fs.readFileSync(repoReceiverLog, 'utf8')).not.toContain(HEADER_SECRET);
      }
    });
    await test.step('U, AC-B2, AC-D7. uninstalling the last repo of the proxy home restores ~/.claude/settings.json byte for byte (collector keys, header, no note, no user-level hook), keeps .artisyn-bak and removes ~/.artisyn/otel', async () => {
      const res = await run(proxy, ['uninstall']);
      expect(res.code, res.output).toBe(0);
      expect(fs.readFileSync(proxy.userFile, 'utf8')).toBe(proxy.seed);
      expect(fs.existsSync(`${proxy.userFile}.artisyn-bak`), 'the safety copy is kept').toBe(true);
      expect(fs.existsSync(otelState(proxy.home)), 'the per-user state is removed').toBe(false);
      expect(res.stdout).toContain('Removed the per-user OTEL receiver state');
    });

  } finally {
    await collector.close();
    dirs.cleanup();
  }
});
