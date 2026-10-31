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
// OTEL traces (2026-10-30 OTEL tabs, AC-7, FR-11): a non-interactive install answers the
// «Also export Claude Code traces?» question with its default, yes — the env block gets the three
// trace keys next to the nine OTEL keys, `otelTraces: true` lands in log-hub.json, and the
// installed receiver turns a traces request into chunk lines the installed Stop hook's
// `--otel-sweep` uploads. `--otel-traces=no` writes none of the three keys.
//
// Shared receiver (2026-10-30 otel-shared-receiver, hook 2.30.0): one receiver per OS user. The
// installer allocates its port once into `~/.artisyn/otel/port.json` (with `token`, `repos.json` and
// the `bin/` receiver copy), writes the OTEL keys into the user-scope `~/.claude/settings.json`
// (Claude Code 2.1.282+ reads telemetry keys only there) and mirrors them into each repo's
// `.claude/settings.local.json` on the same port, with `OTEL_RESOURCE_ATTRIBUTES=artisyn.repo=<repoKey>`.
// `.artisyn/config/otel-port.json` is gone: an upgrade deletes it and leaves the old per-project
// receiver to its idle-exit. The fake HOME starts with the user's own user-scope settings, which
// every install keeps (AC-B1). The last steps cover the upgrade from a per-project receiver
// (AC-A9), the `--otel-port` re-pin, managed OTEL via `ARTISYN_MANAGED_SETTINGS_DIR` (AC-C1), a
// wrong-typed user file (AC-B3) and the SessionStart `project-only` warning with the Claude Code
// version line in hook.log (AC-E1).
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
  authedRequest,
  freeLoopbackPort,
  makeFakeGitRepo,
  makeFakeHome,
  normalizePath,
  pluginHookCommands,
  pluginRoot,
  readHookLog,
  REPO_ROOT,
  rawRequest,
  repoKeyOf,
  runNodeScript,
  runPluginEvent,
  startFakeLogHub,
  startReceiver,
  stopReceiver,
  tempDirs,
  waitForPort,
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

/** The nine OTEL env keys every install writes (an install from before the trace question). */
const OTEL_ENV_NINE = (port: number) => ({
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

/** The three trace keys a «yes» to the trace question adds (AC-7). */
const OTEL_TRACE_ENV = (port: number) => ({
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
});

/** The env block of a default (traces on) install. */
const OTEL_ENV = (port: number) => ({ ...OTEL_ENV_NINE(port), ...OTEL_TRACE_ENV(port) });

/** The local mirror of an install: the OTEL keys plus this repo's `artisyn.repo` tag (DD-23). */
const MIRROR_ENV = (port: number, repo: string, base: Record<string, string> = OTEL_ENV(port)) => ({
  ...base,
  OTEL_RESOURCE_ATTRIBUTES: `artisyn.repo=${repoKeyOf(repo)}`,
});

/** The user's own user-scope settings the fake HOME starts with (AC-B1: every install keeps them). */
const USER_SCOPE_SETTINGS = {
  theme: 'dark',
  permissions: { allow: ['Read(./docs/**)'] },
  env: { MY_USER_VAR: 'keep-me' },
};

/** `<home>/.artisyn/otel/<name>`, the per-user shared-receiver state (DD-4). */
const stateFile = (home: string, name: string) => path.join(home, '.artisyn', 'otel', name);
const sharedPortOf = (home: string) => readJson<{ port: number }>(stateFile(home, 'port.json')).port;

/** A transcript whose last line carries Claude Code's `version` (DD-13: the hook reads it at SessionStart). */
function writeTranscript(dir: string, version: string): string {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', version, message: { role: 'user', content: 'hi' } })}\n`);
  return file;
}

/** Stops the shared receiver of `home` (an authenticated shutdown, DD-9) when one answers. */
async function shutdownSharedReceiver(home: string): Promise<void> {
  const port = sharedPortOf(home);
  const token = fs.readFileSync(stateFile(home, 'token'), 'utf8');
  try {
    await authedRequest(port, '/artisyn/shutdown', {}, { token, home });
  } catch {
    // Nothing listens (it never started or already exited).
  }
}

/** The installer's OTEL env keys present in a settings file's `env` (absent `env` → none). */
const otelKeysIn = (env: unknown): string[] => {
  const keys = new Set(Object.keys(OTEL_ENV(0)));
  return env && typeof env === 'object' ? Object.keys(env).filter((k) => keys.has(k)) : [];
};

test('@S-INST-01 a clean install keeps the user settings, writes exactly its own files and the installed hook works @mode-a', async ({ stand }) => {
  test.setTimeout(240_000);
  const dirs = tempDirs();
  let hub: FakeLogHub | undefined;
  try {
    const cli = await unpackInstaller(stand.url, dirs);
    const home = makeFakeHome(dirs);
    const userSettingsFile = writeClaudeSettings(home, USER_SCOPE_SETTINGS);
    const userSettingsSeed = fs.readFileSync(userSettingsFile, 'utf8');
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
    const localSettingsFile = path.join(repo, '.claude', 'settings.local.json');
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

    const port = await test.step('4. the plugin tree, the manifests the build script defines, the config pair, .gitignore; otelReceiverPort is the shared port of ~/.artisyn/otel/port.json and there is no otel-port.json', async () => {
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
      expect(base.serverUrl, 'the tracked file keeps the template value').toBe('');
      expect(base.otelTraces, 'the trace answer (non-interactive default: yes)').toBe(true);
      expect(base).not.toHaveProperty('apiKey');
      expect(base).not.toHaveProperty('otelReceiverPort');
      const local = readJson(path.join(configDir, 'log-hub.local.json'));
      const p = Number(local.otelReceiverPort);
      expect(p).toBeGreaterThanOrEqual(25000);
      expect(p).toBeLessThanOrEqual(65535);
      expect(local).toEqual({ apiKey: API_KEY, serverUrl: hub!.url, otelReceiverPort: p });
      expect(fs.readFileSync(path.join(configDir, '.gitignore'), 'utf8').split(/\r?\n/)).toEqual(
        expect.arrayContaining(['log-hub.local.json']),
      );
      expect(fs.existsSync(path.join(configDir, 'otel-port.json')), 'the per-project port store is gone (DD-25)').toBe(false);
      expect(sharedPortOf(home), 'otelReceiverPort is the per-user shared port').toBe(p);
      return p;
    });

    await test.step('5. no guardrail* key on a fresh install; one the user already has survives a reinstall unchanged; a legacy otelReceiverPort in log-hub.json is removed, the port stays in log-hub.local.json', async () => {
      const base = readJson(path.join(configDir, 'log-hub.json'));
      expect(Object.keys(base).filter((k) => k.startsWith('guardrail'))).toEqual([]);
      fs.writeFileSync(path.join(configDir, 'log-hub.json'), JSON.stringify({ ...base, guardrailEnabled: true, otelReceiverPort: 12345 }, null, 2));
      const again = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(again.code, again.output).toBe(0);
      const after = readJson(path.join(configDir, 'log-hub.json'));
      expect(after.guardrailEnabled).toBe(true);
      expect(Object.keys(after).filter((k) => k.startsWith('guardrail'))).toEqual(['guardrailEnabled']);
      expect(after, 'an upgrade cleans the tracked file up').not.toHaveProperty('otelReceiverPort');
      expect(readJson(path.join(configDir, 'log-hub.local.json')).otelReceiverPort, 'the remembered port').toBe(port);
      expect(installedMarketplaceName(repo), 'the per-repo marketplace name is stable').toBe(EXPECTED_MARKETPLACE);
    });

    await test.step('6, AC-7. .claude/settings.json: the user’s permissions, hook and customKey byte for byte; the plugin keys added and no OTEL env key; the nine OTEL env keys and the three trace keys in .claude/settings.local.json; .bak holds the original', async () => {
      const settings = readJson(settingsFile);
      expect(JSON.stringify(settings.permissions)).toBe(JSON.stringify(USER_SETTINGS.permissions));
      expect(JSON.stringify(settings.hooks)).toBe(JSON.stringify(USER_SETTINGS.hooks));
      expect(JSON.stringify(settings.customKey)).toBe(JSON.stringify(USER_SETTINGS.customKey));
      expect(settings.enabledPlugins).toEqual({ [`${build.PLUGIN_NAME}@${EXPECTED_MARKETPLACE}`]: true });
      expect(settings.extraKnownMarketplaces).toEqual({
        [EXPECTED_MARKETPLACE]: { source: { source: 'directory', path: './.artisyn/marketplace' } },
      });
      expect(otelKeysIn(settings.env), 'the committed file carries no per-checkout OTEL key').toEqual([]);
      expect(readJson(localSettingsFile).env).toEqual(MIRROR_ENV(port, repo));
      expect(install.bak, 'the first install backed up the user file byte for byte').toBe(settingsBefore);
    });

    await test.step('6d, AC-B1. ~/.claude/settings.json: the user’s theme, permissions and env.MY_USER_VAR kept, the OTEL keys on the shared port added, no _artisynOtel and no user-level hook (no foreign collector); .artisyn-bak holds the user’s original byte for byte; the local mirror is on the same port', async () => {
      const user = readJson<Record<string, unknown>>(userSettingsFile);
      expect(user.theme).toBe(USER_SCOPE_SETTINGS.theme);
      expect(user.permissions).toEqual(USER_SCOPE_SETTINGS.permissions);
      expect(user.env).toEqual({ ...USER_SCOPE_SETTINGS.env, ...OTEL_ENV(port) });
      expect(user).not.toHaveProperty('_artisynOtel');
      expect(user).not.toHaveProperty('hooks');
      expect(fs.readFileSync(`${userSettingsFile}.artisyn-bak`, 'utf8')).toBe(userSettingsSeed);
      expect(readJson<{ env: Record<string, string> }>(localSettingsFile).env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
        .toBe((user.env as Record<string, string>).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
    });

    await test.step('6e, AC-B1. ~/.artisyn/otel: port.json {version 1, port, allocatedAt}, a 64-hex token, this repo’s repos.json entry (repoKey, gitRoot, otelDir, uploader, traces, hookVersion) and the bin/ receiver copy with the user-level hook script', async () => {
      const portJson = readJson<Record<string, unknown>>(stateFile(home, 'port.json'));
      expect(portJson).toMatchObject({ version: 1, port });
      expect(typeof portJson.allocatedAt).toBe('string');
      expect(fs.readFileSync(stateFile(home, 'token'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
      const repos = readJson<{ version: number; repos: Array<Record<string, unknown>> }>(stateFile(home, 'repos.json'));
      expect(repos.version).toBe(1);
      const entry = repos.repos.find((r) => r.repoKey === repoKeyOf(repo));
      expect(entry, 'this repo is registered').toBeTruthy();
      expect(normalizePath(String(entry!.gitRoot))).toBe(normalizePath(repo));
      expect(normalizePath(String(entry!.otelDir))).toBe(normalizePath(path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry', 'otel')));
      expect(normalizePath(String(entry!.uploader))).toBe(normalizePath(path.join(plugin, 'scripts', 'send-logs-hook.js')));
      expect(entry!.traces).toBe(true);
      expect(entry!.hookVersion).toBe(readJson<{ version: string }>(path.join(plugin, 'scripts', 'version.json')).version);
      for (const name of ['otel-receiver.js', 'version.json', 'otel-ensure-receiver.js']) {
        expect(fs.existsSync(stateFile(home, path.join('bin', name))), `bin/${name}`).toBe(true);
      }
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

    // 6b and 6c re-run install in this repo, so they come after step 7's call count. 6c puts the
    // original port back, which 8b relies on.
    const portFile = stateFile(home, 'port.json');
    await test.step('6b. the shared port drifts to another in-range port B: install repoints the endpoints in settings.local.json and ~/.claude/settings.json to B and says so', async () => {
      const drifted = port === 65535 ? port - 1 : port + 1;
      fs.writeFileSync(portFile, JSON.stringify({ ...readJson(portFile), port: drifted }, null, 2));
      const res = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      const env = readJson<{ env: Record<string, string> }>(localSettingsFile).env;
      expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${drifted}/v1/logs`);
      expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(`http://127.0.0.1:${drifted}/v1/metrics`);
      expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(`http://127.0.0.1:${drifted}/v1/traces`);
      expect(env).toEqual(MIRROR_ENV(drifted, repo));
      expect(readJson<{ env: Record<string, string> }>(userSettingsFile).env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${drifted}/v1/logs`);
      expect(res.stdout).toContain(`Note: rewrote stale Artisyn OTEL endpoints in ~/.claude/settings.json (OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ${port} → ${drifted}`);
      expect(res.stdout).toContain(
        'Note: rewrote stale Artisyn OTEL endpoints in .claude/settings.local.json (' +
        `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ${port} → ${drifted}, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ${port} → ${drifted}, ` +
        `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ${port} → ${drifted}).`,
      );
      expect(otelKeysIn(readJson(settingsFile).env)).toEqual([]);
    });

    await test.step('6c, AC-15. a legacy layout (the nine OTEL keys on a stale port in settings.json, no settings.local.json — an install from before the trace question): install moves them to settings.local.json on the current port, adds the trace keys and says so', async () => {
      fs.writeFileSync(portFile, JSON.stringify({ ...readJson(portFile), port }, null, 2));
      fs.rmSync(localSettingsFile, { force: true });
      const stale = port === 30001 ? 30002 : 30001;
      fs.writeFileSync(settingsFile, `${JSON.stringify({ ...readJson(settingsFile), env: OTEL_ENV_NINE(stale) }, null, 2)}\n`);
      const res = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      expect(otelKeysIn(readJson(settingsFile).env), 'every legacy OTEL key left settings.json').toEqual([]);
      expect(readJson(localSettingsFile).env).toEqual(MIRROR_ENV(port, repo));
      expect(res.stdout).toContain('Note: moved the Artisyn OTEL env keys from .claude/settings.json to .claude/settings.local.json.');
      expect(readJson(path.join(configDir, 'log-hub.local.json')).otelReceiverPort, 'the original port is back for 8b').toBe(port);
    });

    await test.step('8a. the post-install receiver smoke test passed on the allocated port', async () => {
      expect(install.stdout).toContain(`✓ OTEL receiver verified on 127.0.0.1:${port}`);
    });

    await test.step('9. the summary: destination URL, «fully configured»; --server-url alone → the API-key hint, serverUrl and the port in log-hub.local.json; no extra input asked', async () => {
      expect(install.stdout).toContain(`Telemetry destination: ${hub!.url}`);
      expect(install.stdout).toContain('Hooks are fully configured and ready to use.');
      expect(install.stdout).not.toContain('[Y/n]');
      const other = makeFakeGitRepo(dirs);
      fs.mkdirSync(path.join(other, '.claude'));
      const urlOnly = await runInstaller(cli, other, ['install', '--server-url', hub!.url], { home, fakeClaudeDir: fakeClaude.dir });
      expect(urlOnly.code).toBe(0);
      expect(urlOnly.stdout).toContain('Next step: add your API key to .artisyn/config/log-hub.local.json');
      const otherConfig = path.join(other, '.artisyn', 'config');
      expect(readJson(path.join(otherConfig, 'log-hub.local.json'))).toEqual({
        serverUrl: hub!.url,
        otelReceiverPort: port,
      });
      expect(readJson(path.join(otherConfig, 'log-hub.json')).serverUrl).toBe('');
      const otherName = installedMarketplaceName(other);
      expect(otherName, 'a repo without origin still gets a per-repo name').toMatch(MARKETPLACE_NAME_RE);
      expect(otherName, 'two repos never share a marketplace name').not.toBe(EXPECTED_MARKETPLACE);
    });

    await test.step('10. activation: the Stop command of the installed hooks.json sends with the key from log-hub.local.json to the URL from log-hub.local.json', async () => {
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

    await test.step('10b, AC-7. a session with traces: the installed receiver writes the spans of a /v1/traces request to chunk files, and the installed hook’s --otel-sweep uploads them as claude-otel', async () => {
      const otelDir = path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry', 'otel');
      fs.mkdirSync(otelDir, { recursive: true });
      const { receiver, port: rport } = await startReceiver(path.join(plugin, 'scripts'), { dir: otelDir, owner: { gitRoot: repo, repo: REMOTE } });
      try {
        const span = {
          traceId: 'inst01trace', spanId: 'inst01span', parentSpanId: '', name: 'claude_code.interaction', kind: 1,
          startTimeUnixNano: `${BigInt(Date.now() - 60_000) * 1_000_000n}`, endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
          attributes: [{ key: 'session.id', value: { stringValue: 'tr-inst01' } }],
        };
        const res = await rawRequest(rport, '/v1/traces', { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'com.anthropic.claude_code.tracing' }, spans: [span] }] }] });
        expect(res.status, res.body).toBe(200);
      } finally {
        await stopReceiver(receiver);
      }
      expect(fs.readdirSync(path.join(otelDir, 'tr-inst01')).filter((n) => n.endsWith('.jsonl'))).toHaveLength(1);
      const before = hub!.requests.length;
      const sweep = await runNodeScript(path.join(plugin, 'scripts', 'send-logs-hook.js'), repo, null, {
        home,
        env: { CLAUDE_PLUGIN_ROOT: plugin },
        argv: ['--otel-sweep', '--cwd', repo],
      });
      expect(sweep.code, sweep.stderr).toBe(0);
      const upload = hub!.requests.slice(before).find((r) => r.path === '/api/v2/logs' && r.type === 'claude-otel' && r.sessionId === 'tr-inst01');
      expect(upload, 'the trace chunk is uploaded').toBeTruthy();
      expect(upload!.headers['x-api-key']).toBe(API_KEY);
      expect(upload!.body.toString('utf8')).toContain('"signal":"spans"');
    });

    await test.step('FR-11. install --otel-traces=no: none of the three trace keys, otelTraces false in log-hub.json, the summary says traces are off', async () => {
      const no = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/inst01/no-traces.git' });
      fs.mkdirSync(path.join(no, '.claude'));
      const res = await runInstaller(cli, no, ['install', '--server-url', hub!.url, '--api-key', API_KEY, '--otel-traces=no'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('OTEL trace export: off');
      expect(readJson(path.join(no, '.claude', 'settings.local.json')).env).toEqual(MIRROR_ENV(port, no, OTEL_ENV_NINE(port)));
      expect(readJson(path.join(no, '.artisyn', 'config', 'log-hub.json')).otelTraces).toBe(false);
      const bad = await runInstaller(cli, no, ['install', '--otel-traces=maybe'], { home, fakeClaudeDir: fakeClaude.dir });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('--otel-traces must be "yes" or "no"');
    });

    await test.step('11. the events of hooks.json are exactly the ones hook/INSTALL_HOOK.md documents', async () => {
      const hooksJson = readJson<{ hooks: Record<string, unknown> }>(path.join(plugin, 'hooks', 'hooks.json'));
      const documented = build.parseEventNamesFromInstallMd(fs.readFileSync(path.join(REPO_ROOT, 'hook', 'INSTALL_HOOK.md'), 'utf8'));
      expect(Object.keys(hooksJson.hooks).sort()).toEqual([...documented].sort());
    });

    await test.step('12. a legacy install under the shared «artisyn» name: reinstall moves it and the marketplace’s other plugin to the per-repo name, the disabled state carried over and re-enabled; a stale «artisyn» also registered at the user level (the real `claude plugin marketplace add` dedups by path and would otherwise keep that old name forever) is removed and both plugins reinstalled fresh under the new name, with no manual-steps warning', async () => {
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
      // The user-level registration the real CLI would already hold for this exact path, under the
      // legacy name — `checkUserLevelMarketplaceCollision`'s own source, not the project settings
      // file above. Nothing else in this suite writes to it, so seeding it here only affects this step.
      const legacyMarketplacePath = path.join(legacy, '.artisyn', 'marketplace');
      writeClaudeSettings(home, {
        extraKnownMarketplaces: { artisyn: { source: { source: 'directory', path: legacyMarketplacePath } } },
      });
      const callsBefore = fakeClaudeCalls(fakeClaude.callsLog).length;

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
      expect(res.output, 'the stale user-level name is cleared without any manual step').not.toContain('could not automatically register/activate');

      const newCalls = fakeClaudeCalls(fakeClaude.callsLog).slice(callsBefore);
      expect(newCalls).toEqual([
        ['plugin', 'marketplace', 'remove', 'artisyn'],
        ['plugin', 'marketplace', 'add', legacyMarketplacePath],
        ['plugin', 'install', `log-hub-hooks@${name}`, '--scope', 'project'],
        ['plugin', 'install', `other-tool@${name}`, '--scope', 'project'],
      ]);
    });

    await test.step('8b. a broken otel-receiver.js in the archive: a warning with the command to reproduce, exit 0, the port is not re-allocated', async () => {
      const archive = patchedPluginArchive(cli, dirs, {
        '.artisyn/marketplace/plugins/log-hub-hooks/scripts/otel-receiver.js': "'use strict';\nprocess.exit(3);\n",
      });
      const res = await runInstaller(cli, repo, ['install'], { home, fakeClaudeDir: fakeClaude.dir, env: { ARTISYN_HOOKS_ARCHIVE_PATH: archive } });
      expect(res.code, res.output).toBe(0);
      expect(res.output).toContain(`the OTEL receiver could not be verified on 127.0.0.1:${port}`);
      expect(res.output).toMatch(/node ".*otel-receiver\.js" --shared .*--port "?\d+/);
      expect(sharedPortOf(home)).toBe(port);
      expect(readJson(path.join(configDir, 'log-hub.local.json')).otelReceiverPort).toBe(port);
    });

    await test.step('8c. a project whose package.json says "type": "module": every hook script starts (the plugin pins CommonJS), the summary says ready, and the installed Stop hook uploads', async () => {
      const esm = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/inst01/esm.git' });
      fs.writeFileSync(path.join(esm, 'package.json'), `${JSON.stringify({ name: 'esm-app', type: 'module' }, null, 2)}\n`);
      fs.mkdirSync(path.join(esm, '.claude'));
      const res = await runInstaller(cli, esm, ['install', '--server-url', hub!.url, '--api-key', API_KEY], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toMatch(/✓ Hook scripts load with node v\d+\.\d+\.\d+ \((\d+)\/\1\)/);
      expect(res.stdout).toContain('Hooks are fully configured and ready to use.');
      const esmPlugin = pluginRoot(esm);
      expect(readJson(path.join(esmPlugin, 'scripts', 'package.json'))).toEqual({ type: 'commonjs' });

      const esmConfig = path.join(esm, '.artisyn', 'config', 'log-hub.json');
      fs.writeFileSync(esmConfig, JSON.stringify({ ...readJson(esmConfig), otelEnabled: false, sendLogsOnPromptEnabled: false }, null, 2));
      const telemetry = path.join(esm, '.artisyn', 'ai_work_dir', 'telemetry');
      fs.mkdirSync(telemetry, { recursive: true });
      fs.writeFileSync(path.join(telemetry, 'esm1.jsonl'), `${JSON.stringify({ event: 'prompt_start', session_id: 'esm1', prompt: 'hi' })}\n`);
      const stop = pluginHookCommands(esmPlugin, 'Stop').find((c) => c.args[0]?.endsWith('send-logs-hook.js'));
      const run = await runNodeScript(stop!.args[0], esm, JSON.stringify({ session_id: 'esm1', cwd: esm, hook_event_name: 'Stop' }), {
        home,
        env: { CLAUDE_PLUGIN_ROOT: esmPlugin },
      });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('require is not defined');
      expect(hub!.requests.filter((r) => r.path === '/api/v2/logs').map((r) => `${r.type}/${r.sessionId}`)).toContain('artisyn/esm1');
    });

    await test.step('8d. hook scripts that cannot start (an archive whose scripts/package.json says "type": "module"): exit 0, every failing script named with its error and the reproduce command, «not working yet» instead of «ready to use»', async () => {
      const archive = patchedPluginArchive(cli, dirs, {
        '.artisyn/marketplace/plugins/log-hub-hooks/scripts/package.json': '{ "type": "module" }\n',
      });
      const res = await runInstaller(cli, repo, ['install', '--server-url', hub!.url, '--api-key', API_KEY], {
        home,
        fakeClaudeDir: fakeClaude.dir,
        env: { ARTISYN_HOOKS_ARCHIVE_PATH: archive },
      });
      expect(res.code, res.output).toBe(0);
      expect(res.output).toMatch(/hook script\(s\) do not start with node v\d+/);
      expect(res.output).toMatch(/scripts\/send-logs-hook\.js: exit 1 — .*require is not defined in ES module scope/);
      expect(res.output).toMatch(/node ".*-hook\.js" --self-check/);
      expect(res.output).toMatch(/⚠ Hooks (installed|updated) \(hooks v[\d.]+\), but they are not working in this project yet:/);
      expect(res.stdout).not.toContain('Hooks are fully configured and ready to use.');
      expect(res.stdout).toContain('Hooks are configured, but not working yet');
      expect(res.stdout).not.toMatch(/✓ Hooks (installed|updated) successfully/);
    });

    const perProject = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/inst01/per-project.git' });
    await test.step('13, AC-A9. upgrade of a per-project-receiver install (otel-port.json, its own port in log-hub.local.json and in the local mirror, its receiver running): otel-port.json is deleted, otelReceiverPort and every endpoint move to the shared port, and the old receiver is left running to its idle-exit', async () => {
      fs.mkdirSync(path.join(perProject, '.claude'));
      const inst = await runInstaller(cli, perProject, ['install', '--server-url', hub!.url, '--api-key', API_KEY], { home, fakeClaudeDir: fakeClaude.dir });
      expect(inst.code, inst.output).toBe(0);
      const otelDir = path.join(perProject, '.artisyn', 'ai_work_dir', 'telemetry', 'otel');
      fs.mkdirSync(otelDir, { recursive: true });
      const { receiver, port: legacyPort } = await startReceiver(path.join(pluginRoot(perProject), 'scripts'), {
        dir: otelDir,
        owner: { gitRoot: perProject, repo: 'git@git.arrakis.test:scn/inst01/per-project.git' },
        idleTimeoutMs: 120_000,
      });
      try {
        // What an installer before hook 2.30.0 left behind.
        const ppConfig = path.join(perProject, '.artisyn', 'config');
        const legacyPortFile = path.join(ppConfig, 'otel-port.json');
        fs.writeFileSync(legacyPortFile, JSON.stringify({ port: legacyPort }, null, 2));
        const ppLocal = path.join(ppConfig, 'log-hub.local.json');
        fs.writeFileSync(ppLocal, JSON.stringify({ ...readJson(ppLocal), otelReceiverPort: legacyPort }, null, 2));
        const mirror = path.join(perProject, '.claude', 'settings.local.json');
        fs.writeFileSync(mirror, `${JSON.stringify({ env: OTEL_ENV(legacyPort) }, null, 2)}\n`);

        const up = await runInstaller(cli, perProject, ['upgrade'], { home, fakeClaudeDir: fakeClaude.dir });
        expect(up.code, up.output).toBe(0);
        expect(fs.existsSync(legacyPortFile), 'no stale per-project port store').toBe(false);
        expect(readJson(ppLocal).otelReceiverPort).toBe(port);
        expect(readJson(mirror).env).toEqual(MIRROR_ENV(port, perProject));
        expect(up.stdout).toContain(`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ${legacyPort} → ${port}`);
        expect(receiver.exitCode(), 'the per-project receiver is not stopped by the upgrade').toBeUndefined();
        await waitForPort(legacyPort, { timeoutMs: 1000 });
      } finally {
        await stopReceiver(receiver);
      }
    });

    await test.step('14, AC-A9. install --otel-port <free port Q>: port.json, ~/.claude/settings.json and the local mirror and otelReceiverPort of this and every other installed repo move to Q; the summary says to restart Claude Code; the receiver verifies on Q', async () => {
      const q = await freeLoopbackPort();
      const res = await runInstaller(cli, perProject, ['install', '--otel-port', String(q)], { home, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(0);
      expect(sharedPortOf(home)).toBe(q);
      const userEnv = readJson<{ env: Record<string, string> }>(userSettingsFile).env;
      expect(userEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${q}/v1/logs`);
      expect(userEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(`http://127.0.0.1:${q}/v1/metrics`);
      expect(userEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(`http://127.0.0.1:${q}/v1/traces`);
      for (const r of [perProject, repo]) {
        const mirrorEnv = readJson<{ env: Record<string, string> }>(path.join(r, '.claude', 'settings.local.json')).env;
        expect(mirrorEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, r).toBe(`http://127.0.0.1:${q}/v1/logs`);
        expect(mirrorEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, r).toBe(`http://127.0.0.1:${q}/v1/metrics`);
        expect(readJson(path.join(r, '.artisyn', 'config', 'log-hub.local.json')).otelReceiverPort, r).toBe(q);
      }
      expect(res.stdout).toContain(`to the shared OTEL receiver port ${q}.`);
      expect(res.stdout).toContain(`OTEL port pinned to ${q}`);
      expect(res.stdout).toContain('restart Claude Code');
      expect(res.stdout).toContain(`✓ OTEL receiver verified on 127.0.0.1:${q}`);
    });

    const managedHome = makeFakeHome(dirs);
    const managedRepo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/inst01/managed.git' });
    await test.step('15, AC-C1. managed OTEL (a managed logs endpoint in ARTISYN_MANAGED_SETTINGS_DIR): the managed message, ~/.claude/settings.json untouched with no backup, the local mirror and the repos.json entry still written', async () => {
      const managedUserFile = writeClaudeSettings(managedHome, USER_SCOPE_SETTINGS);
      const before = fs.readFileSync(managedUserFile, 'utf8');
      const managedDir = dirs.make('managed-settings');
      fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), JSON.stringify({
        env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://otel.corp.test/v1/logs' },
      }, null, 2));
      fs.mkdirSync(path.join(managedRepo, '.claude'));
      const res = await runInstaller(cli, managedRepo, ['install', '--server-url', hub!.url, '--api-key', API_KEY], {
        home: managedHome,
        fakeClaudeDir: fakeClaude.dir,
        env: { ARTISYN_MANAGED_SETTINGS_DIR: managedDir },
      });
      expect(res.code, res.output).toBe(0);
      expect(res.stdout).toContain('OTEL is managed by your organization — OTEL tabs are unavailable, everything else works.');
      expect(res.stdout).toContain('managed OTEL settings found in: managed-settings.json');
      expect(fs.readFileSync(managedUserFile, 'utf8'), 'no user OTEL key is written').toBe(before);
      expect(fs.existsSync(`${managedUserFile}.artisyn-bak`)).toBe(false);
      const managedPort = sharedPortOf(managedHome);
      expect(readJson(path.join(managedRepo, '.claude', 'settings.local.json')).env).toEqual(MIRROR_ENV(managedPort, managedRepo));
      const repos = readJson<{ repos: Array<{ repoKey: string }> }>(stateFile(managedHome, 'repos.json')).repos;
      expect(repos.map((r) => r.repoKey)).toEqual([repoKeyOf(managedRepo)]);
    });

    await test.step('16, AC-E1. SessionStart in that checkout on Claude Code 2.1.290 once the managed settings are gone (the keys only in the project mirror): hook.log has the version line claude-version=2.1.290 source=transcript and exactly one otel project-only warning naming the keys; the user is told too', async () => {
      const transcript = writeTranscript(dirs.make('transcript'), '2.1.290');
      const sessionId = 'inst01-project-only';
      let runs: Awaited<ReturnType<typeof runPluginEvent>> = [];
      try {
        runs = await runPluginEvent(
          pluginRoot(managedRepo),
          { hook_event_name: 'SessionStart', session_id: sessionId, cwd: managedRepo, transcript_path: transcript, source: 'startup' },
          { home: managedHome, env: { ARTISYN_MANAGED_SETTINGS_DIR: dirs.make('no-managed-settings') } },
        );
      } finally {
        await shutdownSharedReceiver(managedHome);
      }
      for (const r of runs) expect(r.code, r.stderr).toBe(0);
      const log = readHookLog(managedRepo).filter((l) => l.includes(sessionId));
      expect(log.filter((l) => l.includes('claude-version=2.1.290 source=transcript'))).toHaveLength(1);
      const warns = log.filter((l) => l.includes('otel project-only:'));
      expect(warns, log.join('\n')).toHaveLength(1);
      expect(warns[0]).toContain('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
      expect(warns[0]).toContain('~/.claude/settings.json');
      expect(runs.map((r) => r.stdout).join('\n')).toContain('Claude Code 2.1.282+ ignores for telemetry');
    });

    await test.step('17, AC-B3. a wrong-typed ~/.claude/settings.json (a number in env, an object for a hooks event): install exits 1 naming both keys, the file is unchanged byte for byte, no backup, nothing installed', async () => {
      const badHome = makeFakeHome(dirs);
      const badFile = writeClaudeSettings(badHome, { env: { MY_NUMBER: 42 }, hooks: { Stop: {} } });
      const before = fs.readFileSync(badFile, 'utf8');
      const target = makeFakeGitRepo(dirs);
      fs.mkdirSync(path.join(target, '.claude'));
      const res = await runInstaller(cli, target, ['install', '--server-url', hub!.url, '--api-key', API_KEY], { home: badHome, fakeClaudeDir: fakeClaude.dir });
      expect(res.code, res.output).toBe(1);
      expect(res.stderr).toContain('has values of the wrong type, so Claude Code skips the whole file');
      expect(res.stderr).toContain('"env.MY_NUMBER" must be a string (got number)');
      expect(res.stderr).toContain('"hooks.Stop" must be an array');
      expect(fs.readFileSync(badFile, 'utf8')).toBe(before);
      expect(fs.existsSync(`${badFile}.artisyn-bak`)).toBe(false);
      expect(fs.existsSync(pluginRoot(target)), 'nothing is installed').toBe(false);
      expect(fs.existsSync(stateFile(badHome, 'port.json'))).toBe(false);
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
