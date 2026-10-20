// S-INST-01. A clean install into a project with the user's own settings, and the installed hook
// working (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-INST-01; layer
// «installer (CLI)»; the installer does not depend on the auth mode → mode A only).
//
// The CLI is the stand's own `GET /static/artisyn-hooks-installer.tgz`, unpacked and run with
// `node package/dist/index.js` (helpers/installer.ts): what `npx <server>/static/…tgz install`
// executes. stdin is a pipe, never a TTY. A fake `claude` heads PATH and every real one is
// removed from it, so `claude plugin …` never reaches a real Claude Code.
//
// Code facts that differ from the design text:
//   - the guardrail was removed in 2.19.0: the config template carries no `guardrail*` key, so a
//     fresh install writes none (step 5), and a `guardrail*` key the user already has is kept
//     as is on a reinstall (an older hook reading the file would otherwise fall back to «on»);
//   - the marketplace is named per repo, `artisyn-<first 8 hex of sha256(normalised origin URL)>`
//     (the archive ships the legacy shared `artisyn`, the installer renames it), and
//     `extraKnownMarketplaces.<that name>` is `{source: {source: "directory", path:
//     "./.artisyn/marketplace"}}`; legacy `@artisyn` keys are migrated (step 12);
//   - the summary line is `Telemetry destination: <url>`; with `--server-url` and no key the
//     hint is `Next step: add your API key to .artisyn/config/log-hub.local.json`;
//   - the `.claude/` prompt is answered over the pipe: «n» aborts with exit 1, an empty answer
//     (the default) creates the directory;
//   - the activation (step 10) runs only `send-logs-hook.js` of the Stop group with OTEL turned off
//     in `log-hub.json` (an extra key the installer keeps), so no detached receiver outlives it;
//   - `claude plugin validate` needs the real CLI and runs as a separate test, skipped when no
//     `claude` is on PATH.
//
// Replaces:
//   - artisyn-hooks-installer/src/__tests__/install.test.ts — `happy path`, `guardrail defaults`,
//     `settings.json merge`, early `exits 1` (4), `CLI flags` summary messages (8),
//     `runClaudePluginActivation` (5)
//   - scripts/__tests__/build-hooks-installer.test.js — hooks.json vs INSTALL_HOOK.md drift (3)
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import {
  makeFakeGitRepo,
  makeFakeHome,
  normalizePath,
  pluginHookCommands,
  pluginRoot,
  REPO_ROOT,
  runNodeScript,
  startFakeLogHub,
  tempDirs,
  writeFakeClaude,
  type FakeLogHub,
} from '../helpers/hook-process';
import {
  fakeClaudeCalls,
  patchedPluginArchive,
  readJson,
  runInstaller,
  unpackInstaller,
  USER_SETTINGS,
  writeClaudeSettings,
} from '../helpers/installer';

const API_KEY = 'k-test-123456';

interface BuildScript {
  MARKETPLACE_NAME: string;
  PLUGIN_NAME: string;
  HOOK_JS_FILES: string[];
  buildMarketplaceJson(): object;
  buildPluginJson(version: string): object;
  parseEventNamesFromInstallMd(text: string): Set<string>;
}

// The build script guards its main() with `require.main === module`, so requiring it only reads
// the constants and pure builders the installed manifests must agree with.
const build: BuildScript = require(path.join(REPO_ROOT, 'scripts', 'build-hooks-installer.js'));

const MARKETPLACE_NAME_RE = /^artisyn-[0-9a-f]{8}$/;
const REMOTE = 'git@git.arrakis.test:scn/inst01/app.git';
// `git@host:org/repo.git` normalises to `host/org/repo` before hashing.
const EXPECTED_MARKETPLACE = `artisyn-${crypto.createHash('sha256').update('git.arrakis.test/scn/inst01/app').digest('hex').slice(0, 8)}`;

const marketplaceJsonPath = (repo: string) => path.join(repo, '.artisyn', 'marketplace', '.claude-plugin', 'marketplace.json');
const installedMarketplaceName = (repo: string) => readJson<{ name: string }>(marketplaceJsonPath(repo)).name;

const OTEL_ENV = (port: number) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_METRIC_EXPORT_INTERVAL: '10000',
});

test('@S-INST-01 a clean install keeps the user settings, writes exactly its own files and the installed hook works @mode-a', async ({ stand }) => {
  test.setTimeout(240_000);
  const dirs = tempDirs();
  let hub: FakeLogHub | undefined;
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const home = makeFakeHome(dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');

    await test.step('1. no .git → exit 1; an unknown subcommand → exit 1 and usage; --api-key without a value → exit 1; no hooks archive → exit 1', async () => {
      const bare = dirs.make('inst-bare');
      const noGit = await runInstaller(cli, bare, ['install'], { home });
      expect(noGit.code).toBe(1);
      expect(noGit.output).toContain('.git directory not found');
      const unknown = await runInstaller(cli, bare, ['instal'], { home });
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('Usage: artisyn-hooks <install|upgrade|uninstall>');
      const noValue = await runInstaller(cli, bare, ['install', '--api-key'], { home });
      expect(noValue.code).toBe(1);
      expect(noValue.stderr).toContain('--api-key requires a non-empty value');

      const repo = makeFakeGitRepo(dirs);
      fs.mkdirSync(path.join(repo, '.claude'));
      const noArchive = await runInstaller(cli, repo, ['install'], {
        home,
        env: { ARTISYN_HOOKS_ARCHIVE_PATH: path.join(bare, 'missing-hooks.tar.gz') },
      });
      expect(noArchive.code).toBe(1);
      expect(noArchive.stderr).toContain('Failed to read hooks archive');
      expect(fs.existsSync(pluginRoot(repo))).toBe(false);
    });

    await test.step('2 (with 7b, 9c). no .claude/: «n» aborts; the default answer creates it and installs; without claude on PATH the two manual commands are printed; no flags → «add your API key»', async () => {
      const repo = makeFakeGitRepo(dirs);
      const no = await runInstaller(cli, repo, ['install'], { home, stdin: 'n\n' });
      expect(no.code).toBe(1);
      expect(no.stderr).toContain('Aborted.');
      expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);

      const yes = await runInstaller(cli, repo, ['install'], { home, stdin: '\n' });
      expect(yes.code, yes.output).toBe(0);
      expect(fs.statSync(path.join(repo, '.claude')).isDirectory()).toBe(true);
      expect(yes.output).toContain('could not automatically register/activate the Claude Code plugin');
      expect(yes.output).toContain('claude plugin marketplace add');
      expect(yes.output).toMatch(/claude plugin install log-hub-hooks@artisyn-[0-9a-f]{8} --scope project/);
      expect(yes.stdout).toContain('Next step: add your API key to .artisyn/config/log-hub.local.json');
      expect(yes.stdout).toContain('Telemetry destination: (not set)');
    });

    hub = await startFakeLogHub();
    const repo = makeFakeGitRepo(dirs, { remote: REMOTE });
    const settingsFile = writeClaudeSettings(repo, USER_SETTINGS);
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8');
    const configDir = path.join(repo, '.artisyn', 'config');
    const plugin = pluginRoot(repo);

    const install = await test.step('3. install --server-url <hub>/ --api-key k-test-123456 (the trailing slash is cut)', async () => {
      const res = await runInstaller(cli, repo, ['install', '--server-url', `${hub!.url}/`, '--api-key', API_KEY], {
        home,
        fakeClaudeDir: fakeClaude.dir,
      });
      expect(res.code, res.output).toBe(0);
      return { ...res, bak: fs.readFileSync(`${settingsFile}.bak`, 'utf8') };
    });

    const port = await test.step('4. the plugin tree, the manifests the build script defines, the config pair, .gitignore and otel-port.json', async () => {
      expect(fs.existsSync(path.join(plugin, 'hooks', 'hooks.json'))).toBe(true);
      const scripts = fs.readdirSync(path.join(plugin, 'scripts')).filter((n) => n.endsWith('.js')).sort();
      expect(scripts, 'every bundled module exactly once').toEqual([...build.HOOK_JS_FILES].sort());
      const version = readJson<{ version: string }>(path.join(plugin, 'scripts', 'version.json')).version;
      const pluginJson = readJson(path.join(plugin, '.claude-plugin', 'plugin.json'));
      expect(pluginJson).toEqual(build.buildPluginJson(version));
      const marketplace = readJson(marketplaceJsonPath(repo));
      expect(marketplace).toEqual({ ...build.buildMarketplaceJson(), name: EXPECTED_MARKETPLACE });
      expect(build.MARKETPLACE_NAME, 'the archive ships the legacy shared name').toBe('artisyn');
      expect(pluginJson.name).toBe(build.PLUGIN_NAME);

      const base = readJson(path.join(configDir, 'log-hub.json'));
      expect(base.serverUrl).toBe(hub!.url);
      expect(base).not.toHaveProperty('apiKey');
      const p = Number(base.otelReceiverPort);
      expect(p).toBeGreaterThanOrEqual(25000);
      expect(p).toBeLessThanOrEqual(65535);
      expect(readJson(path.join(configDir, 'log-hub.local.json'))).toEqual({ apiKey: API_KEY });
      expect(fs.readFileSync(path.join(configDir, '.gitignore'), 'utf8').split(/\r?\n/)).toEqual(
        expect.arrayContaining(['log-hub.local.json', 'otel-port.json']),
      );
      expect(readJson(path.join(configDir, 'otel-port.json')).port).toBe(p);
      return p;
    });

    await test.step('5. no guardrail* key on a fresh install; one the user already has survives a reinstall unchanged', async () => {
      const base = readJson(path.join(configDir, 'log-hub.json'));
      expect(Object.keys(base).filter((k) => k.startsWith('guardrail'))).toEqual([]);
      fs.writeFileSync(path.join(configDir, 'log-hub.json'), JSON.stringify({ ...base, guardrailEnabled: true }, null, 2));
      const again = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(again.code, again.output).toBe(0);
      const after = readJson(path.join(configDir, 'log-hub.json'));
      expect(after.guardrailEnabled).toBe(true);
      expect(Object.keys(after).filter((k) => k.startsWith('guardrail'))).toEqual(['guardrailEnabled']);
      expect(after.otelReceiverPort, 'the remembered port').toBe(port);
      expect(installedMarketplaceName(repo), 'the per-repo marketplace name is stable').toBe(EXPECTED_MARKETPLACE);
    });

    await test.step('6. .claude/settings.json: the user’s permissions, hook and customKey byte for byte; the plugin keys and nine OTEL env keys added; .bak holds the original', async () => {
      const settings = readJson(settingsFile);
      expect(JSON.stringify(settings.permissions)).toBe(JSON.stringify(USER_SETTINGS.permissions));
      expect(JSON.stringify(settings.hooks)).toBe(JSON.stringify(USER_SETTINGS.hooks));
      expect(JSON.stringify(settings.customKey)).toBe(JSON.stringify(USER_SETTINGS.customKey));
      expect(settings.enabledPlugins).toEqual({ [`${build.PLUGIN_NAME}@${EXPECTED_MARKETPLACE}`]: true });
      expect(settings.extraKnownMarketplaces).toEqual({
        [EXPECTED_MARKETPLACE]: { source: { source: 'directory', path: './.artisyn/marketplace' } },
      });
      expect(settings.env).toEqual(OTEL_ENV(port));
      expect(install.bak, 'the first install backed up the user file byte for byte').toBe(settingsBefore);
    });

    await test.step('7. the fake claude was called twice per install, in order: marketplace add <abs path>, then plugin install --scope project', async () => {
      const calls = fakeClaudeCalls(fakeClaude.callsLog);
      expect(calls).toHaveLength(4);
      for (const pair of [calls.slice(0, 2), calls.slice(2, 4)]) {
        expect(pair[0].slice(0, 3)).toEqual(['plugin', 'marketplace', 'add']);
        expect(normalizePath(pair[0][3])).toBe(normalizePath(path.join(repo, '.artisyn', 'marketplace')));
        expect(pair[1]).toEqual(['plugin', 'install', `${build.PLUGIN_NAME}@${EXPECTED_MARKETPLACE}`, '--scope', 'project']);
      }
    });

    await test.step('8a. the post-install receiver smoke test passed on the allocated port', async () => {
      expect(install.stdout).toContain(`✓ OTEL receiver verified on 127.0.0.1:${port}`);
    });

    await test.step('9. the summary: destination URL, «fully configured»; --server-url alone → the API-key hint; no extra input asked', async () => {
      expect(install.stdout).toContain(`Telemetry destination: ${hub!.url}`);
      expect(install.stdout).toContain('Hooks are fully configured and ready to use.');
      expect(install.stdout).not.toContain('[Y/n]');
      const other = makeFakeGitRepo(dirs);
      fs.mkdirSync(path.join(other, '.claude'));
      const urlOnly = await runInstaller(cli, other, ['install', '--server-url', hub!.url], { home, fakeClaudeDir: fakeClaude.dir });
      expect(urlOnly.code).toBe(0);
      expect(urlOnly.stdout).toContain('Next step: add your API key to .artisyn/config/log-hub.local.json');
      expect(fs.existsSync(path.join(other, '.artisyn', 'config', 'log-hub.local.json'))).toBe(false);
      const otherName = installedMarketplaceName(other);
      expect(otherName, 'a repo without origin still gets a per-repo name').toMatch(MARKETPLACE_NAME_RE);
      expect(otherName, 'two repos never share a marketplace name').not.toBe(EXPECTED_MARKETPLACE);
    });

    await test.step('10. activation: the Stop command of the installed hooks.json sends with the key from log-hub.local.json to the URL from log-hub.json', async () => {
      const base = readJson(path.join(configDir, 'log-hub.json'));
      fs.writeFileSync(path.join(configDir, 'log-hub.json'), JSON.stringify({ ...base, otelEnabled: false, sendLogsOnPromptEnabled: false }, null, 2));
      const telemetry = path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry');
      fs.mkdirSync(telemetry, { recursive: true });
      fs.writeFileSync(path.join(telemetry, 's1.jsonl'), `${JSON.stringify({ event: 'prompt_start', session_id: 's1', prompt: 'hi' })}\n`);
      const stop = pluginHookCommands(plugin, 'Stop').find((c) => c.args[0]?.endsWith('send-logs-hook.js'));
      expect(stop, 'Stop runs send-logs-hook.js').toBeTruthy();
      expect(stop!.command).toBe('node');
      const res = await runNodeScript(stop!.args[0], repo, JSON.stringify({ session_id: 's1', cwd: repo, hook_event_name: 'Stop' }), {
        home,
        env: { CLAUDE_PLUGIN_ROOT: plugin },
      });
      expect(res.code, res.stderr).toBe(0);
      const uploads = hub!.requests.filter((r) => r.path === '/api/v2/logs');
      expect(uploads.map((r) => `${r.type}/${r.sessionId}`)).toContain('artisyn/s1');
      for (const r of uploads) expect(r.headers['x-api-key']).toBe(API_KEY);
    });

    await test.step('11. the events of hooks.json are exactly the ones hook/INSTALL_HOOK.md documents', async () => {
      const hooksJson = readJson<{ hooks: Record<string, unknown> }>(path.join(plugin, 'hooks', 'hooks.json'));
      const documented = build.parseEventNamesFromInstallMd(fs.readFileSync(path.join(REPO_ROOT, 'hook', 'INSTALL_HOOK.md'), 'utf8'));
      expect(Object.keys(hooksJson.hooks).sort()).toEqual([...documented].sort());
    });

    await test.step('12. a legacy install under the shared «artisyn» name: reinstall moves it and the marketplace’s other plugin to the per-repo name, the disabled state carried over and re-enabled', async () => {
      const legacy = makeFakeGitRepo(dirs, { remote: 'https://git.arrakis.test/scn/inst01/legacy.git' });
      const legacySource = { source: { source: 'directory', path: './.artisyn/marketplace' } };
      writeClaudeSettings(legacy, {
        enabledPlugins: { 'log-hub-hooks@artisyn': false, 'other-tool@artisyn': true, 'mine@elsewhere': true },
        extraKnownMarketplaces: { artisyn: legacySource, elsewhere: { source: { source: 'github', repo: 'me/mine' } } },
      });
      fs.mkdirSync(path.dirname(marketplaceJsonPath(legacy)), { recursive: true });
      fs.writeFileSync(marketplaceJsonPath(legacy), JSON.stringify({
        ...build.buildMarketplaceJson(),
        plugins: [{ name: 'other-tool', source: './plugins/other-tool' }],
      }, null, 2));

      const res = await runInstaller(cli, legacy, ['install'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      const name = installedMarketplaceName(legacy);
      expect(name).toMatch(MARKETPLACE_NAME_RE);
      expect(res.stdout).toContain(`Note: moved this repo's marketplace from the shared "artisyn" name to "${name}"`);
      expect(res.stdout).toContain(`Note: log-hub-hooks@${name} was disabled in .claude/settings.json — re-enabling it.`);
      expect(readJson<{ plugins: { name: string }[] }>(marketplaceJsonPath(legacy)).plugins.map((p) => p.name).sort())
        .toEqual(['log-hub-hooks', 'other-tool']);
      const settings = readJson<{ enabledPlugins: Record<string, boolean>; extraKnownMarketplaces: Record<string, unknown> }>(
        path.join(legacy, '.claude', 'settings.json'),
      );
      expect(settings.enabledPlugins).toEqual({ [`log-hub-hooks@${name}`]: true, [`other-tool@${name}`]: true, 'mine@elsewhere': true });
      expect(Object.keys(settings.extraKnownMarketplaces).sort()).toEqual(['elsewhere', name].sort());
      expect(res.output).not.toContain('marketplace is already registered');
    });

    await test.step('8b. a broken otel-receiver.js in the archive: a warning with the command to reproduce, exit 0, the port is not re-allocated', async () => {
      const archive = patchedPluginArchive(cli, dirs, {
        '.artisyn/marketplace/plugins/log-hub-hooks/scripts/otel-receiver.js': "'use strict';\nprocess.exit(3);\n",
      });
      const res = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir, env: { ARTISYN_HOOKS_ARCHIVE_PATH: archive } });
      expect(res.code, res.output).toBe(0);
      expect(res.output).toContain(`the OTEL receiver could not be verified on 127.0.0.1:${port}`);
      expect(res.output).toMatch(/node ".*otel-receiver\.js" --port \d+/);
      expect(readJson(path.join(configDir, 'otel-port.json')).port).toBe(port);
      expect(readJson(path.join(configDir, 'log-hub.json')).otelReceiverPort).toBe(port);
    });
  } finally {
    await hub?.close();
    dirs.cleanup();
  }
});

/** `claude` on the developer's real PATH, if any (the S-INST helpers strip it from the CLI's PATH). */
function realClaude(): boolean {
  const res = process.platform === 'win32'
    ? spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() !== '';
}

function runRealClaude(args: string[]): { code: number | null; output: string } {
  // A Windows `claude.cmd` shim cannot be exec'd without cmd.exe; the arguments are paths without
  // quotes in them, so quoting each is enough.
  const res = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"claude ${args.map((a) => `"${a}"`).join(' ')}"`], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 60_000,
    })
    : spawnSync('claude', args, { encoding: 'utf8', timeout: 60_000 });
  return { code: res.status, output: `${res.stdout}\n${res.stderr}` };
}

test('@S-INST-01 the installed marketplace and plugin pass `claude plugin validate` @mode-a', async ({ stand }) => {
  test.skip(!realClaude(), 'no `claude` CLI on PATH — `claude plugin validate` needs the real Claude Code');
  test.setTimeout(180_000);
  const dirs = tempDirs();
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const home = makeFakeHome(dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');
    const repo = makeFakeGitRepo(dirs);
    fs.mkdirSync(path.join(repo, '.claude'));
    const res = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir });
    expect(res.code, res.output).toBe(0);
    for (const target of [path.join(repo, '.artisyn', 'marketplace'), pluginRoot(repo)]) {
      const v = runRealClaude(['plugin', 'validate', target]);
      expect(v.code, `claude plugin validate ${target}\n${v.output}`).toBe(0);
    }
  } finally {
    dirs.cleanup();
  }
});
