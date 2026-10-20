import { execSync, execFileSync, spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { extractTarGz, readTarEntry } from './tar';
import { stopExistingReceiverIfRunning } from './otel-restart';

export type CliFlags = { serverUrl?: string; apiKey?: string; otelPort?: number };

function checkServerConnection(serverUrl: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/log-echo', serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const body = '{}';
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
    req.write(body);
    req.end();
  });
}


// Identifiers for the plugin registered by the archive's marketplace/plugin manifests
// (see scripts/build-hooks-installer.js) — used when reading/writing `.claude/settings.json`'s
// `enabledPlugins`/`extraKnownMarketplaces` keys.
//
// The archive ships the marketplace as `artisyn`, but Claude Code registers a marketplace by name
// at the USER level (`claude plugin marketplace add` → `known_marketplaces.json`, the user
// settings and `plugins/cache/<name>/`). With one shared name every repo of a user re-pointed the
// single `artisyn` registration at itself, so the last installed repo won and all of them shared
// one plugin cache. Each repo therefore gets its own name, `artisyn-<8 hex>`, written into its
// marketplace.json. `artisyn` is still recognised as the legacy name and migrated on install/upgrade.
const LEGACY_MARKETPLACE_NAME = 'artisyn';
const MARKETPLACE_NAME_RE = /^artisyn-[0-9a-f]{8}$/;
const MARKETPLACE_SOURCE = { source: { source: 'directory', path: './.artisyn/marketplace' } } as const;

function pluginKey(marketplaceName: string): string {
  return `${PLUGIN_NAME}@${marketplaceName}`;
}

// Repo-root-relative paths inside the plugin tree (mirrors scripts/build-hooks-installer.js's
// MARKETPLACE_ROOT/PLUGIN_ROOT constants) — used both to locate entries inside the tar archive
// (forward-slash tar entry names) and, after extraction, the corresponding files on disk.
const MARKETPLACE_ROOT_REL = '.artisyn/marketplace';
const PLUGIN_ROOT_REL = `${MARKETPLACE_ROOT_REL}/plugins/log-hub-hooks`;
const PLUGIN_MANIFEST_REL = `${PLUGIN_ROOT_REL}/.claude-plugin/plugin.json`;
const CONFIG_TEMPLATE_REL = `${PLUGIN_ROOT_REL}/config-template/log-hub.json`;
const MARKETPLACE_MANIFEST_REL = `${MARKETPLACE_ROOT_REL}/.claude-plugin/marketplace.json`;
const PLUGIN_NAME = 'log-hub-hooks';

// The `artisyn` marketplace may also list plugins that are not ours (a project can drop its own
// plugin folder next to `log-hub-hooks` and add it to marketplace.json). The archive ships a
// marketplace.json listing only `log-hub-hooks`, so extraction alone would drop those entries;
// they are read before extraction and merged back after it. Uninstall likewise removes only
// `log-hub-hooks` while any other plugin is still listed.
function readForeignMarketplacePlugins(cwd: string): Array<Record<string, unknown>> {
  const manifest = readJsonConfig(relToPath(cwd, MARKETPLACE_MANIFEST_REL));
  const plugins = Array.isArray(manifest['plugins']) ? (manifest['plugins'] as unknown[]) : [];
  return plugins.filter(
    (entry): entry is Record<string, unknown> => isPlainObject(entry) && entry['name'] !== PLUGIN_NAME,
  );
}

function writeMarketplacePlugins(
  cwd: string,
  update: (plugins: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): void {
  const manifestPath = relToPath(cwd, MARKETPLACE_MANIFEST_REL);
  const manifest = readJsonConfig(manifestPath);
  const plugins = (Array.isArray(manifest['plugins']) ? (manifest['plugins'] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => isPlainObject(entry));
  writeJsonConfig(manifestPath, { ...manifest, plugins: update(plugins) });
}

function restoreForeignMarketplacePlugins(cwd: string, foreign: Array<Record<string, unknown>>): void {
  if (foreign.length === 0) return;
  writeMarketplacePlugins(cwd, plugins => {
    const names = new Set(plugins.map(entry => entry['name']));
    return [...plugins, ...foreign.filter(entry => !names.has(entry['name']))];
  });
}

/** The marketplace name in this repo's marketplace.json, or null when there is none. */
function installedMarketplaceName(cwd: string): string | null {
  const name = readJsonConfig(relToPath(cwd, MARKETPLACE_MANIFEST_REL))['name'];
  return typeof name === 'string' && name ? name : null;
}

// `git@host:org/repo.git`, `https://user@host/org/repo/` and `ssh://git@host/org/repo` all
// normalise to `host/org/repo`, so every clone of a repo derives the same marketplace name and the
// committed `.claude/settings.json` keys agree between teammates.
function normalizeRemoteUrl(url: string): string {
  return url.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

function repoIdentity(cwd: string): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (url) return normalizeRemoteUrl(url);
  } catch {
    // no git on PATH or no `origin` — fall back to the checkout path
  }
  return path.resolve(cwd).replace(/\\/g, '/').toLowerCase();
}

// Reuses the per-repo name already in marketplace.json (it is committed, so it stays stable even
// if `origin` later changes); otherwise derives `artisyn-<first 8 hex of sha256(repo identity)>`.
function resolveMarketplaceName(cwd: string): string {
  const current = installedMarketplaceName(cwd);
  if (current && MARKETPLACE_NAME_RE.test(current)) return current;
  const hash = crypto.createHash('sha256').update(repoIdentity(cwd)).digest('hex').slice(0, 8);
  return `${LEGACY_MARKETPLACE_NAME}-${hash}`;
}

function writeMarketplaceName(cwd: string, marketplaceName: string): void {
  const manifestPath = relToPath(cwd, MARKETPLACE_MANIFEST_REL);
  writeJsonConfig(manifestPath, { ...readJsonConfig(manifestPath), name: marketplaceName });
}

/** Names of every plugin listed in this repo's marketplace.json. */
function marketplacePluginNames(cwd: string): Set<string> {
  const manifest = readJsonConfig(relToPath(cwd, MARKETPLACE_MANIFEST_REL));
  const plugins = Array.isArray(manifest['plugins']) ? (manifest['plugins'] as unknown[]) : [];
  return new Set(
    plugins
      .filter((entry): entry is Record<string, unknown> => isPlainObject(entry) && typeof entry['name'] === 'string')
      .map(entry => entry['name'] as string),
  );
}
// Plugin files shipped by earlier versions and no longer in the archive. Extraction only writes,
// never deletes, so an upgrade removes them explicitly. The PreToolUse guardrail was removed in
// hook 2.19.0 (the hook is monitoring/logging only). Leftover `guardrail*` keys in an existing
// log-hub.json are deliberately left alone: an older hook reading a config without them would
// fall back to its own defaults, which turn the guardrail ON.
const OBSOLETE_PLUGIN_FILES_REL = [
  `${PLUGIN_ROOT_REL}/scripts/guardrail-hook.js`,
  `${PLUGIN_ROOT_REL}/docs/GUARDRAIL_SETTINGS.md`,
];
const OBSOLETE_PLUGIN_DIRS_REL = [`${PLUGIN_ROOT_REL}/docs`];

function removeObsoletePluginFiles(cwd: string): void {
  for (const rel of OBSOLETE_PLUGIN_FILES_REL) {
    try {
      fs.rmSync(relToPath(cwd, rel), { force: true });
    } catch (err) {
      console.warn(`Warning: could not remove obsolete ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const rel of OBSOLETE_PLUGIN_DIRS_REL) {
    try {
      fs.rmdirSync(relToPath(cwd, rel));
    } catch {
      // absent or not empty — either way nothing to do
    }
  }
}

function relToPath(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

// Matches only `command` values authored by earlier (pre-plugin) versions of this installer —
// i.e. legacy `hooks` entries pointing at `.claude/telemetry_tool/<name>-hook.js` — so surgical
// removal/detection never touches a user's own unrelated hook entries.
const INSTALLER_HOOK_COMMAND_RE = /\.claude[\\/]telemetry_tool[\\/](telemetry|lifecycle|send-logs|guardrail)-hook\.js/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function installerVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Legacy (pre-plugin) installed-version read. Retained solely to detect/label a pre-plugin
// install for migration purposes — the plugin-based source of truth for "what's installed now"
// is `readPluginVersion` below, reading the plugin manifest instead.
function installedHookVersion(claudeDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(claudeDir, 'telemetry_tool', 'version.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

// Reads the installed plugin's version from `.artisyn/marketplace/plugins/log-hub-hooks/
// .claude-plugin/plugin.json` on disk — the plugin-based equivalent of `installedHookVersion`,
// valid once a plugin-based install (fresh or migrated) has run at least once.
function readPluginVersion(cwd: string): string | null {
  try {
    const raw = fs.readFileSync(relToPath(cwd, PLUGIN_MANIFEST_REL), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function resolveArchivePath(): string {
  return process.env['ARTISYN_HOOKS_ARCHIVE_PATH'] ?? path.join(__dirname, 'hooks.tar.gz');
}

// The hook content version bundled in the archive is the actual version that will land in
// the installed plugin manifest after extraction — it's on a different numbering scheme than the
// installer CLI's own package.json version, so that must never be used for display here.
function bundledHookVersion(tarBuffer: Buffer): string {
  const entry = readTarEntry(tarBuffer, PLUGIN_MANIFEST_REL);
  if (entry) {
    try {
      const parsed = JSON.parse(entry.toString('utf8')) as { version?: string };
      if (parsed.version) {
        return parsed.version;
      }
    } catch {
      // fall through to installer version
    }
  }
  return installerVersion();
}

// Lightweight peek at the archive's bundled hook version, for printing "vX -> vY" messages
// before the real (mutating) decompress/extract in applyHooksUpdate runs.
function peekBundledHookVersion(): string {
  try {
    const archiveBuffer = fs.readFileSync(resolveArchivePath());
    const tarBuffer = zlib.gunzipSync(archiveBuffer);
    return bundledHookVersion(tarBuffer);
  } catch {
    return installerVersion();
  }
}

// Reads telemetry_tool/.env then overlays telemetry_tool/.env.local (if present).
// Local values win on conflict — mirrors the pre-plugin hook's env-context.js#loadEnvWithLocal.
// Used only for the pre-migration `upgrade` connection check (see `readEffectiveServerCreds`).
function loadInstalledEnv(claudeDir: string): Record<string, string> {
  const envPath = path.join(claudeDir, 'telemetry_tool', '.env');
  const base = fs.existsSync(envPath) ? parseEnvVars(fs.readFileSync(envPath, 'utf8')) : {};
  const localPath = `${envPath}.local`;
  const local = fs.existsSync(localPath) ? parseEnvVars(fs.readFileSync(localPath, 'utf8')) : {};
  return { ...base, ...local };
}

function parseEnvVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

// Migration is triggered when either signal of a pre-plugin install is present: the legacy
// `.env` file, or installer-authored `hooks` entries still in `.claude/settings.json` (the
// latter can outlive a manually-deleted `telemetry_tool/` directory).
function needsMigration(claudeDir: string): boolean {
  const legacyEnvPath = path.join(claudeDir, 'telemetry_tool', '.env');
  if (fs.existsSync(legacyEnvPath)) {
    return true;
  }
  return settingsHasInstallerHooks(readSettingsFileSafe(path.join(claudeDir, 'settings.json')));
}

// Converts the legacy `.env`/`.env.local` pair into the two partial `LogHubConfig` objects that
// get folded into `log-hub.json`/`log-hub.local.json` during migration. Mirrors the precedence
// the pre-plugin hook used (`.env.local` overrides `.env`, key by key) by resolving each scalar
// key against the merged `{...base, ...local}` map; only `apiKey` (the one secret key) is routed
// to the `local` half — every other resolved value lands in `base`, matching "only filling keys
// absent from an already-existing log-hub.json" (existing log-hub.json content still wins later,
// in `mergeConfig`/`mergeConfigLocal`).
function convertLegacyEnvToConfigParts(claudeDir: string): {
  base: Record<string, unknown>;
  local: Record<string, unknown>;
} {
  const envPath = path.join(claudeDir, 'telemetry_tool', '.env');
  const baseVars = fs.existsSync(envPath) ? parseEnvVars(fs.readFileSync(envPath, 'utf8')) : {};
  const localVars = fs.existsSync(`${envPath}.local`) ? parseEnvVars(fs.readFileSync(`${envPath}.local`, 'utf8')) : {};
  const merged = { ...baseVars, ...localVars };

  const str = (key: string): string | undefined => {
    const v = merged[key];
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const bool = (key: string): boolean | undefined => {
    const v = str(key);
    return v === undefined ? undefined : v.toLowerCase() === 'true';
  };
  const num = (key: string): number | undefined => {
    const v = str(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const base: Record<string, unknown> = {};
  const assignBase = (key: string, value: unknown): void => { if (value !== undefined) base[key] = value; };
  assignBase('serverUrl', str('SERVER_URL'));
  assignBase('telemetryDir', str('TELEMETRY_DIR'));
  assignBase('jsonCompact', bool('JSON_COMPACT'));
  assignBase('sendLogsTimeoutMs', num('SEND_LOGS_TIMEOUT_MS'));

  const context: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith('CTX_')) {
      const ctxKey = key.slice(4).toLowerCase();
      if (ctxKey) context.push({ key: ctxKey, value });
    }
  }
  if (context.length > 0) base['context'] = context;

  const local: Record<string, unknown> = {};
  const apiKey = str('API_KEY');
  if (apiKey !== undefined) local['apiKey'] = apiKey;

  return { base, local };
}

// Paranoia re-read/re-parse after a migration write, per design decision 5's atomicity ordering —
// a failure here aborts before the settings.json write, so a crash mid-migration never loses data.
function verifyWrittenJson(filePath: string): void {
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Error: failed to verify migrated config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Removes a directory tree, demoting any failure (EBUSY/EPERM/EACCES — e.g. a file locked by a
// running process) to a warning instead of failing the overall run. A leftover directory is
// simply retried the next time install/upgrade/uninstall runs, since this is always called
// against a directory whose presence is re-checked on every invocation.
function deleteDirWithRetryWarning(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    console.warn(
      `Warning: could not remove ${dirPath}${code ? ` (${code})` : ''} — leftover files remain; ` +
      'this will be retried on the next install/upgrade/uninstall run.',
    );
  }
}

// Relocates the legacy `<repo-root>/.ai_work_dir/` (hook.log, hook-recommendations.json,
// telemetry/) into `.artisyn/ai_work_dir/`, alongside the plugin's other `.artisyn/` state. Moved
// entry-by-entry (not a single directory rename) so a destination that already has some content —
// e.g. a hook already ran once after the new code landed but before this step got to run — is never
// clobbered; the legacy dir is deleted only once fully drained. Re-checked every run, not gated on
// `needsMigration`, since a repo may have already completed the plugin migration before this
// relocation shipped (exactly this repo's own case). A lock (EBUSY/EPERM on Windows) or partial
// failure mid-move leaves whatever's left in the legacy dir to retry on the next run.
function migrateLegacyWorkDir(cwd: string): void {
  const legacyDir = path.join(cwd, '.ai_work_dir');
  if (!fs.existsSync(legacyDir)) return;

  const newDir = path.join(cwd, '.artisyn', 'ai_work_dir');
  try {
    fs.mkdirSync(newDir, { recursive: true });
    const gitignorePath = path.join(newDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n!.gitignore\n');
    }
    for (const entry of fs.readdirSync(legacyDir)) {
      const src = path.join(legacyDir, entry);
      const dst = path.join(newDir, entry);
      if (fs.existsSync(dst)) continue; // never clobber data already at the new location
      fs.renameSync(src, dst);
    }
    if (fs.readdirSync(legacyDir).length === 0) {
      fs.rmdirSync(legacyDir);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    console.warn(
      `Warning: could not fully relocate ${legacyDir} to ${newDir}${code ? ` (${code})` : ''} — ` +
      'this will be retried on the next install/upgrade run.',
    );
  }
}

// Removes the `timeout-on-upload`/`broken-upload-file` recommendation entries (if present) via
// the freshly-extracted plugin's own `recommendations.js#removeRecommendation` — dynamically
// required from `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` (already extracted by the
// time this is called), rather than reimplementing its file format here. Best-effort: recommendation
// bookkeeping must never fail install/upgrade.
function cleanupLegacyRecommendations(cwd: string): void {
  try {
    const recommendationsPath = relToPath(cwd, `${PLUGIN_ROOT_REL}/scripts/recommendations.js`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(recommendationsPath) as { removeRecommendation: (cwd: string, rule: string) => void };
    mod.removeRecommendation(cwd, 'timeout-on-upload');
    mod.removeRecommendation(cwd, 'broken-upload-file');
  } catch {
    // Best-effort only.
  }
}

// Printed after every successful install and upgrade, so the person running the installer sees
// what the hook will send and where, before the next Claude Code session starts uploading.
function printDataCollectionNotice(serverUrl: string | undefined): void {
  console.log('');
  console.log('Data collection notice:');
  console.log(`  The hook uploads to ${serverUrl ?? '(server URL not set yet)'}:`);
  console.log('  - full Claude Code transcripts of this project (prompts, tool inputs/results, file contents,');
  console.log('    command output), including earlier sessions still on disk; transcripts are not redacted');
  console.log('  - git metadata (remote URL without credentials, user.name, branch) and project context');
  console.log('  - Claude Code OpenTelemetry records: OTEL export is enabled through the "env" block in');
  console.log('    .claude/settings.json and sent to a local receiver, which the hook uploads');
  console.log('  See "What is collected" in the hook README (hook/README.md) for the full list.');
  console.log('');
}

// Wraps an argument in double quotes for the `cmd.exe /d /s /c "..."` command line that
// resolveClaudeInvocation() builds for a `.cmd`/`.bat` shim, escaping embedded `"`. Also used to
// print the human-readable remediation commands with the marketplace path quoted.
function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export interface ClaudeInvocation {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}

// Design decision 29: resolves how to run the `claude` CLI with the given arguments WITHOUT
// `shell: true`. A shell spawn joins argv into one command line unquoted and is flagged by Node
// (DEP0190) when argv is passed alongside it, so every path argument had to be pre-quoted by hand.
//  - Windows: `where claude` lists the PATH hits. The first `.exe` hit is executed directly. A
//    `.cmd`/`.bat` shim (npm's usual install) cannot be exec'd without a shell (Node refuses with
//    EINVAL), so it goes through `cmd.exe /d /s /c "<quoted shim> <quoted args>"` with
//    `windowsVerbatimArguments`, so Node does not re-quote the command line we built.
//  - POSIX: `claude` with the raw arguments; execFileSync looks it up on PATH with no shell.
//  - Not found: a failed `where` (non-zero exit) or no usable hit throws, and a missing binary on
//    POSIX surfaces as ENOENT from the exec — the caller turns either into warnManualSteps().
export function resolveClaudeInvocation(args: string[]): ClaudeInvocation {
  if (process.platform !== 'win32') {
    return { file: 'claude', args, options: {} };
  }
  const output = execFileSync('where', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const hits = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const exe = hits.find(hit => /\.exe$/i.test(hit));
  if (exe) {
    return { file: exe, args, options: {} };
  }
  const shim = hits.find(hit => /\.(cmd|bat)$/i.test(hit));
  if (!shim) {
    throw new Error('claude CLI not found on PATH');
  }
  const commandLine = [quoteShellArg(shim), ...args.map(quoteShellArg)].join(' ');
  return {
    file: process.env['ComSpec'] || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: { windowsVerbatimArguments: true },
  };
}

// Design decision 8: writing `extraKnownMarketplaces`/`enabledPlugins` into `.claude/settings.json`
// alone does not register the marketplace, cache the plugin, or activate any hook — the two
// `claude` CLI calls below are required, non-optional steps. Both are run through
// resolveClaudeInvocation() (no shell; each argument stays a discrete array element, the raw
// marketplace path included) and are individually non-fatal: a `claude` binary that cannot be
// resolved, an `ENOENT`, or a non-zero exit from either call is caught and demoted to a printed
// warning naming both exact remediation commands, in order — this must never throw out of
// runInstall/runUpgrade, since the settings/config files are already correctly written by the
// time this runs.
// `claude plugin marketplace add <path>` dedups by directory path, not by the name declared in
// marketplace.json: if this exact path is already known at the user level under a DIFFERENT name
// (the pre-per-repo-name legacy `artisyn`, or a second plugin this same marketplace lists that got
// registered separately), `add` is a silent no-op that reports "already on disk" and keeps the OLD
// name — the current `marketplaceName` is never created, so every later `claude plugin install
// <x>@<marketplaceName>` fails with "not found in marketplace". Scans the user-level
// `extraKnownMarketplaces` (same source `checkUserLevelMarketplaceCollision` reads) for an entry
// whose path matches ours under a name other than the one we're activating now.
function findStaleUserLevelMarketplaceName(cwd: string, marketplaceName: string): string | undefined {
  const userSettings = readSettingsFileSafe(getUserSettingsPath());
  const userMarketplaces = isPlainObject(userSettings?.extraKnownMarketplaces)
    ? (userSettings!.extraKnownMarketplaces as Record<string, unknown>)
    : {};
  const norm = (p: string): string => {
    const resolved = path.resolve(cwd, p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const ourPath = norm(relToPath(cwd, MARKETPLACE_ROOT_REL));
  for (const [name, entry] of Object.entries(userMarketplaces)) {
    if (name === marketplaceName) continue;
    const entryPath = isPlainObject(entry) && isPlainObject(entry['source'])
      ? (entry['source'] as Record<string, unknown>)['path']
      : undefined;
    if (typeof entryPath === 'string' && norm(entryPath) === ourPath) return name;
  }
  return undefined;
}

function runClaudePluginActivation(cwd: string, marketplaceName: string, listedPlugins: Set<string>): void {
  const marketplacePath = path.join(cwd, '.artisyn', 'marketplace');
  const marketplaceAddArgs = ['plugin', 'marketplace', 'add', marketplacePath];
  const pluginInstallArgs = ['plugin', 'install', pluginKey(marketplaceName), '--scope', 'project'];

  const warnManualSteps = (): void => {
    console.warn(
      'Warning: could not automatically register/activate the Claude Code plugin. ' +
      'Run these commands manually, in order:\n' +
      `  claude plugin marketplace add ${quoteShellArg(marketplacePath)}\n` +
      `  claude ${pluginInstallArgs.join(' ')}`,
    );
  };

  const runClaude = (args: string[]): void => {
    const inv = resolveClaudeInvocation(args);
    execFileSync(inv.file, inv.args, { cwd, stdio: 'ignore', ...inv.options });
  };

  // Clear a stale same-path registration first so `add` below actually creates the current name
  // instead of silently confirming the old one. Failure here just falls through to the same
  // "already on disk" no-op `add` would have hit anyway, so it's safe to ignore.
  const staleName = findStaleUserLevelMarketplaceName(cwd, marketplaceName);
  let rebindSiblings = false;
  if (staleName) {
    try {
      runClaude(['plugin', 'marketplace', 'remove', staleName]);
      rebindSiblings = true;
    } catch {
      // fall through — `add` will report the pre-existing state, same as if there were no stale name
    }
  }

  try {
    runClaude(marketplaceAddArgs);
  } catch {
    warnManualSteps();
    return;
  }

  try {
    runClaude(pluginInstallArgs);
  } catch {
    warnManualSteps();
    return;
  }

  // Removing the stale marketplace name above also drops every OTHER plugin that was registered
  // under it (e.g. a second plugin this repo's own marketplace lists) — `mergeSettings` already
  // renamed their `enabledPlugins` keys to the current name, but renaming alone doesn't re-cache
  // them, so reinstall each one or it just silently disappears.
  if (rebindSiblings) {
    for (const plugin of listedPlugins) {
      if (plugin === PLUGIN_NAME) continue;
      try {
        runClaude(['plugin', 'install', `${plugin}@${marketplaceName}`, '--scope', 'project']);
      } catch {
        console.warn(
          `Warning: could not automatically reinstall "${plugin}@${marketplaceName}" after moving it off ` +
          `the legacy "${staleName}" marketplace name. Run manually:\n` +
          `  claude plugin install ${plugin}@${marketplaceName} --scope project`,
        );
      }
    }
  }
}

// Reads the currently-installed JSON config (base + local, local overriding base per key) for
// the installer's own use (the `upgrade` connection check) — a simplified installer-side
// equivalent of the hook's `loadConfig`; it doesn't need the hook's default/coercion table since
// it only ever reads `serverUrl`/`apiKey`.
function readInstalledConfig(cwd: string): Record<string, unknown> {
  const configDir = path.join(cwd, '.artisyn', 'config');
  const base = readJsonConfig(path.join(configDir, 'log-hub.json'));
  const local = readJsonConfig(path.join(configDir, 'log-hub.local.json'));
  return { ...base, ...local };
}

// Resolves the server URL/API key to verify connectivity against before an `upgrade` proceeds —
// from the legacy `.env`/`.env.local` pair pre-migration, or the JSON config post-migration.
function readEffectiveServerCreds(cwd: string, claudeDir: string, migrating: boolean): { serverUrl?: string; apiKey?: string } {
  if (migrating) {
    const env = loadInstalledEnv(claudeDir);
    return { serverUrl: env['SERVER_URL'], apiKey: env['API_KEY'] };
  }
  const config = readInstalledConfig(cwd);
  return {
    serverUrl: typeof config['serverUrl'] === 'string' ? config['serverUrl'] as string : undefined,
    apiKey: typeof config['apiKey'] === 'string' ? config['apiKey'] as string : undefined,
  };
}

// The telemetry destination currently configured for this project, normalised the same way
// `--server-url` is (trailing slashes stripped) so a purely cosmetic difference never reads as a
// destination change. Resolves through the same legacy-`.env`/JSON split as
// `readEffectiveServerCreds` — a pre-migration install keeps its `SERVER_URL` across the upgrade,
// which is exactly the silent-carry-over case worth surfacing.
function readInstalledServerUrl(cwd: string, claudeDir: string): string | undefined {
  const { serverUrl } = readEffectiveServerCreds(cwd, claudeDir, needsMigration(claudeDir));
  const trimmed = serverUrl?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

// Shared file-mutation logic used by both `install` (reinstall/update path) and `upgrade`:
// decompress the bundled archive, extract the plugin tree over the repo root, convert the legacy
// `.env`/`.env.local` pair into JSON config when migrating, write `.artisyn/config/log-hub.json`
// (+ `log-hub.local.json` for secrets), merge `.claude/settings.json`, activate the plugin via the
// `claude` CLI, and — when migrating — delete the now-superseded `.claude/telemetry_tool/`.
//
// Ordering follows design decision 5: convert env → JSON (verified by re-read) → settings.json
// read-modify-write → plugin activation (non-fatal) → legacy directory delete. Each step is gated
// on the previous step's success, so a crash mid-migration always leaves a resumable state.
async function applyHooksUpdate(
  claudeDir: string,
  cwd: string,
  overrides: Record<string, string>,
): Promise<{ newVersion: string; marketplaceName: string }> {
  const archivePath = resolveArchivePath();
  let archiveBuffer: Buffer;

  try {
    archiveBuffer = fs.readFileSync(archivePath);
  } catch (err) {
    console.error(`Error: Failed to read hooks archive at ${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let tarBuffer: Buffer;
  try {
    tarBuffer = await gunzip(archiveBuffer);
  } catch (err) {
    console.error(`Error: Failed to decompress archive: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const newVersion = bundledHookVersion(tarBuffer);
  const migrating = needsMigration(claudeDir);
  const legacyParts = migrating
    ? convertLegacyEnvToConfigParts(claudeDir)
    : { base: {} as Record<string, unknown>, local: {} as Record<string, unknown> };

  // Resolved once per run and used twice below: it is written into
  // `log-hub.json` and into the `.claude/settings.json` env block, which is what keeps the two in
  // agreement. This sits on the shared install/upgrade path deliberately: upgrade is the only
  // route by which an existing user starts receiving OTEL, so it must allocate and write exactly
  // as a fresh install does.
  //
  // Resolved before extraction so the stop-before-install step immediately
  // below has a port to target — a stale receiver from a previous install must be stopped before
  // its own files are overwritten on disk.
  const otelPort = await resolveInstallOtelPort(
    overrides['OTEL_PORT'] ? { otelPort: Number(overrides['OTEL_PORT']) } : undefined,
    cwd,
  );

  // Required-but-non-fatal: stop any receiver already running on the resolved
  // port before its files are overwritten, so an older-version process isn't left holding the port
  // (or holding stale code) across the update. Never blocks/fails the install.
  await stopExistingReceiverIfRunning(otelPort, cwd);

  // Tar entries are repo-root-relative (e.g. `.artisyn/marketplace/...`) — extract over the repo
  // root, not `.claude/`. This writes the plugin tree, including the config-template file read below.
  const foreignMarketplacePlugins = readForeignMarketplacePlugins(cwd);
  // Read before extraction: the archive's marketplace.json carries the legacy shared name.
  const marketplaceName = resolveMarketplaceName(cwd);
  extractTarGz(tarBuffer, cwd);
  restoreForeignMarketplacePlugins(cwd, foreignMarketplacePlugins);
  writeMarketplaceName(cwd, marketplaceName);
  removeObsoletePluginFiles(cwd);

  // --- Step 1 (migration only, but the write path is shared with a plain install/upgrade): ---
  // build/merge `.artisyn/config/log-hub.json` and `log-hub.local.json`.
  const configDir = path.join(cwd, '.artisyn', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const logHubJsonPath = path.join(configDir, 'log-hub.json');
  const logHubLocalJsonPath = path.join(configDir, 'log-hub.local.json');

  const templateObj = readJsonConfig(relToPath(cwd, CONFIG_TEMPLATE_REL));

  const overridesBase: Record<string, unknown> = {};
  if (overrides['SERVER_URL']) overridesBase['serverUrl'] = overrides['SERVER_URL'];
  // Always an override, never a merge input: `otel-port.json` is authoritative, so the project's
  // own `otelReceiverPort` is overwritten from it every run and the two files cannot drift. It
  // must go in as a `Number` — `CONFIG_TYPES.otelReceiverPort` is `'number'` hook-side, and a
  // string would be silently discarded by `matchesType` at runtime.
  overridesBase['otelReceiverPort'] = Number(otelPort);
  const overridesLocal: Record<string, unknown> = {};
  if (overrides['API_KEY']) overridesLocal['apiKey'] = overrides['API_KEY'];

  const existingBase = readJsonConfig(logHubJsonPath);
  const templateForMerge = migrating ? { ...templateObj, ...legacyParts.base } : templateObj;
  const mergedBase = mergeConfig(templateForMerge, existingBase, overridesBase);
  writeJsonConfig(logHubJsonPath, mergedBase);

  const existingLocal = readJsonConfig(logHubLocalJsonPath);
  const localForMerge = migrating ? { ...legacyParts.local, ...existingLocal } : existingLocal;
  const mergedLocal = mergeConfigLocal(localForMerge, overridesLocal);
  const willWriteLocal = Object.keys(mergedLocal).length > 0;
  if (willWriteLocal) {
    writeJsonConfig(logHubLocalJsonPath, mergedLocal);
    ensureConfigIgnored(cwd, logHubLocalJsonPath);
  }

  if (migrating) {
    verifyWrittenJson(logHubJsonPath);
    if (willWriteLocal) verifyWrittenJson(logHubLocalJsonPath);
  }

  // --- Step 2: single read-modify-write of `.claude/settings.json`. ---
  const listedPlugins = marketplacePluginNames(cwd);
  mergeSettings(claudeDir, otelPort, marketplaceName, listedPlugins);

  // Design decision 8 — required, non-fatal, immediately after the settings write, for both a
  // fresh install and a migration.
  runClaudePluginActivation(cwd, marketplaceName, listedPlugins);

  // The post-install smoke test — same required-but-non-fatal contract as the
  // activation above, and for the same reason: by now the port is written everywhere, so a
  // failure is a diagnosis rather than a retry trigger.
  await verifyInstalledReceiver(otelPort, cwd);

  // --- Step 3 (migration only): delete the now-superseded legacy directory and clean up any
  // recommendations it produced. Re-checked (not gated on `migrating`) so a delete failure from a
  // prior run is retried here too.
  const legacyToolDir = path.join(claudeDir, 'telemetry_tool');
  if (fs.existsSync(legacyToolDir)) {
    cleanupLegacyRecommendations(cwd);
    deleteDirWithRetryWarning(legacyToolDir);
  }

  // Re-checked every run (see migrateLegacyWorkDir's own comment) — not gated on `migrating`.
  migrateLegacyWorkDir(cwd);

  return { newVersion, marketplaceName };
}

export async function runInstall(flags?: CliFlags): Promise<void> {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, '.git'))) {
    console.error('Error: .git directory not found. Run this command from the root of a git repository.');
    process.exit(1);
  }

  // Best-effort/non-blocking — see warnIfClaudeCodeLikelyRunning's doc comment.
  warnIfClaudeCodeLikelyRunning();

  const claudeDir = path.join(cwd, '.claude');
  if (!fs.existsSync(claudeDir)) {
    const answer = await prompt('Warning: .claude/ directory not found. Create it now? [Y/n] ');
    if (answer.toLowerCase() === 'n') {
      console.error('Aborted.');
      process.exit(1);
    }
    fs.mkdirSync(claudeDir);
  }

  // `readPluginVersion` is the plugin-based source of truth; the legacy `installedHookVersion`
  // read is consulted only as a fallback so a pre-migration install still gets a "current
  // version" label for the messaging below (see readPluginVersion's/installedHookVersion's doc
  // comments).
  const currentVersion = readPluginVersion(cwd) ?? installedHookVersion(claudeDir);
  const newVersion = peekBundledHookVersion();

  // Full-auto mode: check server connection before making any changes
  // Only in TTY mode — non-interactive environments skip the check and prompt.
  const isFullAuto = !!(flags?.serverUrl && flags?.apiKey);
  if (isFullAuto && process.stdin.isTTY) {
    console.log('checking server connection ...');
    try {
      const reply = await checkServerConnection(flags!.serverUrl!, flags!.apiKey!);
      console.log(`server reply: ${reply.trim()}`);
    } catch (err) {
      console.error(`Error: Failed to connect to server at ${flags!.serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const answer = await prompt('proceed with installation? [Y/n] ');
    if (answer.toLowerCase() === 'n') {
      console.error('Aborted.');
      process.exit(1);
    }
  }

  if (currentVersion) {
    if (currentVersion === newVersion) {
      console.log(`Reinstalling hooks v${newVersion}...`);
    } else {
      console.log(`Updating hooks v${currentVersion} → v${newVersion}...`);
    }
  } else {
    console.log(`Installing hooks v${newVersion}...`);
  }

  // Build overrides from CLI flags
  const overrides: Record<string, string> = {};
  if (flags?.serverUrl) {
    overrides['SERVER_URL'] = flags.serverUrl.replace(/\/+$/, '');
  }
  if (flags?.apiKey) {
    overrides['API_KEY'] = flags.apiKey;
  }
  // `overrides` is a string map, so the number round-trips through `String(...)` here and
  // `Number(...)` in `applyHooksUpdate`. `index.ts` has already validated it as an integer 1-65535.
  if (flags?.otelPort !== undefined) {
    overrides['OTEL_PORT'] = String(flags.otelPort);
  }

  // Telemetry-destination guard. `serverUrl` is the only thing deciding where session logs (and the
  // API key header) are sent, and nothing in the hook hardcodes a host — so silently repointing an
  // existing install at a different server is the one change here worth an explicit confirmation.
  // TTY-only: a non-interactive/CI run still gets the warning line but is never blocked on stdin.
  const previousServerUrl = readInstalledServerUrl(cwd, claudeDir);
  const nextServerUrl = overrides['SERVER_URL'];
  if (nextServerUrl && previousServerUrl && previousServerUrl !== nextServerUrl) {
    console.warn(`Warning: this changes the telemetry destination: ${previousServerUrl} -> ${nextServerUrl}`);
    console.warn('  All session logs from this project will be uploaded to the new server.');
    if (process.stdin.isTTY) {
      const answer = await prompt('continue? [Y/n] ');
      if (answer.toLowerCase() === 'n') {
        console.error('Aborted.');
        process.exit(1);
      }
    }
  }

  const { marketplaceName } = await applyHooksUpdate(claudeDir, cwd, overrides);

  // Security warning if API key was passed on the command line
  if (flags?.apiKey) {
    console.warn('Warning: API key was passed on the command line. It may be visible in your shell history.');
  }

  const hasServerUrl = !!flags?.serverUrl;
  const hasApiKey = !!flags?.apiKey;

  console.log(`✓ Hooks ${currentVersion && currentVersion !== newVersion ? 'updated' : 'installed'} successfully! (hooks v${newVersion})`);
  console.log('');
  console.log('Plugin registered in .claude/settings.json:');
  console.log(`  enabledPlugins["${pluginKey(marketplaceName)}"] = true`);
  console.log(`  extraKnownMarketplaces.${marketplaceName}.source.path = "${MARKETPLACE_SOURCE.source.path}"`);
  console.log('');
  console.log('Config written to .artisyn/config/log-hub.json (and log-hub.local.json for secrets)');
  // Read back post-update, so this reports what is actually on disk — including a `serverUrl` that
  // was inherited from an existing config or carried over by the legacy `.env` migration rather
  // than passed on this command line.
  const installedServerUrl = readInstalledServerUrl(cwd, claudeDir);
  console.log(`Telemetry destination: ${installedServerUrl ?? '(not set)'}`);
  printDataCollectionNotice(installedServerUrl);

  if (hasServerUrl && hasApiKey) {
    console.log('Hooks are fully configured and ready to use.');
    // Only verify in TTY mode — claude may not be on PATH in non-interactive environments
    if (process.stdin.isTTY) {
      console.log('');
      verifyHookInstallation(cwd);
    }
  } else if (hasServerUrl) {
    console.log('Next step: add your API key to .artisyn/config/log-hub.local.json');
    console.log('  { "apiKey": "<your-key>" }');
  } else if (hasApiKey) {
    console.log('Next step: set serverUrl in .artisyn/config/log-hub.json');
    console.log('  { "serverUrl": "<your-server-url>" }');
  } else {
    console.log('Next step: add your API key to .artisyn/config/log-hub.local.json');
    console.log('  { "apiKey": "<your-key>" }');
    console.log('and set serverUrl in .artisyn/config/log-hub.json');
    console.log('  { "serverUrl": "<your-server-url>" }');
  }
}

/**
 * Default wait for the post-install smoke test.
 *
 * Generous on purpose. `claude -p` does not exit until the hooks this installer just registered
 * finish their Stop/SessionEnd work, and send-logs-hook's Stop handler flushes the telemetry
 * backlog before releasing the process — measured at ~25s against a ~20k-file backlog, and it
 * scales with the backlog rather than with anything about this install. The previous 30s cap
 * therefore expired on perfectly healthy installs, and because `execSync` surfaces a timeout as
 * Node's raw `spawnSync <shell> ETIMEDOUT`, a successful install printed what read as a hard
 * failure. The old cap also SIGTERM'd the session mid-upload, so raising it is a correctness fix
 * and not just a cosmetic one.
 */
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

/** `ARTISYN_VERIFY_TIMEOUT_MS=0` skips the smoke test; anything unparseable falls back. */
function resolveVerifyTimeoutMs(): number {
  const raw = process.env.ARTISYN_VERIFY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_VERIFY_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_VERIFY_TIMEOUT_MS;
}

/**
 * Advisory post-install smoke test: boots one real `claude -p` session in the project.
 *
 * By the time this runs the hooks are already on disk and registered in settings.json, so no
 * outcome here can mean "the install failed" — every branch says so explicitly instead of
 * printing a bare error string that implies otherwise.
 */
function verifyHookInstallation(cwd: string): void {
  const timeoutMs = resolveVerifyTimeoutMs();
  if (timeoutMs === 0) {
    console.log('Skipping hook verification (ARTISYN_VERIFY_TIMEOUT_MS=0).');
    return;
  }

  const waitSeconds = Math.round(timeoutMs / 1000);
  console.log(
    `Verifying hook installation (up to ${waitSeconds}s — the test session must flush its own telemetry before it can exit)...`,
  );

  try {
    const reply = execSync('claude -p "reply \'OK\'"', {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd,
      // stderr piped rather than inherited, so a failure is reported through the branches below
      // instead of interleaving raw subprocess noise into the install output.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    console.log(reply ? `✓ Hook test reply: ${reply}` : '✓ Hook test session ran (no output returned).');
  } catch (err) {
    const { code, stderr } = (err ?? {}) as { code?: unknown; stderr?: unknown };

    if (code === 'ETIMEDOUT') {
      console.log(`- Verification inconclusive: \`claude\` did not exit within ${waitSeconds}s.`);
      console.log('  The hooks ARE installed and registered. This only means the test session');
      console.log('  outlived the wait, which a large telemetry backlog alone is enough to cause.');
      console.log('  Hook activity for that session: .artisyn/ai_work_dir/hook.log');
      return;
    }

    const detail =
      (typeof stderr === 'string' && stderr.trim()) || (err instanceof Error ? err.message : String(err));
    console.log('- Verification did not run; the hooks are installed and registered regardless.');
    console.log(`  ${detail.split('\n')[0].trim()}`);
    console.log('  Usual cause is no `claude` binary on PATH, which is harmless here.');
  }
}

export async function runUpgrade(): Promise<void> {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, '.git'))) {
    console.error('Error: .git directory not found. Run this command from the root of a git repository.');
    process.exit(1);
  }

  // Best-effort/non-blocking — see warnIfClaudeCodeLikelyRunning's doc comment.
  warnIfClaudeCodeLikelyRunning();

  const claudeDir = path.join(cwd, '.claude');

  const currentVersion = readPluginVersion(cwd) ?? installedHookVersion(claudeDir);
  if (currentVersion === null) {
    console.error('Error: Hooks are not installed in this project. Run the `install` command instead.');
    process.exit(1);
  }

  const migrating = needsMigration(claudeDir);
  const { serverUrl, apiKey } = readEffectiveServerCreds(cwd, claudeDir, migrating);
  if (!serverUrl || !apiKey) {
    console.error('Error: serverUrl/apiKey not configured — cannot verify connection.');
    process.exit(1);
  }

  // Named up front, not only in the failure branch below: an upgrade keeps whatever destination the
  // project already had, and a successful check against a stale server is otherwise invisible.
  console.log(`Telemetry destination: ${serverUrl}`);
  console.log('checking server connection ...');
  try {
    await checkServerConnection(serverUrl, apiKey);
    console.log('Server connection OK.');
  } catch (err) {
    console.error(`Error: Failed to connect to server at ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const newVersion = peekBundledHookVersion();
  if (currentVersion === newVersion) {
    console.log(`Hooks already at latest version v${currentVersion}. Re-applying...`);
  } else {
    console.log(`Upgrading hooks v${currentVersion} → v${newVersion}...`);
  }

  // Re-adding an already-known marketplace and re-installing an already-installed plugin at the
  // same version are both documented no-ops (design decision 8) — this call is safe (and required)
  // on every upgrade run, migrating or not.
  await applyHooksUpdate(claudeDir, cwd, {});

  if (currentVersion === newVersion) {
    console.log(`✓ Hooks already at latest version v${newVersion} (re-applied).`);
    console.log(`  Previous version: v${currentVersion}`);
    console.log(`  Current version:  v${newVersion}`);
  } else {
    console.log('✓ Hooks upgraded successfully!');
    console.log(`  Previous version: v${currentVersion}`);
    console.log(`  New version:      v${newVersion}`);
  }
  printDataCollectionNotice(serverUrl);
}

// Removes `.artisyn/marketplace/`, `.artisyn/config/`, and the two plugin-related
// `.claude/settings.json` keys. The settings-key removal is reported successful even when one or
// both directory deletes fail (demoted to a warning, retried on the next install/upgrade/uninstall
// run) — it is an independent, already-durable step by the time the deletes are attempted.
// While marketplace.json still lists another plugin, only `plugins/log-hub-hooks/` and its entry
// are removed, and `extraKnownMarketplaces.<name>` stays so that plugin keeps loading. Keys under
// the legacy shared `artisyn` name are removed too.
export function runUninstall(): void {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, '.git'))) {
    console.error('Error: .git directory not found. Run this command from the root of a git repository.');
    process.exit(1);
  }

  // Best-effort/non-blocking — see warnIfClaudeCodeLikelyRunning's doc comment.
  warnIfClaudeCodeLikelyRunning();

  const claudeDir = path.join(cwd, '.claude');
  const foreignMarketplacePlugins = readForeignMarketplacePlugins(cwd);
  const keepMarketplace = foreignMarketplacePlugins.length > 0;
  const marketplaceName = installedMarketplaceName(cwd) ?? LEGACY_MARKETPLACE_NAME;
  removePluginSettingsKeys(claudeDir, marketplaceName, { keepMarketplace });
  removeStoredOtelPort(cwd);

  if (keepMarketplace) {
    writeMarketplacePlugins(cwd, plugins => plugins.filter(entry => entry['name'] !== PLUGIN_NAME));
    deleteDirWithRetryWarning(relToPath(cwd, PLUGIN_ROOT_REL));
  } else {
    deleteDirWithRetryWarning(path.join(cwd, '.artisyn', 'marketplace'));
  }
  deleteDirWithRetryWarning(path.join(cwd, '.artisyn', 'config'));

  console.log('✓ Hooks uninstalled.');
  if (keepMarketplace) {
    const names = foreignMarketplacePlugins.map(entry => String(entry['name'])).join(', ');
    console.log(`  Removed enabledPlugins["${pluginKey(marketplaceName)}"] from .claude/settings.json`);
    console.log(`  Removed ${PLUGIN_ROOT_REL}/ and .artisyn/config/`);
    console.log(`  Kept the ${marketplaceName} marketplace (${MARKETPLACE_ROOT_REL}/) — it still lists: ${names}`);
  } else {
    console.log(`  Removed enabledPlugins["${pluginKey(marketplaceName)}"] / extraKnownMarketplaces.${marketplaceName} from .claude/settings.json`);
    console.log('  Removed .artisyn/marketplace/ and .artisyn/config/');
  }
}

function gunzip(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// ---------------------------------------------------------------------------
// JSON config types & helpers (plugin-based install — .artisyn/config/*.json)
// ---------------------------------------------------------------------------

// A subset of the hook-side default/type table in hook/.claude/telemetry_tool/env-context.js
// (CONFIG_DEFAULTS/CONFIG_TYPES, 19 keys) — only the keys the installer itself reads or writes,
// plus the secret-only `apiKey`, which has no default (an absent/empty value simply skips
// uploads) and lives only in log-hub.local.json. The hook-side keys not typed here
// (sendLogsOnPrompt*, mcpProbeTimeoutMs, turnEndCostAdvisor*, sessionAttribution*) are still
// preserved verbatim when an existing config is merged; their defaults live only in env-context.js.
export type LogHubConfig = {
  telemetryDir: string;
  jsonCompact: boolean;
  context: Array<{ key: string; value: string }>;
  serverUrl: string;
  sendLogsTimeoutMs: number;
  // OTEL receiver keys. `otelReceiverPort` is written by the installer from the per-project
  // allocation (see the port-allocation section below) — `0` only ever means "never allocated".
  // `otelReceiverMaxBodyKb` is in KiB; the spawning hook converts it to bytes.
  otelEnabled: boolean;
  otelReceiverPort: number;
  otelReceiverIdleTimeoutMs: number;
  otelReceiverMaxBodyKb: number;
  otelRetentionDays: number;
  apiKey?: string;
};

// Write to a temp file in the same directory, then rename into place, so a hook invocation
// reading the file concurrently with an install always observes either the fully-old or
// fully-new content, never a partial write.
function atomicWrite(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

// Reads and parses a JSON config file. A missing file, malformed JSON, or a non-object root all
// resolve to {} — there is nothing to preserve from a file that isn't valid JSON, matching how
// tolerant today's line-based .env parsing is of content it can't make sense of.
function readJsonConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// Serializes and atomically writes a config object as pretty-printed JSON. Accepts a plain
// Record rather than a strict Partial<LogHubConfig> — merge results legitimately carry
// unrecognized keys through untouched (see mergeConfig's doc comment).
function writeJsonConfig(filePath: string, obj: Record<string, unknown>): void {
  atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
}

// Merge strategy for `.artisyn/config/log-hub.json` — adapts today's line-based `mergeEnv` to
// JSON objects: template structure wins (the key set freshly extracted from the archive), but
// any key already set in the existing file keeps its existing value; keys present in the
// existing file but absent from the template are preserved as-is (unrecognized keys survive);
// CLI overrides always win over both the template default and the preserved existing value.
function mergeConfig(
  templateObj: Record<string, unknown>,
  existing: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...templateObj };

  for (const key of Object.keys(templateObj)) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      merged[key] = existing[key];
    }
  }

  for (const key of Object.keys(existing)) {
    if (!Object.prototype.hasOwnProperty.call(templateObj, key)) {
      merged[key] = existing[key];
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }

  return merged;
}

// Merge strategy for `.artisyn/config/log-hub.local.json` — adapts today's `mergeEnvLocal`:
// there is no shipped template (it's never part of the tar archive — gitignored, user-owned
// secret storage), so every existing key is preserved untouched and only CLI overrides are
// applied or appended.
function mergeConfigLocal(
  existing: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }
  return merged;
}

// Verifies a `.artisyn/config/` file is actually git-ignored (via `git check-ignore`, which
// accounts for every applicable .gitignore, not just a local one). If it is not ignored, checks
// whether it is already tracked by git (`git ls-files --error-unmatch`) — if so, hard-aborts with
// a remediation message instead of silently letting secrets land in a tracked file. Otherwise,
// adds an entry to `.artisyn/config/.gitignore` (creating the file if it doesn't exist yet). On
// POSIX platforms, restricts the file to owner-only (mode 0o600) after writing; skipped on win32,
// which has no equivalent ACL primitive — a documented, accepted risk there.
//
// `opts.secret` (default `true`) is what `log-hub.local.json` needs: a tracked file is a hard
// abort and the file is chmod'ed 0600. `otel-port.json` passes `secret: false` — it must be
// gitignored (a committed port would be inherited by every checkout, manufacturing exactly the
// collisions the randomisation avoids), but it holds no secret, so a
// tracked one is a printed warning rather than a reason to abort an otherwise-fine install.
function ensureConfigIgnored(cwd: string, localConfigPath: string, opts: { secret?: boolean } = {}): void {
  const secret = opts.secret !== false;
  const entry = path.basename(localConfigPath);
  const relPath = path.relative(cwd, localConfigPath).split(path.sep).join('/');

  let alreadyIgnored = false;
  try {
    execSync(`git check-ignore -q "${relPath}"`, { cwd, stdio: 'ignore' });
    alreadyIgnored = true;
  } catch {
    // Non-zero exit — either not ignored, or `git check-ignore` itself failed; either way
    // fall through and make sure it's covered, since the safe default is to protect secrets.
  }

  if (!alreadyIgnored) {
    let alreadyTracked = false;
    try {
      execSync(`git ls-files --error-unmatch "${relPath}"`, { cwd, stdio: 'ignore' });
      alreadyTracked = true;
    } catch {
      // Non-zero exit — not tracked by git; proceed normally.
    }

    if (alreadyTracked) {
      if (secret) {
        console.error(
          `Error: ${relPath} is already tracked by git and is about to receive secrets. ` +
          `Remove it from version control first (e.g. \`git rm --cached ${relPath}\`), commit that ` +
          'removal, then re-run the installer.',
        );
        process.exit(1);
      }
      console.warn(
        `Warning: ${relPath} is tracked by git — it is per-checkout state and should not be ` +
        `shared. Remove it from version control (e.g. \`git rm --cached ${relPath}\`) and commit ` +
        'that removal.',
      );
    }

    const gitignorePath = path.join(path.dirname(localConfigPath), '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const alreadyListed = existing.split(/\r?\n/).some(line => line.trim() === entry);
    if (!alreadyListed) {
      const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
      atomicWrite(gitignorePath, existing + (needsLeadingNewline ? '\n' : '') + `${entry}\n`);
      console.log(`Note: ${relPath} was not git-ignored — added it to ${path.relative(cwd, gitignorePath).split(path.sep).join('/')}`);
    }
  }

  if (secret && process.platform !== 'win32' && fs.existsSync(localConfigPath)) {
    try {
      fs.chmodSync(localConfigPath, 0o600);
    } catch {
      // Best-effort — a chmod failure should not fail the install.
    }
  }
}

// ---------------------------------------------------------------------------
// OTEL receiver port — per-project allocation, store and post-install smoke test
//
// ---------------------------------------------------------------------------

// The never-installed / probe-exhausted fallback. Duplicated deliberately from
// `OTEL_FALLBACK_PORT` in hook/.claude/telemetry_tool/env-context.js and `DEFAULT_PORT` in
// otel-receiver.js — none of the three can import from another; tests pin them together.
export const OTEL_FALLBACK_PORT_INSTALLER = 25317;

// The allocation range. A fixed default port is wrong twice over: 4318 collides with a user's own
// collector, and any fixed choice is a guess. Staying above 25000 keeps well clear of the
// registered-service range and of the ports development tooling habitually grabs.
export const OTEL_PORT_MIN = 25000;
export const OTEL_PORT_MAX = 65535;

// 65535 − 25000 + 1 = 40536 slots, treated as a hash table walked by open addressing.
export const OTEL_PORT_RANGE = OTEL_PORT_MAX - OTEL_PORT_MIN + 1;

// Probe step for that walk. It MUST stay coprime with OTEL_PORT_RANGE (40536 = 2^3 × 3^2 × 563)
// — that is what makes the sequence visit all 40536 ports exactly once before repeating. 7919 is
// prime and shares no factor with it. **2, 3 and 563 are invalid steps**: they would cycle through
// only a fraction of the range. Do not "simplify" this to 1 or to any small number. A large prime
// also spreads consecutive probes far apart, so a project that collides once does not then collide
// with its neighbour's next candidate.
export const PROBE_STEP = 7919;

// Reaching this bound means essentially every port tried was unusable, so the fallback applies.
const OTEL_MAX_PROBES = 1000;

// Post-install smoke test budgets. The spawned receiver self-exits shortly after the probe, so a
// failed verification never leaves a listener behind.
const OTEL_VERIFY_IDLE_TIMEOUT_MS = 5000;
const OTEL_VERIFY_DEADLINE_MS = 10000;
const OTEL_VERIFY_REQUEST_TIMEOUT_MS = 2000;

// Attempts the loopback round-trip probe makes before calling a port unusable — see the comment
// at the retry itself.
const ROUND_TRIP_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function isUsablePortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= OTEL_PORT_MAX;
}

// `.artisyn/config/otel-port.json` — the authoritative record of this project's allocated port.
// It sits beside `log-hub.json` but is gitignored: `log-hub.json` is committed, and a committed
// port would be inherited by every teammate's checkout and by every second checkout on one
// machine, manufacturing exactly the collisions the randomisation avoids.
function otelPortFilePath(cwd: string): string {
  return path.join(cwd, '.artisyn', 'config', 'otel-port.json');
}

// The stored port, or null when the file is missing/malformed or holds an unusable value — in
// every one of those cases the caller allocates a fresh one.
function readStoredOtelPort(cwd: string): number | null {
  const stored = readJsonConfig(otelPortFilePath(cwd));
  const port = stored['port'];
  return isUsablePortNumber(port) ? port : null;
}

function writeStoredOtelPort(cwd: string, port: number): void {
  const filePath = otelPortFilePath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, JSON.stringify({ port, allocatedAt: new Date().toISOString() }, null, 2) + '\n');
}

// Closes a probe server, resolving either way — `close()` on a server that never managed to listen
// invokes its callback with ERR_SERVER_NOT_RUNNING, which is not an error worth propagating here.
function closeProbeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

// POST a JSON body to 127.0.0.1 and return the status/body, or null for any transport failure or
// timeout. Used by both the loopback round-trip probe and the post-install smoke test.
function postLoopbackJson(
  port: number,
  requestPath: string,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; body: string } | null> {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Check 1 — can anything bind 127.0.0.1:<port> at all.
async function probeBind(port: number): Promise<boolean> {
  const server = net.createServer();
  try {
    // A persistent listener (not `once`): a late error after the promise settled must not surface
    // as an unhandled 'error' event and take the installer down.
    return await new Promise<boolean>(resolve => {
      server.on('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port }, () => resolve(true));
    });
  } catch {
    return false;
  } finally {
    await closeProbeServer(server);
  }
}

// Check 2 — a real HTTP round-trip on the same port. This catches what a bind probe misses: a
// local proxy or security product intercepting loopback, or an IPv4/IPv6 binding mismatch that
// would leave the real receiver unreachable at the address Claude Code posts to.
async function probeLoopbackRoundTrip(port: number): Promise<boolean> {
  const token = crypto.randomBytes(8).toString('hex');
  const server = http.createServer((req, res) => {
    let received = '';
    req.on('error', () => { /* client vanished — the probe below reports the failure */ });
    req.on('data', (chunk: Buffer) => { received += chunk.toString(); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(received);
    });
  });

  try {
    const listening = await new Promise<boolean>(resolve => {
      server.on('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port }, () => resolve(true));
    });
    if (!listening) return false;

    // Retried on a transport failure, not on a bad reply: Windows resets the first connection to a
    // port whose previous listener (the bind probe just above) closed microseconds earlier, which
    // would otherwise reject a perfectly good port. A reply that arrives but is wrong is final.
    const body = JSON.stringify({ probe: token });
    let reply: { status: number; body: string } | null = null;
    for (let attempt = 0; attempt < ROUND_TRIP_ATTEMPTS; attempt++) {
      reply = await postLoopbackJson(port, '/probe', body, OTEL_VERIFY_REQUEST_TIMEOUT_MS);
      if (reply) break;
      await delay(50);
    }
    return !!reply && reply.status === 200 && reply.body.includes(token);
  } catch {
    return false;
  } finally {
    await closeProbeServer(server);
  }
}

// A candidate port is usable only when it passes **both** checks — bindability alone is not "it
// works". A failure of either is treated as busy and the allocation walk continues.
export async function isPortUsable(port: number): Promise<boolean> {
  if (!isUsablePortNumber(port)) return false;
  if (!(await probeBind(port))) return false;
  return probeLoopbackRoundTrip(port);
}

// Allocate this project's receiver port by prime-step probing (open addressing over the range),
// not a linear scan: a random origin plus an extra random displacement, then steps of PROBE_STEP.
// Because gcd(PROBE_STEP, OTEL_PORT_RANGE) === 1 the sequence covers the whole range before
// repeating, so the bound below is only ever reached when the machine really has nothing usable.
export async function allocateOtelPort(): Promise<number> {
  const origin = crypto.randomInt(0, OTEL_PORT_RANGE);
  const shift = crypto.randomInt(1000, 2001);

  for (let i = 0; i < OTEL_MAX_PROBES; i++) {
    const candidate = OTEL_PORT_MIN + ((origin + shift + i * PROBE_STEP) % OTEL_PORT_RANGE);
    if (await isPortUsable(candidate)) return candidate;
  }

  console.warn(
    `Warning: could not find a usable loopback port after ${OTEL_MAX_PROBES} probes — ` +
    `falling back to ${OTEL_FALLBACK_PORT_INSTALLER}.`,
  );
  return OTEL_FALLBACK_PORT_INSTALLER;
}

// OTEL port resolution order, first match wins:
//   1. `--otel-port <n>` — explicit operator override, persisted like any other value.
//   2. the `port` in `.artisyn/config/otel-port.json` — stable across reinstalls and upgrades.
//   3. a fresh allocation.
// The result is always persisted (so an override or a first allocation is stable from then on) and
// the store is always confirmed gitignored. The project's own `otelReceiverPort` in `log-hub.json`
// is deliberately **not** an input — it is an output, always rewritten from this value, so the two
// files cannot drift.
export async function resolveInstallOtelPort(flags: CliFlags | undefined, cwd: string): Promise<number> {
  let port: number;

  if (flags && isUsablePortNumber(flags.otelPort)) {
    port = flags.otelPort;
  } else {
    port = readStoredOtelPort(cwd) ?? await allocateOtelPort();
  }

  writeStoredOtelPort(cwd, port);
  ensureConfigIgnored(cwd, otelPortFilePath(cwd), { secret: false });
  return port;
}

// Deletes `.artisyn/config/otel-port.json` — project-scoped state with no consumer once the
// plugin is gone. Called explicitly by `uninstall` (which also removes the whole config
// directory) so the port record is dropped even if that directory delete has to be retried.
function removeStoredOtelPort(cwd: string): void {
  try {
    fs.rmSync(otelPortFilePath(cwd), { force: true });
  } catch {
    // Best-effort — the `.artisyn/config/` delete that follows covers it, and a leftover port
    // file is inert once the plugin is uninstalled.
  }
}

// The `env` block the installer writes into `.claude/settings.json`. Claude
// Code exposes these to the hook process as real env vars, which is how the spawning hook learns
// the endpoint the exporter actually posts to.
//
// `OTEL_EXPORTER_OTLP_COMPRESSION` is set explicitly so the payload encoding never depends on an
// exporter default; the receiver still handles gzip/deflate, so a user who overrides it is not
// silently dropped.
//
// `OTEL_METRIC_EXPORT_INTERVAL` overrides Claude Code's 60 s metrics default. Metrics use delta
// temporality, so a shorter interval does not change any total — it only shrinks the unexported
// tail lost when a session stops mid-window (the Stop upload can land seconds after the last
// export). 10 s bounds that loss while staying 6x cheaper in volume than the 5 s logs stream.
// Per-request cost still comes from the `api_request` log events, which are unaffected by this.
export function OTEL_ENV_KEYS(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  };
}

// Uninstall guard: the nine keys are removed only while the logs endpoint
// still points at a loopback receiver — i.e. it is still ours. If the user has repointed it at
// their own collector, the whole `env` block is left untouched.
const OTEL_LOOPBACK_LOGS_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/v1\/logs$/;

// Post-install smoke test: spawn the *real* `otel-receiver.js` from the installed plugin tree with
// a short idle timeout, POST a synthetic `/artisyn/register`, and confirm `200`. This verifies the
// shipped artifact end to end, not just the port.
//
// Required but non-fatal, with a remediation line — the same contract as
// `runClaudePluginActivation`: by the time this runs the port is already written everywhere, so a
// failure is a diagnosis, not a retry trigger. It never re-allocates.
//
// The receiver writes into a throwaway temp directory, never the project's real otel directory, so
// the check leaves no files behind. If a receiver for this project is already listening (a
// re-install during a live session), the spawned one exits on EADDRINUSE and the probe verifies
// the running one instead — an equally valid answer to "is this port serving this project".
export async function verifyInstalledReceiver(port: number, cwd: string): Promise<boolean> {
  const receiverPath = relToPath(cwd, `${PLUGIN_ROOT_REL}/scripts/otel-receiver.js`);
  const ownerArg = JSON.stringify({ gitRoot: cwd, repo: path.basename(cwd) });

  const warnUnverified = (reason: string): void => {
    console.warn(
      `Warning: the OTEL receiver could not be verified on 127.0.0.1:${port} (${reason}). ` +
      'Claude Code telemetry may not be captured. To diagnose, run it in the foreground:\n' +
      `  node "${receiverPath}" --port ${port} --dir "${path.join(os.tmpdir(), 'artisyn-otel-check')}" ` +
      `--owner "${ownerArg.replace(/"/g, '\\"')}"\n` +
      '  (then re-install with `--otel-port <n>` to move it to a different port)',
    );
  };

  if (!fs.existsSync(receiverPath)) {
    warnUnverified(`receiver script not found at ${receiverPath}`);
    return false;
  }

  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artisyn-otel-verify-'));
  } catch (err) {
    warnUnverified(`could not create a temporary directory: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [
      receiverPath,
      '--port', String(port),
      '--dir', tmpDir,
      '--owner', ownerArg,
      '--idleTimeoutMs', String(OTEL_VERIFY_IDLE_TIMEOUT_MS),
    ], { cwd, stdio: 'ignore', windowsHide: true });
    // Without a listener, a spawn failure (e.g. a missing node) is an uncaught 'error' event.
    child.on('error', () => { /* reported by the polling loop below as "no reply" */ });

    const payload = JSON.stringify({
      sessionId: `installer-verify-${process.pid}`,
      gitRoot: cwd,
      repo: path.basename(cwd),
      hookVersion: installerVersion(),
    });

    // Poll until something answers: a transport failure means the receiver has not finished
    // binding yet (or never will), while *any* HTTP reply is a final answer — a non-200 from a
    // listener that is already up will not become a 200 by asking again.
    const deadline = Date.now() + OTEL_VERIFY_DEADLINE_MS;
    let last: { status: number; body: string } | null = null;
    for (;;) {
      last = await postLoopbackJson(port, '/artisyn/register', payload, OTEL_VERIFY_REQUEST_TIMEOUT_MS);
      if (last || Date.now() >= deadline) break;
      await delay(150);
    }

    if (!last) {
      warnUnverified('no reply from the receiver');
      return false;
    }
    if (last.status !== 200) {
      warnUnverified(`the listener on that port answered ${last.status} — it may belong to another project or another program`);
      return false;
    }

    console.log(`✓ OTEL receiver verified on 127.0.0.1:${port}`);
    return true;
  } catch (err) {
    warnUnverified(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // Already gone (the usual case: it exited on EADDRINUSE).
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort — a temp directory the OS will clean up anyway must not fail the install.
    }
  }
}

// Reads and parses a settings.json-shaped file for read-only inspection (duplicate-hooks
// detection, user-level marketplace collision checks). Unlike `mergeSettings`'s own parse of
// `.claude/settings.json`, a missing or malformed file here is not an error — there is nothing
// to warn about that can be attributed to a file that doesn't exist or can't be parsed.
function readSettingsFileSafe(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// True if any `hooks` entry in the given settings object has a `command` authored by an earlier
// version of this installer (see `INSTALLER_HOOK_COMMAND_RE`).
function settingsHasInstallerHooks(settings: Record<string, unknown> | null): boolean {
  if (!isPlainObject(settings?.hooks)) {
    return false;
  }
  for (const matcherEntries of Object.values(settings!.hooks as Record<string, unknown>)) {
    if (!Array.isArray(matcherEntries)) continue;
    for (const matcherEntry of matcherEntries) {
      const hooksArr = isPlainObject(matcherEntry) ? matcherEntry['hooks'] : undefined;
      if (!Array.isArray(hooksArr)) continue;
      for (const hook of hooksArr) {
        const command = isPlainObject(hook) ? hook['command'] : undefined;
        if (typeof command === 'string' && INSTALLER_HOOK_COMMAND_RE.test(command)) {
          return true;
        }
      }
    }
  }
  return false;
}

// Removes only installer-authored hook entries from a parsed `hooks` block, pruning any
// matcher/event entry left empty as a result, and dropping the whole `hooks` key only if every
// event ends up empty. A user's own unrelated hook entries (any `command` that doesn't match
// `INSTALLER_HOOK_COMMAND_RE`) are preserved byte-for-byte.
function removeInstallerHookEntries(hooksBlock: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [eventName, matcherEntries] of Object.entries(hooksBlock)) {
    if (!Array.isArray(matcherEntries)) {
      // Not the shape we expect — leave it untouched rather than risk destroying user data.
      result[eventName] = matcherEntries;
      continue;
    }

    const prunedMatchers = matcherEntries
      .map((matcherEntry: unknown) => {
        if (!isPlainObject(matcherEntry) || !Array.isArray(matcherEntry['hooks'])) {
          return matcherEntry;
        }
        const prunedHooks = (matcherEntry['hooks'] as unknown[]).filter((hook) => {
          const command = isPlainObject(hook) ? hook['command'] : undefined;
          return !(typeof command === 'string' && INSTALLER_HOOK_COMMAND_RE.test(command));
        });
        return { ...matcherEntry, hooks: prunedHooks };
      })
      .filter((matcherEntry: unknown) => {
        if (!isPlainObject(matcherEntry) || !Array.isArray(matcherEntry['hooks'])) {
          return true;
        }
        return (matcherEntry['hooks'] as unknown[]).length > 0;
      });

    if (prunedMatchers.length > 0) {
      result[eventName] = prunedMatchers;
    }
  }

  return result;
}

// Warns (without modifying anything) when the same installer-authored hook commands are also
// present in files this installer never writes to: the project's own `.claude/settings.local.json`
// and the user-level `~/.claude/settings.json`. Left in place, either would cause every hook
// event to be recorded twice once the plugin is also active.
function warnDuplicateHooks(claudeDir: string): void {
  const candidates: Array<{ filePath: string; label: string }> = [
    { filePath: path.join(claudeDir, 'settings.local.json'), label: '.claude/settings.local.json' },
    { filePath: getUserSettingsPath(), label: getUserSettingsLabel() },
  ];

  for (const { filePath, label } of candidates) {
    if (settingsHasInstallerHooks(readSettingsFileSafe(filePath))) {
      console.warn(`Warning: telemetry hooks also found in ${label} - remove them or events will be recorded twice.`);
    }
  }
}

// Claude Code's user-level config dir: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude` — the same
// directory the `claude plugin` commands this installer runs read and write.
function getCustomClaudeConfigDir(): string | null {
  const custom = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  return custom ? path.resolve(custom) : null;
}

function getUserSettingsPath(): string {
  return path.join(getCustomClaudeConfigDir() ?? path.join(os.homedir(), '.claude'), 'settings.json');
}

function getUserSettingsLabel(): string {
  return getCustomClaudeConfigDir() ? '$CLAUDE_CONFIG_DIR/settings.json' : '~/.claude/settings.json';
}

// Detects a marketplace name collision at the user level: `claude plugin marketplace add` records
// this repo's marketplace under its name in `~/.claude/settings.json`, so an entry with the same
// name pointing at ANOTHER directory (a second checkout of the same repo, or an unrelated tool)
// will be re-pointed here by the activation step. The installer itself never edits that file —
// it only reports. An entry pointing at this repo's own marketplace is our previous install.
function checkUserLevelMarketplaceCollision(cwd: string, marketplaceName: string): void {
  const userSettings = readSettingsFileSafe(getUserSettingsPath());
  const userMarketplaces = isPlainObject(userSettings?.extraKnownMarketplaces)
    ? (userSettings!.extraKnownMarketplaces as Record<string, unknown>)
    : {};
  if (!Object.prototype.hasOwnProperty.call(userMarketplaces, marketplaceName)) return;
  const entry = userMarketplaces[marketplaceName];
  const registeredPath = isPlainObject(entry) && isPlainObject(entry['source'])
    ? (entry['source'] as Record<string, unknown>)['path']
    : undefined;
  const norm = (p: string): string => {
    const resolved = path.resolve(cwd, p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (typeof registeredPath === 'string' && norm(registeredPath) === norm(relToPath(cwd, MARKETPLACE_ROOT_REL))) return;
  console.warn(
    `Warning: a "${marketplaceName}" marketplace is already registered in ${getUserSettingsLabel()} ` +
    `(user level) for ${typeof registeredPath === 'string' ? `"${registeredPath}"` : 'another source'} — ` +
    'another checkout of this repo or an unrelated registration; plugin activation re-points it to this repo.',
  );
}

// Best-effort, non-blocking heuristic for "Claude Code is probably running right now" — used
// only to print an advisory warning during install/upgrade/uninstall, never to block or alter
// behavior. `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` are set in the environment of processes Claude
// Code itself spawns (e.g. this installer running from inside a hook or a `Bash` tool call); a
// resident `claude` process is a weaker but still useful second signal. Any failure here (the
// process-list command not existing, permissions, etc.) is swallowed — this check must never
// fail the overall run.
function warnIfClaudeCodeLikelyRunning(): void {
  try {
    if (process.env['CLAUDECODE'] || process.env['CLAUDE_CODE_ENTRYPOINT']) {
      console.warn(
        'Warning: this appears to be running from inside an active Claude Code session. If Claude ' +
        'Code has this project open, restart it once the install/upgrade/uninstall finishes so it ' +
        'picks up the updated hook configuration.',
      );
      return;
    }

    const psCommand = process.platform === 'win32'
      ? 'tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH'
      : 'ps -A -o comm=';
    const output = execSync(psCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    const running = process.platform === 'win32'
      ? /claude\.exe/i.test(output)
      : /(^|\/)claude$/im.test(output);

    if (running) {
      console.warn(
        'Warning: a Claude Code process is likely running. If it has this project open, restart it ' +
        'once the install/upgrade/uninstall finishes so it picks up the updated hook configuration.',
      );
    }
  } catch {
    // Best-effort only — never fail the run because the process check itself failed.
  }
}

// Reads `.claude/settings.json` for a mutation: a parse failure hard-aborts (no silent `{}`
// fallback) and a `.claude/settings.json.bak` snapshot is written before the caller mutates
// anything. Shared by `mergeSettings` (install/upgrade) and `removePluginSettingsKeys` (uninstall)
// so both go through the same abort/backup contract.
function readSettingsForMutation(claudeDir: string): { settingsPath: string; existing: Record<string, unknown> } {
  const settingsPath = path.join(claudeDir, 'settings.json');

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error('Error: .claude/settings.json is not valid JSON - fix it and re-run');
      process.exit(1);
    }
    if (!isPlainObject(existing)) {
      console.error('Error: .claude/settings.json is not valid JSON - fix it and re-run');
      process.exit(1);
    }

    // Snapshot before any mutation, so a bad merge or crash mid-write can always be recovered from.
    atomicWrite(`${settingsPath}.bak`, raw);
  }

  return { settingsPath, existing };
}

// Surgical read-modify-write of `.claude/settings.json`:
//  - A parse failure hard-aborts (no silent `{}` fallback) — the file is never blindly overwritten.
//  - A `.claude/settings.json.bak` snapshot is written before any mutation.
//  - Only `hooks` entries authored by an earlier version of this installer are removed; everything
//    else in the file (including a user's own hook entries) survives untouched.
//  - Legacy shared name: `extraKnownMarketplaces.artisyn` pointing at `./.artisyn/marketplace` is
//    dropped, and `<plugin>@artisyn` keys of `log-hub-hooks` and of every other plugin this
//    marketplace lists move to `<plugin>@<marketplaceName>`, keeping their value.
//  - `enabledPlugins['log-hub-hooks@<marketplaceName>']` is set to `true` (re-enabling it, with a
//    notice, if it had been explicitly disabled) and `extraKnownMarketplaces.<marketplaceName>` is
//    (re)pointed at the bundled marketplace directory, warning if it previously pointed elsewhere.
//  - The OTEL `env` block is merged per-key fill-if-absent: the user's own
//    values always win, and the keys left untouched are reported in one `Note:` line.
function mergeSettings(
  claudeDir: string,
  otelPort: number,
  marketplaceName: string,
  listedPlugins: Set<string>,
): void {
  const { settingsPath, existing } = readSettingsForMutation(claudeDir);

  const merged: Record<string, unknown> = { ...existing };

  // Remove only installer-authored hook entries; prune emptied matcher/event entries; drop the
  // whole `hooks` key only if nothing is left in it.
  if (isPlainObject(existing['hooks'])) {
    const prunedHooks = removeInstallerHookEntries(existing['hooks'] as Record<string, unknown>);
    if (Object.keys(prunedHooks).length > 0) {
      merged['hooks'] = prunedHooks;
    } else {
      delete merged['hooks'];
    }
  }

  const enabledPlugins: Record<string, unknown> = isPlainObject(existing['enabledPlugins'])
    ? { ...(existing['enabledPlugins'] as Record<string, unknown>) }
    : {};
  const marketplaces: Record<string, unknown> = isPlainObject(existing['extraKnownMarketplaces'])
    ? { ...(existing['extraKnownMarketplaces'] as Record<string, unknown>) }
    : {};
  const sourcePath = (entry: unknown): unknown =>
    isPlainObject(entry) && isPlainObject(entry['source'])
      ? (entry['source'] as Record<string, unknown>)['path']
      : undefined;

  // Legacy shared `artisyn` name → this repo's own name.
  if (marketplaceName !== LEGACY_MARKETPLACE_NAME) {
    const legacyIsOurs = sourcePath(marketplaces[LEGACY_MARKETPLACE_NAME]) === MARKETPLACE_SOURCE.source.path;
    const legacySuffix = `@${LEGACY_MARKETPLACE_NAME}`;
    const moved: string[] = [];
    for (const key of Object.keys(enabledPlugins)) {
      if (!key.endsWith(legacySuffix)) continue;
      const plugin = key.slice(0, -legacySuffix.length);
      // Moved whenever the plugin is ours or is one this marketplace itself lists — independent of
      // `legacyIsOurs` (a signal read from THIS file), because a sibling plugin's `@artisyn` key can
      // persist here even after an earlier run already dropped `extraKnownMarketplaces.artisyn` (e.g.
      // it was (re)enabled under the legacy name afterwards, by a separate `claude plugin install`).
      if (plugin !== PLUGIN_NAME && !listedPlugins.has(plugin)) continue;
      const next = `${plugin}@${marketplaceName}`;
      if (!Object.prototype.hasOwnProperty.call(enabledPlugins, next)) enabledPlugins[next] = enabledPlugins[key];
      delete enabledPlugins[key];
      moved.push(key);
    }
    if (legacyIsOurs) delete marketplaces[LEGACY_MARKETPLACE_NAME];
    if (moved.length > 0 || legacyIsOurs) {
      console.log(
        `Note: moved this repo's marketplace from the shared "${LEGACY_MARKETPLACE_NAME}" name to "${marketplaceName}"` +
        (moved.length > 0 ? ` (${moved.join(', ')} → @${marketplaceName})` : '') + '.',
      );
    }
  }

  // enabledPlugins['log-hub-hooks@<name>'] = true — re-enable and notify if it was explicitly off.
  const key = pluginKey(marketplaceName);
  if (enabledPlugins[key] === false) {
    console.log(`Note: ${key} was disabled in .claude/settings.json — re-enabling it.`);
  }
  merged['enabledPlugins'] = { ...enabledPlugins, [key]: true };

  // extraKnownMarketplaces.<name> — warn (but still overwrite) if it previously pointed elsewhere.
  const existingPath = sourcePath(marketplaces[marketplaceName]);
  if (existingPath !== undefined && existingPath !== MARKETPLACE_SOURCE.source.path) {
    console.warn(
      `Warning: extraKnownMarketplaces.${marketplaceName}.source.path was "${String(existingPath)}" — ` +
      `overwriting it with "${MARKETPLACE_SOURCE.source.path}".`,
    );
  }
  merged['extraKnownMarketplaces'] = { ...marketplaces, [marketplaceName]: MARKETPLACE_SOURCE };

  // OTEL `env` block — per-key fill-if-absent. A key the user already set (their own collector,
  // their own protocol, a hand-picked port) is never overwritten; we only fill the gaps and say
  // which keys we left alone, so a partially-configured setup is visible rather than silently
  // half-ours. Same spread-and-warn shape as the two blocks above.
  const existingEnv = isPlainObject(existing['env'])
    ? (existing['env'] as Record<string, unknown>)
    : {};
  const mergedEnv: Record<string, unknown> = { ...existingEnv };
  const preservedEnvKeys: string[] = [];
  for (const [key, value] of Object.entries(OTEL_ENV_KEYS(otelPort))) {
    if (Object.prototype.hasOwnProperty.call(existingEnv, key)) {
      preservedEnvKeys.push(key);
    } else {
      mergedEnv[key] = value;
    }
  }
  if (preservedEnvKeys.length > 0) {
    console.log(
      `Note: kept your existing .claude/settings.json env values for ${preservedEnvKeys.join(', ')} — ` +
      'remove them and re-run the installer if you want the Artisyn OTEL defaults instead.',
    );
  }
  merged['env'] = mergedEnv;

  atomicWrite(settingsPath, JSON.stringify(merged, null, 2) + '\n');

  checkUserLevelMarketplaceCollision(path.dirname(claudeDir), marketplaceName);
  warnDuplicateHooks(claudeDir);
}

// Surgical removal of the two plugin-related `.claude/settings.json` keys, for `uninstall`.
// Reuses `readSettingsForMutation`'s abort-on-invalid-JSON + `.bak`-snapshot contract, then
// removes only `enabledPlugins['log-hub-hooks@<name>']`/`extraKnownMarketplaces.<name>` — and the
// same keys under the legacy shared `artisyn` name, the marketplace one only while it points at
// this repo's `./.artisyn/marketplace` — dropping either parent object entirely once it's left
// empty. Everything else in the file (including a user's own plugins/marketplaces) is preserved.
function removePluginSettingsKeys(
  claudeDir: string,
  marketplaceName: string,
  opts: { keepMarketplace?: boolean } = {},
): void {
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return;
  }

  const { existing } = readSettingsForMutation(claudeDir);
  const merged: Record<string, unknown> = { ...existing };

  if (isPlainObject(merged['enabledPlugins'])) {
    const enabledPlugins = { ...(merged['enabledPlugins'] as Record<string, unknown>) };
    delete enabledPlugins[pluginKey(marketplaceName)];
    delete enabledPlugins[pluginKey(LEGACY_MARKETPLACE_NAME)];
    if (Object.keys(enabledPlugins).length > 0) {
      merged['enabledPlugins'] = enabledPlugins;
    } else {
      delete merged['enabledPlugins'];
    }
  }

  if (!opts.keepMarketplace && isPlainObject(merged['extraKnownMarketplaces'])) {
    const marketplaces = { ...(merged['extraKnownMarketplaces'] as Record<string, unknown>) };
    delete marketplaces[marketplaceName];
    const legacy = marketplaces[LEGACY_MARKETPLACE_NAME];
    if (isPlainObject(legacy) && isPlainObject(legacy['source'])
      && (legacy['source'] as Record<string, unknown>)['path'] === MARKETPLACE_SOURCE.source.path) {
      delete marketplaces[LEGACY_MARKETPLACE_NAME];
    }
    if (Object.keys(marketplaces).length > 0) {
      merged['extraKnownMarketplaces'] = marketplaces;
    } else {
      delete merged['extraKnownMarketplaces'];
    }
  }

  // OTEL `env` block — removed only while the logs endpoint still points at
  // a loopback receiver, i.e. it is still ours. If the user has since repointed it at their own
  // collector, the whole block is left alone and we say so: stripping the keys would silently
  // break a setup we no longer own.
  if (isPlainObject(merged['env'])) {
    const env = { ...(merged['env'] as Record<string, unknown>) };
    const logsEndpoint = env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'];
    const isOurs = typeof logsEndpoint === 'string' && OTEL_LOOPBACK_LOGS_ENDPOINT_RE.test(logsEndpoint);

    if (isOurs) {
      for (const key of Object.keys(OTEL_ENV_KEYS(OTEL_FALLBACK_PORT_INSTALLER))) {
        delete env[key];
      }
      if (Object.keys(env).length > 0) {
        merged['env'] = env;
      } else {
        delete merged['env'];
      }
    } else if (logsEndpoint !== undefined) {
      console.log(
        `Note: .claude/settings.json env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is "${String(logsEndpoint)}", ` +
        'which is not an Artisyn loopback receiver — leaving the env block untouched. Remove the ' +
        'OTEL_* keys by hand if you no longer want them.',
      );
    }
  }

  atomicWrite(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
