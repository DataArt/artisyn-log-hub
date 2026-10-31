import { execSync, execFileSync, spawn, spawnSync, ChildProcess } from 'child_process';
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
import {
  OTEL_ENV_KEYS,
  OTEL_ENDPOINT_KEYS,
  OTEL_TRACE_ENV_KEYS,
  OTEL_TRACE_ENDPOINT_KEY,
  OTEL_RESOURCE_ATTRIBUTES_KEY,
  buildResourceAttributes,
} from './otel-env';
import {
  ALL_OTEL_EXPECTED_VALUES,
  OTEL_PORT_MAX,
  OTEL_PORT_MIN,
  assertUserSettingsShape,
  getUserSettingsLabel,
  getUserSettingsPath,
  isArtisynOwnedOtelValue,
  isOtelEndpointKey,
  mergeOwnedOtelKey,
  mergeUserOtelEnv,
  readUserSettingsForMutation,
  userSettingsBackupPath,
  withUserEnsureHook,
  writeUserSettings,
} from './user-settings';
import {
  atomicWriteFile,
  otelStateDir,
  readOrCreateToken,
  readForward,
  readPortFile,
  readRepos,
  removeRepoEntry,
  repoKey,
  stateFilePath,
  upsertRepoEntry,
  writePortFile,
} from './user-state';
import { buildSharedArgv, buildSharedEnv, hello, sessionStatus, shutdown } from './otel-handshake';
import { readManagedOtel, type ManagedOtel } from './managed-settings';
import {
  EXISTING_CHOICES,
  buildArtisynOtelNote,
  detectForeignOtel,
  detectedForwardSignals,
  forwardSignalsFromUrl,
  incompatibleSignals,
  prepareTakeover,
  renderForeignSummary,
  restoreUserOtel,
  streamChangesLine,
  toForwardFile,
  writeForwardFile,
  type ExistingChoice,
  type ForeignOtel,
  type ForwardFile,
  type ForwardSignals,
} from './foreign-otel';
import { stopReceiverAndWait } from './otel-restart';

export type CliFlags = {
  serverUrl?: string;
  apiKey?: string;
  otelPort?: number;
  otelTraces?: boolean;
  otelExisting?: ExistingChoice;
};

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

// Numeric `MAJOR.MINOR.PATCH` compare: negative when `a` is older than `b`, 0 when equal, `null`
// when either side is not a plain dotted version (e.g. `unknown`).
export function compareHookVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Appends one line to `.artisyn/ai_work_dir/hook.log` in the hook's own line format, so an install
// or upgrade (and the version it moved from/to) shows up next to the hook activity it changes.
// Best-effort: never fails the install.
function logInstallerEvent(cwd: string, event: 'result' | 'warn', message: string): void {
  try {
    const dir = path.join(cwd, '.artisyn', 'ai_work_dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook.log'), `${new Date().toISOString()} [installer] [-] [${event}] ${message}\n`);
  } catch {
    // diagnostics only
  }
}

// Logs the version transition of an install/upgrade run and warns, on the console and in hook.log,
// when the bundled hook is older than the installed one — e.g. an installer fetched from a server
// that still serves an older release silently replaces a newer hook.
function reportVersionTransition(cwd: string, action: 'install' | 'upgrade', currentVersion: string | null, newVersion: string, serverUrl: string | null): void {
  const source = serverUrl ? ` (server ${serverUrl})` : '';
  const cmp = currentVersion ? compareHookVersions(newVersion, currentVersion) : null;
  if (currentVersion && cmp !== null && cmp < 0) {
    const text = `${action}: DOWNGRADE hooks v${currentVersion} → v${newVersion}${source} — this installer is older than the installed hook; ` +
      'use the installer of the newer release to get v' + currentVersion + ' back';
    console.warn(`Warning: ${text}`);
    logInstallerEvent(cwd, 'warn', text);
    return;
  }
  logInstallerEvent(cwd, 'result', `${action}: hooks v${currentVersion ?? 'none'} → v${newVersion}${source}`);
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
  console.log('    ~/.claude/settings.json (mirrored in .claude/settings.local.json) and sent to a local');
  console.log('    receiver shared by your repos, which the hook uploads per repo');
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
  otelTraces: boolean,
  otelPlan: OtelUserPlan,
): Promise<{ newVersion: string; marketplaceName: string; problems: string[] }> {
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

  // Pre-flight of the user-scope Claude Code settings (DD-23), before anything is written: an
  // unparsable or wrong-typed `~/.claude/settings.json` aborts here with every file untouched.
  assertUserSettingsShape(readUserSettingsForMutation().existing, 'existing');

  // The per-user shared receiver port (DD-4, DD-25), resolved once per run and written everywhere
  // below: `log-hub.local.json` `otelReceiverPort`, the user-scope endpoints and the
  // `.claude/settings.local.json` mirror. The recorded ports are read first, so an endpoint still
  // pointing at a previous port (the per-project receiver of an older install, or a re-pinned
  // shared port) counts as ours when the settings merges below judge which values are stale.
  //
  // No receiver is stopped any more (DD-25): an old per-project receiver keeps its own port until
  // its idle-exit, and a running shared receiver serves every repo of this user.
  const ownedPorts = readRecordedOtelPorts(cwd);
  const pinnedPort = overrides['OTEL_PORT'] ? Number(overrides['OTEL_PORT']) : undefined;
  const { port: otelPort, previousPort } = await resolveSharedOtelPort(pinnedPort);
  if (previousPort !== null) ownedPorts.add(previousPort);
  ownedPorts.add(otelPort);
  if (readOrCreateToken() === null) {
    console.warn(`Warning: could not create the shared OTEL receiver token in ${otelStateDir()} — OTEL data will not be captured until it exists.`);
  }

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

  // Per-developer values (`serverUrl`, `apiKey`, `otelReceiverPort`) go to the gitignored
  // `log-hub.local.json` only — the tracked `log-hub.json` is shared by every checkout, and the
  // hook merges local over base per key, so a teammate's tracked `serverUrl` stays a valid fallback.
  const overridesLocal: Record<string, unknown> = {};
  if (overrides['SERVER_URL']) overridesLocal['serverUrl'] = overrides['SERVER_URL'];
  if (overrides['API_KEY']) overridesLocal['apiKey'] = overrides['API_KEY'];
  // Always an override, never a merge input: the shared `~/.artisyn/otel/port.json` is
  // authoritative, so the project's own `otelReceiverPort` is overwritten from it every run and the
  // two cannot drift (hooks before 2.30.0 still read it when `port.json` is unknown to them). It
  // must go in as a `Number` — `CONFIG_TYPES.otelReceiverPort` is `'number'` hook-side, and a
  // string would be silently discarded by `matchesType` at runtime.
  overridesLocal['otelReceiverPort'] = Number(otelPort);

  const existingBase = readJsonConfig(logHubJsonPath);
  const templateForMerge = migrating ? { ...templateObj, ...legacyParts.base } : templateObj;
  // The trace opt-in answer (DD-23) lives in the tracked file, so `upgrade` can reuse it without asking.
  const mergedBase = mergeConfig(templateForMerge, existingBase, { otelTraces });
  // Older installers wrote this checkout's port into the tracked file — drop it on every run so an
  // upgrade cleans the project up (the port now lives in `log-hub.local.json`).
  delete mergedBase['otelReceiverPort'];
  writeJsonConfig(logHubJsonPath, mergedBase);

  const existingLocal = readJsonConfig(logHubLocalJsonPath);
  const localForMerge = migrating ? { ...legacyParts.local, ...existingLocal } : existingLocal;
  // A hand-set `otelTraces` in the local file would shadow the tracked answer hook-side (local wins
  // per key), so it is kept in agreement with the answer just given.
  if (Object.prototype.hasOwnProperty.call(localForMerge, 'otelTraces')) {
    overridesLocal['otelTraces'] = otelTraces;
  }
  const mergedLocal = mergeConfigLocal(localForMerge, overridesLocal);
  writeJsonConfig(logHubLocalJsonPath, mergedLocal);
  ensureConfigIgnored(cwd, logHubLocalJsonPath);

  if (migrating) {
    verifyWrittenJson(logHubJsonPath);
    verifyWrittenJson(logHubLocalJsonPath);
  }

  // The legacy per-project port store is superseded by `port.json` (DD-25).
  removeStoredOtelPort(cwd);

  // --- Per-user state (DD-4): this repo's `repos.json` entry and the `bin/` receiver copy. ---
  const thisRepoKey = repoKey(cwd);
  const thisOtelDir = resolveInstalledOtelDir(cwd, { ...mergedBase, ...mergedLocal });
  try {
    // The shared receiver never creates a repo's folder while writing (a deleted project must stay
    // deleted), so a repo reached by its `artisyn.repo` tag before any session registered needs it.
    fs.mkdirSync(thisOtelDir, { recursive: true });
  } catch (err) {
    console.warn(`Warning: could not create ${thisOtelDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    upsertRepoEntry({
      repoKey: thisRepoKey,
      gitRoot: path.resolve(cwd),
      otelDir: thisOtelDir,
      uploader: relToPath(cwd, `${PLUGIN_ROOT_REL}/scripts/send-logs-hook.js`),
      traces: otelTraces,
      hookVersion: newVersion,
    });
  } catch (err) {
    console.warn(`Warning: could not update ${stateFilePath('repos')}: ${err instanceof Error ? err.message : String(err)}`);
  }
  copyReceiverBin(cwd);

  // --- Step 2: the user-scope OTEL keys (DD-23), then `.claude/settings.local.json` (the mirror,
  // with the `artisyn.repo` resource attribute), then `.claude/settings.json`. ---
  const userOtelEnv = applyUserOtelSettings(otelPort, ownedPorts, otelPlan);
  const listedPlugins = marketplacePluginNames(cwd);
  mergeSettings(claudeDir, otelPort, ownedPorts, marketplaceName, listedPlugins, otelTraces, {
    repoKey: thisRepoKey,
    userResourceAttributes: userOtelEnv[OTEL_RESOURCE_ATTRIBUTES_KEY],
  });

  // `--otel-port <n>` re-pins the one shared port, so every other installed repo of this user must
  // follow (DD-25): its local mirror endpoints and its `otelReceiverPort`.
  if (pinnedPort !== undefined) {
    repinOtherRepos(cwd, otelPort, ownedPorts);
  }

  // Design decision 8 — required, non-fatal, immediately after the settings write, for both a
  // fresh install and a migration.
  runClaudePluginActivation(cwd, marketplaceName, listedPlugins);

  // The post-install smoke test — same required-but-non-fatal contract as the
  // activation above, and for the same reason: by now the port is written everywhere, so a
  // failure is a diagnosis rather than a retry trigger.
  // Then every hook entry script, started the way Claude Code starts it. Both results feed the
  // summary: a hook that cannot start must never be reported as "ready to use".
  const problems = verifyHookScriptsLoad(cwd);
  if (!(await verifyInstalledReceiver(otelPort))) {
    problems.push(`the OTEL receiver could not be verified on 127.0.0.1:${otelPort}`);
  }

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

  return { newVersion, marketplaceName, problems };
}

/** The headline printed instead of a success line when the post-install checks found problems. */
function printNotWorking(action: string, newVersion: string, problems: string[]): void {
  console.warn(`⚠ Hooks ${action} (hooks v${newVersion}), but they are not working in this project yet:`);
  for (const p of problems) console.warn(`  - ${p}`);
  console.warn('  See the warnings above. Claude Code runs the hooks with your own `node` from PATH; any current Node.js LTS release works.');
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
    reportVersionTransition(cwd, 'install', currentVersion, newVersion, flags?.serverUrl ?? null);
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

  const otelTraces = await resolveOtelTracesAnswer('install', cwd, flags?.otelTraces);
  const otelPlan = await resolveOtelUserPlan(cwd, flags?.otelExisting, otelTraces);
  const { marketplaceName, problems } = await applyHooksUpdate(claudeDir, cwd, overrides, otelTraces, otelPlan);

  // Security warning if API key was passed on the command line
  if (flags?.apiKey) {
    console.warn('Warning: API key was passed on the command line. It may be visible in your shell history.');
  }

  const hasServerUrl = !!flags?.serverUrl;
  const hasApiKey = !!flags?.apiKey;

  const action = currentVersion && currentVersion !== newVersion ? 'updated' : 'installed';
  if (problems.length === 0) {
    console.log(`✓ Hooks ${action} successfully! (hooks v${newVersion})`);
  } else {
    printNotWorking(action, newVersion, problems);
  }
  console.log('');
  console.log('Plugin registered in .claude/settings.json:');
  console.log(`  enabledPlugins["${pluginKey(marketplaceName)}"] = true`);
  console.log(`  extraKnownMarketplaces.${marketplaceName}.source.path = "${MARKETPLACE_SOURCE.source.path}"`);
  console.log('');
  console.log('Config written to .artisyn/config/log-hub.json and log-hub.local.json (serverUrl, apiKey, otelReceiverPort)');
  // Read back post-update, so this reports what is actually on disk — including a `serverUrl` that
  // was inherited from an existing config or carried over by the legacy `.env` migration rather
  // than passed on this command line.
  const installedServerUrl = readInstalledServerUrl(cwd, claudeDir);
  console.log(`Telemetry destination: ${installedServerUrl ?? '(not set)'}`);
  console.log(`OTEL trace export: ${otelTraces ? 'on' : 'off'} (otelTraces in .artisyn/config/log-hub.json; change with --otel-traces=yes|no)`);
  const sharedPort = readPortFile()?.port;
  if (sharedPort !== undefined) {
    console.log(`OTEL receiver: one per OS user on 127.0.0.1:${sharedPort} (~/.artisyn/otel/port.json; change with --otel-port <n>)`);
  }
  if (flags?.otelPort !== undefined) {
    console.log('');
    console.log(`OTEL port pinned to ${flags.otelPort} for ${getUserSettingsLabel()} and every installed repo — restart Claude Code (every open session) to pick it up.`);
  }
  printDataCollectionNotice(installedServerUrl);

  if (hasServerUrl && hasApiKey && problems.length > 0) {
    console.log('Hooks are configured, but not working yet — fix the problems listed above and run install again.');
  } else if (hasServerUrl && hasApiKey) {
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
    console.log('Next step: set serverUrl in .artisyn/config/log-hub.local.json');
    console.log('  { "serverUrl": "<your-server-url>" }');
  } else {
    console.log('Next step: add your API key to .artisyn/config/log-hub.local.json');
    console.log('  { "apiKey": "<your-key>" }');
    console.log('and set serverUrl in .artisyn/config/log-hub.local.json');
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

export async function runUpgrade(flags?: Pick<CliFlags, 'otelExisting'>): Promise<void> {
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
  reportVersionTransition(cwd, 'upgrade', currentVersion, newVersion, serverUrl);

  // Re-adding an already-known marketplace and re-installing an already-installed plugin at the
  // same version are both documented no-ops (design decision 8) — this call is safe (and required)
  // on every upgrade run, migrating or not.
  const otelTraces = await resolveOtelTracesAnswer('upgrade', cwd);
  const otelPlan = await resolveOtelUserPlan(cwd, flags?.otelExisting, otelTraces);
  const { problems } = await applyHooksUpdate(claudeDir, cwd, {}, otelTraces, otelPlan);

  if (problems.length > 0) {
    printNotWorking(currentVersion === newVersion ? 're-applied' : 'upgraded', newVersion, problems);
    console.log(`  Previous version: v${currentVersion}`);
  } else if (currentVersion === newVersion) {
    console.log(`✓ Hooks already at latest version v${newVersion} (re-applied).`);
    console.log(`  Previous version: v${currentVersion}`);
    console.log(`  Current version:  v${newVersion}`);
  } else {
    console.log('✓ Hooks upgraded successfully!');
    console.log(`  Previous version: v${currentVersion}`);
    console.log(`  New version:      v${newVersion}`);
  }
  console.log('Note: Claude Code sessions that are already running keep their old OTEL endpoint until restarted.');
  printDataCollectionNotice(serverUrl);
}

// Removes `.artisyn/marketplace/`, `.artisyn/config/`, and the two plugin-related
// `.claude/settings.json` keys. The settings-key removal is reported successful even when one or
// both directory deletes fail (demoted to a warning, retried on the next install/upgrade/uninstall
// run) — it is an independent, already-durable step by the time the deletes are attempted.
// While marketplace.json still lists another plugin, only `plugins/log-hub-hooks/` and its entry
// are removed, and `extraKnownMarketplaces.<name>` stays so that plugin keeps loading. Keys under
// the legacy shared `artisyn` name are removed too.
//
// Per-user OTEL state (DD-27): this repo's `repos.json` entry is removed; when it was the last one,
// `removeUserOtelState` restores the user's original OTEL keys and removes the Artisyn ones, the
// user-level hook and the `~/.artisyn/otel/` files. Any other entry only removes itself.
export async function runUninstall(): Promise<void> {
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
  // Read before anything below removes the port store / config directory.
  const ownedPorts = readRecordedOtelPorts(cwd);
  const thisRepoKey = repoKey(cwd);
  // No `~/.artisyn/otel/` = an install from before the shared receiver: no user state to remove.
  const lastRepo = fs.existsSync(otelStateDir()) && readRepos().repos.every(r => r.repoKey === thisRepoKey);
  if (lastRepo) {
    // Pre-flight before anything is removed: an unparsable or wrong-typed user file aborts here.
    assertUserSettingsShape(readUserSettingsForMutation().existing, 'existing');
  }
  removePluginSettingsKeys(claudeDir, marketplaceName, ownedPorts, { keepMarketplace });
  // Unconditional — `settings.local.json` holds the OTEL keys whether or not `settings.json` exists.
  removeOtelEnvKeys(claudeDir, 'settings.local.json', ownedPorts);
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

  let remaining: number;
  try {
    remaining = removeRepoEntry(thisRepoKey).length;
  } catch (err) {
    console.warn(`Warning: could not update ${stateFilePath('repos')}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (remaining > 0) {
    console.log(`  Kept the per-user OTEL receiver and the OTEL keys in ${getUserSettingsLabel()} — ${remaining} other repo(s) still use them.`);
  } else if (lastRepo) {
    await removeUserOtelState(ownedPorts);
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

// The `otelTraces` answer already stored for this project (the gitignored local file wins over the
// tracked one, matching the hook's per-key merge), or `undefined` when none is a boolean.
function readStoredOtelTraces(cwd: string): boolean | undefined {
  const configDir = path.join(cwd, '.artisyn', 'config');
  for (const file of ['log-hub.local.json', 'log-hub.json']) {
    const value = readJsonConfig(path.join(configDir, file))['otelTraces'];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

// The trace opt-in answer (DD-23):
//  - install: the `--otel-traces=yes|no` flag if given; else a TTY `[Y/n]` prompt; else yes.
//  - upgrade: the stored `otelTraces` if present, without asking; else a TTY prompt; else yes.
// Asked before any file is touched, like the other install prompts.
async function resolveOtelTracesAnswer(
  command: 'install' | 'upgrade',
  cwd: string,
  flag?: boolean,
): Promise<boolean> {
  if (command === 'install' && flag !== undefined) return flag;
  if (command === 'upgrade') {
    const stored = readStoredOtelTraces(cwd);
    if (stored !== undefined) return stored;
  }
  if (!process.stdin.isTTY) return true;
  const answer = await prompt('Also export Claude Code traces (enhanced telemetry beta) to Log Hub? [Y/n] ');
  const normalized = answer.toLowerCase();
  return normalized !== 'n' && normalized !== 'no';
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
  // Trace opt-in answer (`--otel-traces`, the install prompt); absent on installs that predate it.
  otelTraces?: boolean;
  // Realtime forwarding of receiver chunks to the server; defaults live hook-side in env-context.js.
  otelRealtime?: boolean;
  otelRealtimeIntervalMs?: number;
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
// OTEL receiver port — per-user allocation (~/.artisyn/otel/port.json) and post-install smoke test
//
// ---------------------------------------------------------------------------

// The never-installed / probe-exhausted fallback. Duplicated deliberately from
// `OTEL_FALLBACK_PORT` in hook/.claude/telemetry_tool/env-context.js and `DEFAULT_PORT` in
// otel-receiver.js — none of the three can import from another; tests pin them together.
export const OTEL_FALLBACK_PORT_INSTALLER = 25317;

// The allocation range. A fixed default port is wrong twice over: 4318 collides with a user's own
// collector, and any fixed choice is a guess. Staying above 25000 keeps well clear of the
// registered-service range and of the ports development tooling habitually grabs.
export { OTEL_PORT_MIN, OTEL_PORT_MAX };

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

// `.artisyn/config/otel-port.json` — the per-project port store of installers before hook 2.30.0.
// The port is now per OS user (`~/.artisyn/otel/port.json`, DD-4); install/upgrade/uninstall only
// ever delete this legacy file (DD-25) and never read it.
function legacyOtelPortFilePath(cwd: string): string {
  return path.join(cwd, '.artisyn', 'config', 'otel-port.json');
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

// The per-user shared receiver port (DD-4, DD-25), first match wins:
//   1. `--otel-port <n>` — an explicit pin: `port.json` is rewritten with it;
//   2. the `port` in `~/.artisyn/otel/port.json` — one port for every repo of this OS user;
//   3. a fresh allocation, written to `port.json`.
// `previousPort` is the port `port.json` held before this run (null on a first install), so the
// caller can recognise endpoints that still point at it as ours. The project's `otelReceiverPort`
// and the endpoint keys are outputs, always rewritten from this value.
export async function resolveSharedOtelPort(pin?: number): Promise<{ port: number; previousPort: number | null }> {
  const previousPort = readPortFile()?.port ?? null;
  if (pin !== undefined && isUsablePortNumber(pin)) {
    if (pin !== previousPort) writePortFile(pin);
    return { port: pin, previousPort };
  }
  if (previousPort !== null) return { port: previousPort, previousPort };
  const port = await allocateOtelPort();
  writePortFile(port);
  return { port, previousPort };
}

// Deletes the legacy `.artisyn/config/otel-port.json` (DD-25) — the shared port replaced it. Called
// on every install/upgrade and by `uninstall`. The per-project receiver that used it is left to its
// own idle-exit.
function removeStoredOtelPort(cwd: string): void {
  try {
    fs.rmSync(legacyOtelPortFilePath(cwd), { force: true });
  } catch {
    // Best-effort — a leftover legacy port file has no reader any more.
  }
}

// This repo's OTEL chunk directory, exactly as the hook resolves it (`resolveOtelDir` in
// env-context.js): `<telemetryDir>/otel`, a relative `telemetryDir` taken from the repo root,
// default `.artisyn/ai_work_dir/telemetry`.
function resolveInstalledOtelDir(cwd: string, config: Record<string, unknown>): string {
  const configured = typeof config['telemetryDir'] === 'string' ? config['telemetryDir'].trim() : '';
  const telemetryDir = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(cwd, configured))
    : path.resolve(cwd, '.artisyn', 'ai_work_dir', 'telemetry');
  return path.join(telemetryDir, 'otel');
}

// The files the installer keeps in `~/.artisyn/otel/bin/` (DD-4, DD-21): the receiver copy that
// `otel-ensure-receiver.js` and the post-install check spawn, its `version.json`, and the
// user-level SessionStart hook itself.
const RECEIVER_BIN_FILES = ['otel-receiver.js', 'version.json', 'otel-ensure-receiver.js'] as const;

// Copies `RECEIVER_BIN_FILES` from the freshly extracted plugin into `bin/` on every install and
// upgrade, overwriting only those files (atomically) and nothing else in the folder. A running
// receiver already holds its code in memory, so overwriting its script is safe. Non-fatal.
function copyReceiverBin(cwd: string): void {
  const binDir = stateFilePath('binDir');
  for (const name of RECEIVER_BIN_FILES) {
    const source = relToPath(cwd, `${PLUGIN_ROOT_REL}/scripts/${name}`);
    try {
      atomicWriteFile(path.join(binDir, name), fs.readFileSync(source));
    } catch (err) {
      console.warn(`Warning: could not copy ${name} to ${binDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The user-scope OTEL plan: managed, no foreign collector, or proxy / keep / replace (DD-24, DD-26)
// ---------------------------------------------------------------------------

// What `applyUserOtelSettings` does with the user scope, decided before any file is touched.
export type OtelUserPlan =
  | { kind: 'managed'; managed: ManagedOtel }
  | { kind: 'none'; stored: ForwardFile | null }
  | { kind: 'keep'; foreign: ForeignOtel; stored: ForwardFile | null }
  | { kind: 'proxy' | 'replace'; foreign: ForeignOtel; stored: ForwardFile | null; signals: ForwardSignals };

const MANAGED_OTEL_MESSAGE =
  'OTEL is managed by your organization — OTEL tabs are unavailable, everything else works.';

// The FR-D6 alternatives for a grpc / http-protobuf collector: an OTLP/HTTP URL of the same
// collector (then `proxy` to it), `keep` or `replace`. Up to three attempts at a valid URL, then keep.
async function askProtocolAlternative(foreign: ForeignOtel): Promise<{ choice: ExistingChoice; signals: ForwardSignals }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await prompt(
      'Enter the OTLP/HTTP URL of the same collector (typically http://<host>:4318), or "keep" / "replace" [keep]: ',
    )).trim();
    const lower = answer.toLowerCase();
    if (lower === '' || lower === 'keep' || lower === 'k') return { choice: 'keep', signals: {} };
    if (lower === 'replace' || lower === 'r') return { choice: 'replace', signals: {} };
    const signals = forwardSignalsFromUrl(foreign, answer);
    if (signals) return { choice: 'proxy', signals };
    console.log('  That is not an absolute http(s) URL.');
  }
  return { choice: 'keep', signals: {} };
}

// Resolves the user-scope OTEL plan (DD-24, DD-26), asking in a terminal when it has to. Called
// before any file is written. Order for a foreign collector: `--otel-existing=` → the stored choice
// when `forward.json.fingerprint` matches → a TTY prompt → `keep`.
export async function resolveOtelUserPlan(cwd: string, flag: ExistingChoice | undefined, otelTraces: boolean): Promise<OtelUserPlan> {
  const managed = readManagedOtel();
  if (managed.pinnedSignals.length > 0 || managed.disabledSignals.length > 0) {
    return { kind: 'managed', managed };
  }

  const read = readUserSettingsForMutation();
  assertUserSettingsShape(read.existing, 'existing');
  const ownedPorts = readRecordedOtelPorts(cwd);
  const stored = toForwardFile(readForward());
  const foreign = detectForeignOtel({
    userSettings: read.existing,
    processEnv: process.env,
    ownedPorts,
    stored,
  });
  if (!foreign.present) return { kind: 'none', stored };

  const anyTraces = otelTraces || readRepos().repos.some(r => r.traces);
  const printSummary = (): void => {
    console.log('');
    console.log('An existing OTEL collector is configured for Claude Code (header values are not shown):');
    for (const line of renderForeignSummary(foreign)) console.log(line);
  };

  let choice: ExistingChoice;
  let signals: ForwardSignals | null = null;
  const storedMatches = !!stored && stored.fingerprint === foreign.fingerprint
    && (EXISTING_CHOICES as readonly string[]).includes(stored.mode);
  if (flag !== undefined) {
    choice = flag;
  } else if (storedMatches && stored) {
    choice = stored.mode as ExistingChoice;
    if (choice === 'proxy') signals = stored.signals;
    console.log(`Existing OTEL collector: unchanged since the last install — keeping the choice "${choice}" (--otel-existing=proxy|keep|replace to change it).`);
  } else if (process.stdin.isTTY) {
    printSummary();
    console.log(`  ${streamChangesLine(anyTraces)}`);
    console.log('How should Log Hub coexist with it?');
    console.log('  [P]roxy   (recommended) Log Hub receives the data and forwards everything to your collector as before');
    console.log('  [k]eep    leave your collector untouched — the Log Hub OTEL tabs will not work');
    console.log('  [r]eplace data goes only to Log Hub — your collector stops receiving it');
    const answer = (await prompt('Choice [P/k/r]: ')).toLowerCase();
    choice = answer === 'k' || answer === 'keep' ? 'keep' : answer === 'r' || answer === 'replace' ? 'replace' : 'proxy';
  } else {
    printSummary();
    console.log('Existing OTEL collector: keeping it untouched (non-interactive run) — the Log Hub OTEL tabs will not work.');
    console.log('  Re-run with --otel-existing=proxy (forward to it) or --otel-existing=replace to change that.');
    return { kind: 'keep', foreign, stored };
  }

  if (choice === 'proxy' && signals === null) {
    signals = detectedForwardSignals(foreign);
    const incompatible = incompatibleSignals(foreign);
    if (incompatible.length > 0) {
      const protocols = [...new Set(incompatible.map(s => s.protocol))].join(', ');
      console.log(
        `Your collector is configured with ${protocols}; the Log Hub receiver can forward only to an OTLP/HTTP (JSON) endpoint.`,
      );
      if (process.stdin.isTTY) {
        const alt = await askProtocolAlternative(foreign);
        choice = alt.choice;
        signals = alt.signals;
      } else {
        console.log('Existing OTEL collector: keeping it untouched (non-interactive run). Re-run in a terminal to give its OTLP/HTTP URL, or use --otel-existing=replace.');
        choice = 'keep';
      }
    }
  }

  if (choice === 'keep') return { kind: 'keep', foreign, stored };
  return { kind: choice, foreign, stored, signals: choice === 'proxy' ? signals ?? {} : {} };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Writes `forward.json` for the plan unless the stored one already says the same (DD-4, DD-24).
function writeForwardForPlan(plan: OtelUserPlan): void {
  if (plan.kind === 'managed') return;
  const stored = plan.stored;
  let next: { mode: ForwardFile['mode']; fingerprint: string | null; signals: ForwardSignals; original: ForwardFile['original'] };
  if (plan.kind === 'none') {
    if (!stored || stored.mode === 'none') return;
    // An applied proxy/replace holds the only copy of the user's original keys (the user file was
    // rewritten): never trade it for `none` — the last uninstall still needs it to restore them.
    if (stored.mode === 'proxy' || stored.mode === 'replace') return;
    next = { mode: 'none', fingerprint: null, signals: {}, original: { env: {} } };
  } else if (plan.kind === 'keep') {
    next = { mode: 'keep', fingerprint: plan.foreign.fingerprint, signals: {}, original: { env: {} } };
  } else {
    next = { mode: plan.kind, fingerprint: plan.foreign.fingerprint, signals: plan.signals, original: plan.foreign.original };
  }
  if (stored && stored.mode === next.mode && stored.fingerprint === next.fingerprint
    && sameJson(stored.signals, next.signals) && sameJson(stored.original, next.original)) {
    return;
  }
  writeForwardFile(next);
}

// Writes the Artisyn OTEL keys into the user-scope Claude Code settings (DD-23) — Claude Code
// 2.1.282+ reads telemetry keys only from there (or managed settings). Every key is merged by the
// owned-key rule (`mergeUserOtelEnv`): absent or still-Artisyn values are (re)written to the shared
// port, the user's own values are kept and reported. The trace keys go in while any installed repo
// of this user wants traces (the shared receiver drops spans per repo, DD-18) and are removed, while
// still ours, once none does. Returns the user `env` as written, for the local mirror.
//
// The plan (`resolveOtelUserPlan`) decides first:
//  - managed (DD-26): no user key is written, the managed message is printed;
//  - keep: the user's collector is left alone — no Artisyn OTEL key goes in; a former proxy/replace
//    rewrite is undone from the `forward.json` backup;
//  - proxy / replace (DD-24): `forward.json` is saved first, the endpoint and protocol keys move to
//    the receiver (proxy keeps the header keys and `otelHeadersHelper`), `_artisynOtel` is written;
//  - the DD-21 user-level SessionStart hook is present only for proxy.
function applyUserOtelSettings(otelPort: number, ownedPorts: Set<number>, plan: OtelUserPlan): Record<string, unknown> {
  const read = readUserSettingsForMutation();
  const label = getUserSettingsLabel();
  const ensureScript = path.join(stateFilePath('binDir'), 'otel-ensure-receiver.js');
  const envOf = (settings: Record<string, unknown>): Record<string, unknown> =>
    isPlainObject(settings['env']) ? (settings['env'] as Record<string, unknown>) : {};

  if (plan.kind === 'managed') {
    console.log(MANAGED_OTEL_MESSAGE);
    console.log(`  (managed OTEL settings found in: ${plan.managed.sources.map(s => s.label).join(', ')}; nothing was written to ${label})`);
    return envOf(read.existing);
  }

  writeForwardForPlan(plan);

  if (plan.kind === 'keep') {
    let next: Record<string, unknown> = read.existing;
    if (plan.foreign.reconstructed) {
      // A former proxy/replace is switched to keep: put the user's collector back.
      next = restoreUserOtel(next, plan.stored, ownedPorts).settings;
      console.log(`Restored your OTEL collector settings in ${label} from the Log Hub backup.`);
    } else if (next['_artisynOtel'] !== undefined) {
      next = { ...next };
      delete next['_artisynOtel'];
    }
    next = withUserEnsureHook(next, false, ensureScript);
    if (writeUserSettings(read, next)) {
      console.log(`Updated ${label}; previous content saved to ${userSettingsBackupPath(read.settingsPath)}`);
    }
    return envOf(next);
  }

  const anyTraces = readRepos().repos.some(r => r.traces);
  let base: Record<string, unknown> = read.existing;
  let extraDesired: Record<string, string> = {};
  let keepKeys = new Set<string>();
  if (plan.kind === 'proxy' || plan.kind === 'replace') {
    const prepared = prepareTakeover(read.existing, plan.kind, plan.foreign, otelPort);
    base = prepared.settings;
    extraDesired = prepared.extraDesired;
    keepKeys = prepared.keepKeys;
  }
  const env = envOf(base);
  const desired: Record<string, string> = {
    ...(anyTraces ? { ...OTEL_ENV_KEYS(otelPort), ...OTEL_TRACE_ENV_KEYS(otelPort) } : OTEL_ENV_KEYS(otelPort)),
    ...extraDesired,
  };
  const stripKeys = (anyTraces ? [] : Object.keys(OTEL_TRACE_ENV_KEYS(otelPort))).filter(k => !keepKeys.has(k) && !(k in desired));
  const merged = mergeUserOtelEnv(env, desired, ownedPorts, stripKeys);

  let next: Record<string, unknown> = { ...base, env: merged.env };
  // Same guard as `writeForwardForPlan`: a `none` plan never undoes an applied proxy/replace.
  const appliedStoredMode = plan.kind === 'none' && plan.stored
    && (plan.stored.mode === 'proxy' || plan.stored.mode === 'replace') ? plan.stored.mode : null;
  if (plan.kind === 'proxy' || plan.kind === 'replace') {
    next['_artisynOtel'] = buildArtisynOtelNote(plan.kind, plan.foreign.original, stateFilePath('forward'), anyTraces);
  } else if (appliedStoredMode === null) {
    delete next['_artisynOtel'];
  }
  next = withUserEnsureHook(next, plan.kind === 'proxy' || appliedStoredMode === 'proxy', ensureScript);

  const written = writeUserSettings(read, next);
  if (written) {
    console.log(`OTEL export configured in ${label} (receiver 127.0.0.1:${otelPort}); previous content saved to ${userSettingsBackupPath(read.settingsPath)}`);
  }
  if (plan.kind === 'proxy') {
    const forwarded = Object.keys(plan.signals);
    console.log(
      `Existing OTEL collector: proxy — the Log Hub receiver forwards ${forwarded.length > 0 ? forwarded.join(', ') : 'no signal (none was exported)'} to it unchanged. ` +
      `Backup of your original keys: ${stateFilePath('forward')}; a user-level SessionStart hook keeps the receiver running for every project.`,
    );
  } else if (plan.kind === 'replace') {
    console.log(`Existing OTEL collector: replace — telemetry now goes only to Log Hub. Backup of your original keys: ${stateFilePath('forward')}.`);
  }
  if (merged.rewritten.length > 0) {
    console.log(`Note: rewrote stale Artisyn OTEL endpoints in ${label} (${merged.rewritten.join(', ')}).`);
  }
  if (merged.stripped.length > 0) {
    console.log(`Note: no installed repo exports traces — removed the Artisyn trace env keys from ${label} (${merged.stripped.join(', ')}).`);
  }
  if (merged.kept.length > 0) {
    console.log(
      `Note: kept your existing ${label} env values for ${merged.kept.join(', ')} — ` +
      'remove them and re-run the installer if you want the Artisyn OTEL defaults instead.',
    );
  }
  return merged.env;
}

// After `--otel-port` re-pinned the shared port (DD-25): every OTHER repo in `repos.json` gets its
// Artisyn-owned endpoint keys in `.claude/settings.local.json` and its `otelReceiverPort` in
// `.artisyn/config/log-hub.local.json` rewritten to the new port. Only files that exist and parse
// are touched; a user's own values are left alone. Non-fatal, one warning per failure.
function repinOtherRepos(cwd: string, otelPort: number, ownedPorts: Set<number>): void {
  const self = path.resolve(cwd);
  const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  for (const repo of readRepos().repos) {
    if (norm(repo.gitRoot) === norm(self)) continue;
    try {
      const repoOwned = new Set(ownedPorts);
      const localConfigPath = path.join(repo.gitRoot, '.artisyn', 'config', 'log-hub.local.json');
      const localConfig = readJsonConfig(localConfigPath);
      if (isUsablePortNumber(localConfig['otelReceiverPort'])) repoOwned.add(localConfig['otelReceiverPort']);
      if (fs.existsSync(localConfigPath) && localConfig['otelReceiverPort'] !== otelPort) {
        writeJsonConfig(localConfigPath, { ...localConfig, otelReceiverPort: otelPort });
      }

      const mirrorPath = path.join(repo.gitRoot, '.claude', 'settings.local.json');
      const mirror = readSettingsFileSafe(mirrorPath);
      if (mirror && isPlainObject(mirror['env'])) {
        const env = mirror['env'] as Record<string, unknown>;
        const desired: Record<string, string> = { ...OTEL_ENV_KEYS(otelPort), ...OTEL_TRACE_ENV_KEYS(otelPort) };
        const next: Record<string, unknown> = { ...env };
        let changed = false;
        for (const key of Object.keys(env)) {
          if (!isOtelEndpointKey(key) || !isArtisynOwnedOtelValue(key, env, repoOwned)) continue;
          if (env[key] !== desired[key]) {
            next[key] = desired[key];
            changed = true;
          }
        }
        if (changed) {
          atomicWrite(`${mirrorPath}.bak`, fs.readFileSync(mirrorPath, 'utf8'));
          atomicWrite(mirrorPath, JSON.stringify({ ...mirror, env: next }, null, 2) + '\n');
        }
      }
      console.log(`Note: moved ${repo.gitRoot} to the shared OTEL receiver port ${otelPort}.`);
    } catch (err) {
      console.warn(`Warning: could not move ${repo.gitRoot} to OTEL port ${otelPort}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// `OTEL_ENV_KEYS(port)` (the `env` block written into `.claude/settings.local.json`) and
// `OTEL_ENDPOINT_KEYS` live in `./otel-env` — a pure module the dev-container provisioning script
// also imports — and are re-exported from here for existing importers.
export { OTEL_ENV_KEYS, OTEL_ENDPOINT_KEYS, OTEL_TRACE_ENV_KEYS, OTEL_TRACE_ENDPOINT_KEY };

// Every port this project has on record as its own OTEL receiver port: the per-user shared port in
// `~/.artisyn/otel/port.json`, the `otelReceiverPort` in `.artisyn/config/log-hub.local.json` (the
// legacy per-project port until this run rewrites it) and the one in `.artisyn/config/log-hub.json`
// (written there by older installers). All are kept when they disagree, and only values that are a
// usable port number count. Must be read before the config is rewritten, so a previously allocated
// port is still recognised as ours.
function readRecordedOtelPorts(cwd: string): Set<number> {
  const ports = new Set<number>();
  const shared = readPortFile();
  if (shared !== null) {
    ports.add(shared.port);
  }
  const configDir = path.join(cwd, '.artisyn', 'config');
  for (const file of ['log-hub.local.json', 'log-hub.json']) {
    const configured = readJsonConfig(path.join(configDir, file))['otelReceiverPort'];
    if (isUsablePortNumber(configured)) {
      ports.add(configured);
    }
  }
  return ports;
}

/** Plugin-relative paths (`scripts/<x>.js`) of every script the installed `hooks/hooks.json` runs. */
function installedHookScripts(cwd: string): string[] {
  const scripts = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(relToPath(cwd, `${PLUGIN_ROOT_REL}/hooks/hooks.json`), 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ args?: unknown[] }> }>>;
    };
    for (const groups of Object.values(parsed.hooks ?? {})) {
      for (const group of groups ?? []) {
        for (const hook of group.hooks ?? []) {
          const first = hook.args?.[0];
          const m = typeof first === 'string' ? /^\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(first) : null;
          if (m) scripts.add(m[1]);
        }
      }
    }
  } catch {
    // An unreadable hooks.json is reported by the caller as "no hook script found".
  }
  return [...scripts].sort();
}

/** The line of a failed run worth showing: the first error-looking stderr line, else the last one. */
function failureLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /Error|Cannot find|not defined|ERR_/.test(l)) ?? lines[lines.length - 1] ?? '';
  return line.slice(0, 300);
}

const HOOK_SELF_CHECK_TIMEOUT_MS = 20_000;

// Post-install load check: runs every hook entry script of the installed hooks.json exactly the way
// Claude Code will — `node` from PATH, cwd = the project — with `--self-check` (hook 2.24.2+), which
// loads the script's whole module graph and exits 0 without reading stdin or writing anything. It
// catches what kills every hook before it can log a line: the project's package.json
// `"type": "module"` (the plugin's own scripts/package.json pins CommonJS), a `node` too old for the
// hook, no `node` on PATH, a missing file. Same required-but-non-fatal contract as
// `verifyInstalledReceiver`: the files are already in place, so a failure is a diagnosis that the
// summary reports instead of "ready to use". Returns one problem line per failing script.
export function verifyHookScriptsLoad(cwd: string): string[] {
  const scripts = installedHookScripts(cwd);
  if (scripts.length === 0) {
    const problem = `no hook script found in ${PLUGIN_ROOT_REL}/hooks/hooks.json`;
    console.warn(`Warning: the hook scripts could not be checked: ${problem}`);
    return [problem];
  }
  const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: HOOK_SELF_CHECK_TIMEOUT_MS });
  if (nodeVersion.error || nodeVersion.status !== 0) {
    const problem = `\`node\` is not runnable from PATH (${nodeVersion.error?.message ?? `exit ${nodeVersion.status}`}); Claude Code runs every hook with it`;
    console.warn(`Warning: ${problem}. Install any current Node.js LTS release.`);
    return [problem];
  }
  const problems: string[] = [];
  for (const rel of scripts) {
    const res = spawnSync('node', [relToPath(cwd, `${PLUGIN_ROOT_REL}/${rel}`), '--self-check'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: HOOK_SELF_CHECK_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!res.error && res.status === 0 && /"selfCheck":"ok"/.test(res.stdout ?? '')) continue;
    const why = res.error ? res.error.message : `exit ${res.status}${res.signal ? ` (${res.signal})` : ''}`;
    const detail = failureLine(res.stderr ?? '');
    problems.push(`${rel}: ${why}${detail ? ` — ${detail}` : ''}`);
  }
  const node = nodeVersion.stdout.trim();
  if (problems.length === 0) {
    console.log(`✓ Hook scripts load with node ${node} (${scripts.length}/${scripts.length})`);
  } else {
    console.warn(
      `Warning: ${problems.length} of ${scripts.length} hook script(s) do not start with node ${node} in this project, ` +
      'so Claude Code sessions here will not be recorded:',
    );
    for (const p of problems) console.warn(`  ${p}`);
    console.warn(`  To reproduce: node "${relToPath(cwd, `${PLUGIN_ROOT_REL}/${scripts[0]}`)}" --self-check`);
  }
  return problems;
}

// Post-install smoke test of the shared receiver (DD-25): a hello with the HMAC proof check, then an
// authenticated `session-status` for a synthetic session. When nothing answers on the shared port,
// the `bin/` receiver copy is spawned with the DD-7 shared argv and a short idle timeout, and the
// handshake is retried until it answers or the deadline passes. This verifies the shipped artifact
// end to end — token, ownership hash, routes — not just the port.
//
// Required but non-fatal, with a remediation line — the same contract as
// `runClaudePluginActivation`: by the time this runs the port is already written everywhere, so a
// failure is a diagnosis, not a retry trigger. It never re-allocates.
//
// A receiver already running on the port (another repo's session, or a re-install during a live
// session) is verified as it is: it serves every repo of this OS user. A spawned verify receiver
// is killed afterwards (it would idle-exit anyway); it registers nothing and writes no repo files.
export async function verifyInstalledReceiver(port: number): Promise<boolean> {
  const home = os.homedir();
  const stateDir = otelStateDir(home);
  const receiverPath = path.join(stateFilePath('binDir'), 'otel-receiver.js');
  const launch = { home, stateDir, port, idleTimeoutMs: OTEL_VERIFY_IDLE_TIMEOUT_MS };

  const warnUnverified = (reason: string): void => {
    console.warn(
      `Warning: the shared OTEL receiver could not be verified on 127.0.0.1:${port} (${reason}). ` +
      'Claude Code telemetry may not be captured. To diagnose, run it in the foreground:\n' +
      `  node "${receiverPath}" ${buildSharedArgv(launch).map(a => (a.startsWith('--') ? a : `"${a}"`)).join(' ')}\n` +
      `  and read ${stateFilePath('receiverLog')}\n` +
      '  (then re-install with `--otel-port <n>` to move every repo to a different port)',
    );
  };

  const describeHandshake = (h: { status: string; detail?: string }): string => {
    if (h.status === 'port-conflict') {
      return `the listener on that port is not this user's Log Hub receiver (${h.detail ?? 'unknown'}) — another program or another OS user holds it`;
    }
    if (h.status === 'no-token') return `the token in ${stateDir} is missing or unreadable`;
    return 'no reply from the receiver';
  };

  let child: ChildProcess | null = null;
  try {
    let first = await hello(port, { timeoutMs: OTEL_VERIFY_REQUEST_TIMEOUT_MS, homeDir: home });
    if (first.status === 'none') {
      if (!fs.existsSync(receiverPath)) {
        warnUnverified(`receiver script not found at ${receiverPath}`);
        return false;
      }
      child = spawn(process.execPath, [receiverPath, ...buildSharedArgv(launch)], {
        cwd: os.tmpdir(),
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...buildSharedEnv(launch) },
      });
      // Without a listener, a spawn failure (e.g. a missing node) is an uncaught 'error' event.
      child.on('error', () => { /* reported by the polling loop below as "no reply" */ });

      // Poll until something answers: no answer means the receiver has not finished binding yet
      // (or never will); any answer is final.
      const deadline = Date.now() + OTEL_VERIFY_DEADLINE_MS;
      for (;;) {
        first = await hello(port, { timeoutMs: OTEL_VERIFY_REQUEST_TIMEOUT_MS, homeDir: home });
        if (first.status !== 'none' || Date.now() >= deadline) break;
        await delay(150);
      }
    }
    if (first.status !== 'ok') {
      warnUnverified(describeHandshake(first));
      return false;
    }

    const status = await sessionStatus(port, `installer-verify-${process.pid}`, {
      timeoutMs: OTEL_VERIFY_REQUEST_TIMEOUT_MS,
      homeDir: home,
    });
    if (status.kind === 'handshake') {
      warnUnverified(describeHandshake(status.handshake));
      return false;
    }
    if (status.kind === 'none') {
      warnUnverified('no reply to the authenticated session-status request');
      return false;
    }
    if (status.kind === 'unsupported') {
      // An older shared receiver without `session-status` still proved it holds our token; it is
      // replaced by the new code after its idle-exit.
      console.log(
        `✓ OTEL receiver verified on 127.0.0.1:${port} (receiver ${status.receiverVersion ?? 'unknown'}, ` +
        `${status.detail}; restarts with the new version after its idle-exit)`,
      );
      return true;
    }
    console.log(`✓ OTEL receiver verified on 127.0.0.1:${port} (shared, receiver ${status.status.receiverVersion ?? 'unknown'})`);
    return true;
  } catch (err) {
    warnUnverified(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // Already gone (it exited on EADDRINUSE or its idle timeout).
      }
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

// Reads `.claude/settings.json` or `.claude/settings.local.json` for a mutation: a parse failure
// hard-aborts (no silent `{}` fallback) and a `.claude/<fileName>.bak` snapshot is written before
// the caller mutates anything. Shared by `mergeSettings` (install/upgrade) and
// `removePluginSettingsKeys` (uninstall) so every settings write goes through the same
// abort/backup contract.
//
// `opts.snapshot: false` defers the `.bak` to the caller (which then writes `raw` itself), for a
// caller that rewrites the file only when something actually changed.
function readSettingsForMutation(
  claudeDir: string,
  fileName: SettingsFileName,
  opts: { snapshot?: boolean } = {},
): { settingsPath: string; existing: Record<string, unknown>; raw: string | null } {
  const settingsPath = path.join(claudeDir, fileName);

  let existing: Record<string, unknown> = {};
  let raw: string | null = null;
  if (fs.existsSync(settingsPath)) {
    raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error(`Error: .claude/${fileName} is not valid JSON - fix it and re-run`);
      process.exit(1);
    }
    if (!isPlainObject(existing)) {
      console.error(`Error: .claude/${fileName} is not valid JSON - fix it and re-run`);
      process.exit(1);
    }

    // Snapshot before any mutation, so a bad merge or crash mid-write can always be recovered from.
    if (opts.snapshot !== false) {
      atomicWrite(`${settingsPath}.bak`, raw);
    }
  }

  return { settingsPath, existing, raw };
}

type SettingsFileName = 'settings.json' | 'settings.local.json';

// What the `.claude/settings.local.json` mirror needs beyond the port (DD-23): this repo's
// `repoKey` and the user-scope `OTEL_RESOURCE_ATTRIBUTES` value to carry over.
type LocalMirrorOpts = { repoKey: string; userResourceAttributes: unknown };

// The OTEL `env` merge for install/upgrade (Design Decisions 4, 5 and 7 of the OTEL-port task).
// `sharedEnv` is the committed `.claude/settings.json` `env`; the Artisyn keys belong in the
// gitignored `.claude/settings.local.json`. Ownership (`isArtisynOwnedOtelValue`) is judged per key
// and per file, on each file's env as read, before anything is changed. For each key:
//  (a) an Artisyn-owned value in `settings.json` is deleted from it (migration of the old layout);
//  (b) a user value in `settings.json` wins: it stays, nothing is written for that key in
//      `settings.local.json`, and an owned value there is dropped so it cannot shadow it;
//  (c) an endpoint key is (re)written in `settings.local.json` while it is absent or still ours —
//      which is what repoints a stale Artisyn port — and a user value there is kept;
//  (d) any other key is filled in `settings.local.json` only when absent.
// Writes `settings.local.json` (creating it when there is something to write, deleting an emptied
// `env`), makes sure it and its `.bak` are git-ignored, and returns the cleaned `settings.json` env
// for the caller to write — the local file is always written first.
//
// `otelTraces` (the trace opt-in answer) adds `OTEL_TRACE_ENV_KEYS` to the merged set; when it is
// false, the trace keys that are still Artisyn-owned are removed from both files instead and a
// user's own trace keys are left alone.
function mergeOtelEnv(
  cwd: string,
  claudeDir: string,
  otelPort: number,
  ownedPorts: Set<number>,
  sharedEnv: Record<string, unknown>,
  otelTraces: boolean,
  mirror: LocalMirrorOpts,
): Record<string, unknown> {
  const { settingsPath: localPath, existing: localExisting, raw: localRaw } =
    readSettingsForMutation(claudeDir, 'settings.local.json');
  const localEnv = isPlainObject(localExisting['env'])
    ? (localExisting['env'] as Record<string, unknown>)
    : {};

  const has = (env: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(env, key);

  const nextShared: Record<string, unknown> = { ...sharedEnv };
  const nextLocal: Record<string, unknown> = { ...localEnv };
  const migrated: string[] = [];
  const keptShared: string[] = [];
  const keptLocal: string[] = [];
  const rewritten: string[] = [];

  const desiredKeys: Record<string, string> = otelTraces
    ? { ...OTEL_ENV_KEYS(otelPort), ...OTEL_TRACE_ENV_KEYS(otelPort) }
    : OTEL_ENV_KEYS(otelPort);

  // Traces declined: drop the owned trace keys (judged on each env as read) from both files.
  const strippedTraceKeys: string[] = [];
  if (!otelTraces) {
    const traceKeys = Object.keys(OTEL_TRACE_ENV_KEYS(otelPort));
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>, SettingsFileName]> = [
      [sharedEnv, nextShared, 'settings.json'],
      [localEnv, nextLocal, 'settings.local.json'],
    ];
    for (const [env, nextEnv, fileName] of pairs) {
      const { env: kept } = stripOwnedOtelEnvKeys(env, fileName, ownedPorts, traceKeys);
      for (const key of traceKeys) {
        if (has(env, key) && !(kept && has(kept, key))) {
          delete nextEnv[key];
          if (!strippedTraceKeys.includes(key)) strippedTraceKeys.push(key);
        }
      }
    }
  }

  for (const [key, desired] of Object.entries(desiredKeys)) {
    const sharedOwned = has(sharedEnv, key) && isArtisynOwnedOtelValue(key, sharedEnv, ownedPorts);
    const localOwned = has(localEnv, key) && isArtisynOwnedOtelValue(key, localEnv, ownedPorts);

    if (has(sharedEnv, key) && !sharedOwned) {
      // (b) the user's own value in the committed file.
      keptShared.push(key);
      if (localOwned) delete nextLocal[key];
      continue;
    }
    if (sharedOwned) {
      // (a) migrate: drop it from the committed file, then fall through to the local merge.
      delete nextShared[key];
      migrated.push(key);
    }

    // (c) and (d) — the same per-key rule as the user-scope file (`mergeOwnedOtelKey`).
    const decision = mergeOwnedOtelKey(localEnv, key, desired, ownedPorts);
    if (decision.action === 'set') {
      nextLocal[key] = desired;
      if (decision.rewrite) rewritten.push(decision.rewrite);
    } else if (decision.action === 'keep') {
      keptLocal.push(key);
    }
  }

  // The repo tag (DD-23): this file's `OTEL_RESOURCE_ATTRIBUTES` replaces the user-scope (and the
  // committed project) value in Claude Code versions that still read project telemetry keys, so
  // theirs are carried over, then `artisyn.repo=<repoKey>` is added.
  nextLocal[OTEL_RESOURCE_ATTRIBUTES_KEY] = buildResourceAttributes(
    [mirror.userResourceAttributes, sharedEnv[OTEL_RESOURCE_ATTRIBUTES_KEY]]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .join(','),
    localEnv[OTEL_RESOURCE_ATTRIBUTES_KEY],
    mirror.repoKey,
  );

  const nextLocalFile: Record<string, unknown> = { ...localExisting };
  if (Object.keys(nextLocal).length > 0) {
    nextLocalFile['env'] = nextLocal;
  } else {
    delete nextLocalFile['env'];
  }
  const serialized = JSON.stringify(nextLocalFile, null, 2) + '\n';
  const shouldWrite = localRaw !== null
    ? serialized !== localRaw
    : Object.keys(nextLocalFile).length > 0;
  if (shouldWrite) {
    atomicWrite(localPath, serialized);
  }
  if (fs.existsSync(localPath)) {
    ensureConfigIgnored(cwd, localPath, { secret: false });
    ensureConfigIgnored(cwd, `${localPath}.bak`, { secret: false });
  }

  if (migrated.length > 0) {
    console.log('Note: moved the Artisyn OTEL env keys from .claude/settings.json to .claude/settings.local.json.');
  }
  if (strippedTraceKeys.length > 0) {
    console.log(`Note: OTEL trace export is off — removed the Artisyn trace env keys (${strippedTraceKeys.join(', ')}).`);
  }
  if (rewritten.length > 0) {
    console.log(`Note: rewrote stale Artisyn OTEL endpoints in .claude/settings.local.json (${rewritten.join(', ')}).`);
  }
  if (keptShared.length > 0) {
    console.log(
      `Note: kept your existing .claude/settings.json env values for ${keptShared.join(', ')} — ` +
      'remove them and re-run the installer if you want the Artisyn OTEL defaults instead.',
    );
  }
  if (keptLocal.length > 0) {
    console.log(
      `Note: kept your existing .claude/settings.local.json env values for ${keptLocal.join(', ')} — ` +
      'remove them and re-run the installer if you want the Artisyn OTEL defaults instead.',
    );
  }

  return nextShared;
}

// Strips every Artisyn-owned OTEL key from one settings file's `env` (ownership judged on that env
// as read, before any deletion), printing a Note for each endpoint key that is set to something
// that is not ours. Returns the remaining env (`undefined` when it is left empty) and how many keys
// were removed. Pure apart from the Notes — the caller writes the file. Covers the base keys and
// the opt-in trace keys (`OTEL_TRACE_ENV_KEYS`) by default, so uninstall removes both; `keys`
// narrows it (the trace keys alone when traces are declined).
function stripOwnedOtelEnvKeys(
  env: Record<string, unknown>,
  fileName: SettingsFileName,
  ownedPorts: Set<number>,
  keys: readonly string[] = Object.keys(ALL_OTEL_EXPECTED_VALUES),
): { env: Record<string, unknown> | undefined; removed: number } {
  const next: Record<string, unknown> = { ...env };
  let removed = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) continue;
    if (isArtisynOwnedOtelValue(key, env, ownedPorts)) {
      delete next[key];
      removed++;
    } else if (isOtelEndpointKey(key)) {
      console.log(
        `Note: .claude/${fileName} env.${key} is "${String(env[key])}", which is not an Artisyn loopback ` +
        'receiver — leaving it untouched.',
      );
    }
  }
  return { env: Object.keys(next).length > 0 ? next : undefined, removed };
}

// Uninstall-side cleanup of the Artisyn OTEL env keys in one `.claude/<fileName>` (Design
// Decision 6). The file is rewritten — after a `.bak` snapshot — only when at least one key was
// removed, and is never deleted; an absent file is a no-op. Same abort-on-invalid-JSON contract as
// every other settings mutation.
function removeOtelEnvKeys(claudeDir: string, fileName: SettingsFileName, ownedPorts: Set<number>): void {
  const settingsPath = path.join(claudeDir, fileName);
  if (!fs.existsSync(settingsPath)) {
    return;
  }
  const { existing, raw } = readSettingsForMutation(claudeDir, fileName, { snapshot: false });
  if (!isPlainObject(existing['env'])) {
    return;
  }
  const { env, removed } = stripOwnedOtelEnvKeys(existing['env'] as Record<string, unknown>, fileName, ownedPorts);
  if (removed === 0) {
    return;
  }
  const next: Record<string, unknown> = { ...existing };
  if (env) {
    next['env'] = env;
  } else {
    delete next['env'];
  }
  if (raw !== null) {
    atomicWrite(`${settingsPath}.bak`, raw);
  }
  atomicWrite(settingsPath, JSON.stringify(next, null, 2) + '\n');
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
//  - The OTEL `env` keys go to the gitignored `.claude/settings.local.json` (see `mergeOtelEnv`,
//    which writes that file before this one): Artisyn-owned keys still in this file are moved
//    there, stale Artisyn endpoints are repointed at `otelPort`, the user's own values always win
//    and are reported in a `Note:` line, and an emptied `env` is deleted. `ownedPorts` are the
//    ports this project has on record as its own (`readRecordedOtelPorts` plus `otelPort`).
function mergeSettings(
  claudeDir: string,
  otelPort: number,
  ownedPorts: Set<number>,
  marketplaceName: string,
  listedPlugins: Set<string>,
  otelTraces: boolean,
  mirror: LocalMirrorOpts,
): void {
  const { settingsPath, existing } = readSettingsForMutation(claudeDir, 'settings.json');

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

  // OTEL `env` block — the Artisyn keys live in `.claude/settings.local.json` (written first, by
  // `mergeOtelEnv`); this file only loses the ones that are still ours. A user's own value here
  // (their collector, their protocol) is never touched. A non-object `env` is left as it is.
  if (isPlainObject(existing['env']) || existing['env'] === undefined) {
    const sharedEnv = isPlainObject(existing['env'])
      ? (existing['env'] as Record<string, unknown>)
      : {};
    const cleanedEnv = mergeOtelEnv(path.dirname(claudeDir), claudeDir, otelPort, ownedPorts, sharedEnv, otelTraces, mirror);
    if (Object.keys(cleanedEnv).length > 0) {
      merged['env'] = cleanedEnv;
    } else {
      delete merged['env'];
    }
  }

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
  ownedPorts: Set<number>,
  opts: { keepMarketplace?: boolean } = {},
): void {
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return;
  }

  const { existing } = readSettingsForMutation(claudeDir, 'settings.json');
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

  // OTEL `env` block (a legacy-layout install kept it here) — only the keys that are still
  // Artisyn-owned, judged per key (`isArtisynOwnedOtelValue`). A key the user repointed at their
  // own collector, and the exporter/protocol keys alongside it, are left alone: stripping them
  // would silently break a setup we no longer own.
  if (isPlainObject(merged['env'])) {
    const { env } = stripOwnedOtelEnvKeys(merged['env'] as Record<string, unknown>, 'settings.json', ownedPorts);
    if (env) {
      merged['env'] = env;
    } else {
      delete merged['env'];
    }
  }

  atomicWrite(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Uninstall of the per-user OTEL state (DD-27) and --restart-otel-receiver (DD-25)
// ---------------------------------------------------------------------------

// The state files the installer created or the receiver/hook wrote, unlinked one by one at the
// last uninstall — never a recursive delete: anything else in the folder (a user's own file) keeps
// it, and with it `bin/`/`otel/`.
const STATE_FILES_TO_REMOVE = ['port', 'token', 'repos', 'registry', 'forward', 'receiverLog', 'claudeVersion'] as const;

// Asks the shared receiver to exit (authenticated shutdown) and waits for its port to be free.
// Never throws. `null` = nothing answered on the port.
async function stopSharedReceiver(port: number): Promise<{ stopped: boolean; reason?: string } | null> {
  const answer = await shutdown(port);
  if (answer.kind === 'none' || (answer.kind === 'handshake' && answer.handshake.status === 'none')) return null;
  if (answer.kind === 'handshake') {
    return { stopped: false, reason: answer.handshake.status === 'port-conflict'
      ? `the listener on that port is not this user's Log Hub receiver (${answer.handshake.detail ?? 'unknown'})`
      : answer.handshake.status };
  }
  if (answer.kind === 'rejected') return { stopped: false, reason: `shutdown refused with HTTP ${answer.status}` };
  // Accepted: wait for the exit (grace poll, force-kill, confirm) the way every restart does.
  return stopReceiverAndWait(port, os.tmpdir(), null, { sendShutdown: async () => ({ status: 200, ok: true }) });
}

// The last-repo removal of the per-user OTEL state (DD-27): the user file gets the original
// collector keys back exactly (`forward.json.original`), loses the Artisyn keys, `_artisynOtel`
// and the DD-21 hook entry; the receiver is stopped; the listed state files are unlinked and
// `bin/`, `otel/` removed while empty. `<settings>.artisyn-bak` is kept (the user's safety copy).
// Non-fatal apart from the user-file validation, which aborts with nothing written.
async function removeUserOtelState(ownedPorts: Set<number>): Promise<void> {
  const label = getUserSettingsLabel();
  const stored = toForwardFile(readForward());
  const read = readUserSettingsForMutation();
  const restored = restoreUserOtel(read.existing, stored, ownedPorts);
  const next = withUserEnsureHook(restored.settings, false, path.join(stateFilePath('binDir'), 'otel-ensure-receiver.js'));
  if (writeUserSettings(read, next)) {
    const parts: string[] = [];
    if (restored.removed.length > 0) parts.push(`removed the Artisyn OTEL keys (${restored.removed.join(', ')})`);
    if (restored.restored.length > 0) parts.push(`restored your original OTEL keys (${restored.restored.join(', ')})`);
    console.log(`  ${label}: ${parts.length > 0 ? parts.join('; ') : 'removed the Log Hub entries'}.`);
    console.log(`  The previous content of ${label} is kept in ${userSettingsBackupPath(read.settingsPath)}.`);
  }

  const port = readPortFile()?.port;
  if (port !== undefined) {
    const result = await stopSharedReceiver(port);
    if (result && !result.stopped) {
      console.warn(`Warning: could not stop the shared OTEL receiver on 127.0.0.1:${port} (${result.reason ?? 'unknown'}) — it exits on its own when idle.`);
    }
  }

  const binDir = stateFilePath('binDir');
  const unlink = (file: string): void => {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`Warning: could not remove ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  for (const name of RECEIVER_BIN_FILES) unlink(path.join(binDir, name));
  for (const name of STATE_FILES_TO_REMOVE) unlink(stateFilePath(name));
  for (const dir of [binDir, otelStateDir()]) {
    try {
      fs.rmdirSync(dir); // non-recursive: only an empty folder goes
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
        console.log(`  Kept ${dir} — it still holds files Log Hub did not create.`);
      } else if (code !== 'ENOENT') {
        console.warn(`Warning: could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(`  Removed the per-user OTEL receiver state (${otelStateDir()}).`);
}

// `--restart-otel-receiver` (DD-25): an authenticated `POST /artisyn/shutdown` to the shared
// receiver, then a wait until its port is free. The next Claude Code session (or the DD-21 user
// hook) starts it again — from the current code.
export async function runRestartOtelReceiver(): Promise<void> {
  const port = readPortFile()?.port;
  if (port === undefined) {
    console.error(`Error: no shared OTEL receiver is configured (${stateFilePath('port')} is missing) — install the hooks first.`);
    process.exit(1);
  }
  const result = await stopSharedReceiver(port);
  if (result === null) {
    console.log(`No OTEL receiver is running on 127.0.0.1:${port} — nothing to restart; the next Claude Code session starts it.`);
    return;
  }
  if (!result.stopped) {
    console.error(`Error: could not stop the OTEL receiver on 127.0.0.1:${port} (${result.reason ?? 'unknown'}).`);
    process.exit(1);
  }
  console.log(`✓ Stopped the shared OTEL receiver on 127.0.0.1:${port}. The next Claude Code session starts it again with the installed version.`);
}
