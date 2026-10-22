#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALLER_DIR = path.join(ROOT, 'artisyn-hooks-installer');
const HOOK_TOOL_DIR = path.join(ROOT, 'hook', '.claude', 'telemetry_tool');
const INSTALL_MD = path.join(ROOT, 'hook', 'INSTALL_HOOK.md');
const DEFAULT_STATIC_DIR = path.join(ROOT, 'server', 'src', 'public', 'static');

// Output directory for the tarballs and installer-version.json. `npm run build` uses the default;
// the isolated scenario stand (scripts/scenarios/build-stand.mjs) passes `--static-dir <dir>` so
// it never rewrites the dev server's server/src/public/static.
let STATIC_DIR = DEFAULT_STATIC_DIR;
let CLI_TARBALL = path.join(STATIC_DIR, 'artisyn-hooks-installer.tgz');
let HOOKS_TARBALL = path.join(STATIC_DIR, 'hooks.tar.gz');

function setStaticDir(dir) {
  STATIC_DIR = path.resolve(dir);
  CLI_TARBALL = path.join(STATIC_DIR, 'artisyn-hooks-installer.tgz');
  HOOKS_TARBALL = path.join(STATIC_DIR, 'hooks.tar.gz');
}

/**
 * Reads `--static-dir <dir>` (or `--static-dir=<dir>`) from argv. Returns the default
 * server/src/public/static when the flag is absent; throws when it is given without a value.
 */
function parseStaticDirArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--static-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--static-dir requires a directory argument');
      return path.resolve(value);
    }
    if (arg.startsWith('--static-dir=')) {
      const value = arg.slice('--static-dir='.length);
      if (!value) throw new Error('--static-dir requires a directory argument');
      return path.resolve(value);
    }
  }
  return DEFAULT_STATIC_DIR;
}

// Names are fixed (see requirements.md "Names (decided)"): marketplace `artisyn`, plugin `log-hub-hooks`.
// The archive ships `artisyn`; the installer renames it per repo to `artisyn-<8 hex>` on install.
const MARKETPLACE_NAME = 'artisyn';
const PLUGIN_NAME = 'log-hub-hooks';
const MARKETPLACE_ROOT = '.artisyn/marketplace';
const PLUGIN_ROOT = `${MARKETPLACE_ROOT}/plugins/${PLUGIN_NAME}`;

// Hook version is the source of truth for what gets embedded and served.
// Falls back to the installer package.json version if not present.
function readHookVersion() {
  const versionFile = path.join(HOOK_TOOL_DIR, 'version.json');
  if (fs.existsSync(versionFile)) {
    return JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
  }
  return JSON.parse(fs.readFileSync(path.join(INSTALLER_DIR, 'package.json'), 'utf8')).version;
}

// `npx <url>` resolves its local exec cache by the *downloaded package's own* name+version, not
// by the request URL — so if a user re-runs an old copy-pasted install/upgrade command (stale
// `?v=` cache-buster and all), npx can silently keep re-executing whatever it last cached for
// that exact name+version, ignoring the freshly-downloaded bytes entirely. `.claude/rules/
// installer.md`'s manual "bump on every artisyn-hooks-installer/ change" rule doesn't cover a
// hook-only content bump (hook/ lives outside that directory), which is exactly how this repo's
// installer version drifted from the hook version for weeks at a time (see git history). Tying
// the installer package's own version to the bundled hook version here closes that gap
// automatically — every hook version bump now also changes the npm-package identity npx keys its
// cache on, so a stale cached extraction can never be served again.
function ensureInstallerVersionTracksHook(
  pkgPath = path.join(INSTALLER_DIR, 'package.json'),
  hookVersion = readHookVersion(),
) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.bundledHookVersion === hookVersion) {
    return pkg.version; // already tracking this hook version — nothing to bump
  }
  const parts = pkg.version.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  pkg.version = parts.join('.');
  pkg.bundledHookVersion = hookVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`  Bumped artisyn-hooks-installer to v${pkg.version} (tracking bundled hook v${hookVersion})`);
  return pkg.version;
}

// Every file that must reach an installed plugin. This is an EXPLICIT list, so adding a new module
// under `hook/.claude/telemetry_tool/` without adding it here ships an install whose hooks all die
// with MODULE_NOT_FOUND on their first `require` — the packed tarball simply would not contain it.
// `assertHookFilesComplete()` below fails the build rather than letting that happen again.
const HOOK_JS_FILES = [
  'telemetry-hook.js',
  'lifecycle-hook.js',
  'send-logs-hook.js',
  'upload-logs.js',
  'prompt-upload-hook.js',
  'session-files.js',
  'spawn-hidden.js',
  'env-context.js',
  'git-context.js',
  'write-telemetry.js',
  'hook-log.js',
  'recommendations.js',
  'otel-receiver.js',
  'otel-register.js',
  'otel-endpoint-check.js',
  'otel-restart.js',
  'throttle-state.js',
  // Shared async LLM-invocation helper, skill catalog, the combined worker,
  // its own failure-cap state, and the `Stop` trigger that spawns it (wired
  // into `HOOKS_JSON`'s `Stop:` below).
  'claude-invoke-async.js',
  'skill-catalog.js',
  'post-turn-analysis-hook.js',
  'post-turn-analysis-worker.js',
  'session-attribution-state.js',
  // Provenance markers for, and reliable tree-kill of, every child process the hooks spawn.
  'process-marker.js',
  // Harness snapshot builder (catalog + agents + system context + static MCP config, DD-2 id) and
  // its known-snapshot-ids / per-session-id state.
  'harness-snapshot.js',
  'harness-state.js',
  // Pre-upload drop of malformed NDJSON lines, shared by both upload hooks.
  'ndjson-sanitize.js',
  // Change surface: the throttled tracked-codebase measurement `send-logs-hook.js` ships as
  // a `code-inventory` event, and the per-edit-call line counts `lifecycle-hook.js` derives from
  // `tool_response`. Both are `require`d at hook startup — an install missing either dies with
  // MODULE_NOT_FOUND, which is exactly what this list exists to prevent.
  'code-inventory.js',
  'edit-result-counts.js',
  // `$CLAUDE_CONFIG_DIR`-aware resolution of the user-level Claude dir (transcripts, skills,
  // plugins, user settings) — `require`d by send-logs-hook, session-files, skill-catalog and
  // otel-endpoint-check.
  'claude-config-dir.js',
  // `ARTISYN_PROJECT_ROOT` override of the project root — `require`d by git-context.js, so every
  // hook dies with MODULE_NOT_FOUND without it.
  'project-root-override.js',
];

/**
 * Fail the build when `hook/.claude/telemetry_tool/` holds a `.js` module that `HOOK_JS_FILES`
 * does not list, or lists one that no longer exists.
 *
 * Exists because the omission is otherwise invisible until an end user installs: the tarball packs
 * only the listed files, so a missing module turns into MODULE_NOT_FOUND inside every hook on the
 * user's machine, while the source tree, the tests and this repo's own dogfooded plugin copy all
 * keep working. `throttle-state.js` was added and shipped un-bundled exactly once; this stops the
 * second time.
 *
 * `__tests__/` is skipped — tests are deliberately not shipped.
 */
function assertHookFilesComplete() {
  const onDisk = fs.readdirSync(HOOK_TOOL_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .sort();

  const listed = new Set(HOOK_JS_FILES);
  const missingFromList = onDisk.filter((name) => !listed.has(name));
  const missingFromDisk = HOOK_JS_FILES.filter((name) => !onDisk.includes(name));

  if (missingFromList.length || missingFromDisk.length) {
    console.error('HOOK_JS_FILES has drifted from hook/.claude/telemetry_tool/:');
    if (missingFromList.length) {
      console.error(`  On disk but NOT bundled (installs would crash): ${missingFromList.join(', ')}`);
    }
    if (missingFromDisk.length) {
      console.error(`  Bundled but missing on disk: ${missingFromDisk.join(', ')}`);
    }
    process.exit(1);
  }
}

function compileCli() {
  const tsconfig = path.join(INSTALLER_DIR, 'tsconfig.json');
  // On Windows .cmd files require shell:true; use spawnSync to handle cross-platform
  const result = spawnSync('tsc', ['--project', tsconfig], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PATH: path.join(ROOT, 'node_modules', '.bin') + path.delimiter + process.env.PATH },
  });
  if (result.status !== 0) {
    process.stderr.write('tsc compilation failed\n');
    process.exit(1);
  }
}

function addShebang() {
  const entryFile = path.join(INSTALLER_DIR, 'dist', 'index.js');
  const content = fs.readFileSync(entryFile, 'utf8');
  if (!content.startsWith('#!')) {
    fs.writeFileSync(entryFile, '#!/usr/bin/env node\n' + content, 'utf8');
  }
}

// --- Minimal tar writer ---

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function tarHeader(name, size) {
  const buf = Buffer.alloc(512, 0);

  const nameBytes = Buffer.from(name, 'utf8');
  nameBytes.copy(buf, 0, 0, Math.min(nameBytes.length, 100));

  // mode: 0644
  Buffer.from(octal(0o644, 8)).copy(buf, 100);
  // uid, gid: 0
  Buffer.from(octal(0, 8)).copy(buf, 108);
  Buffer.from(octal(0, 8)).copy(buf, 116);
  // size
  Buffer.from(octal(size, 12)).copy(buf, 124);
  // mtime = 0 for reproducibility
  Buffer.from(octal(0, 12)).copy(buf, 136);
  // typeflag: '0' = regular file
  buf[156] = 0x30;
  // ustar magic
  Buffer.from('ustar\0').copy(buf, 257);
  Buffer.from('00').copy(buf, 263);

  // Checksum: sum of all bytes with checksum field treated as spaces
  buf.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += buf[i];
  Buffer.from(octal(checksum, 7) + '\0').copy(buf, 148);

  return buf;
}

function tarEntry(archivePath, data) {
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const header = tarHeader(archivePath, dataBuffer.length);
  const padding = 512 - (dataBuffer.length % 512);
  const pad = padding < 512 ? Buffer.alloc(padding, 0) : Buffer.alloc(0);
  return Buffer.concat([header, dataBuffer, pad]);
}

function buildTarGz(entries) {
  const parts = entries.map(([archivePath, data]) => tarEntry(archivePath, data));
  // Two 512-byte zero blocks = end of archive
  parts.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(parts);
  return zlib.gzipSync(tar, { level: 9 });
}

// ustar name field is 100 bytes; anything at/above that gets silently truncated on extraction.
function findOverlongTarNames(entries) {
  return entries
    .map(([name]) => name)
    .filter(name => Buffer.byteLength(name, 'utf8') >= 100);
}

function packCliTarball() {
  const distDir = path.join(INSTALLER_DIR, 'dist');
  const distFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
  const pkgJson = fs.readFileSync(path.join(INSTALLER_DIR, 'package.json'));

  // npm tarball format requires 'package/' prefix on all entries
  const entries = distFiles.map(f => [
    `package/dist/${f}`,
    fs.readFileSync(path.join(distDir, f)),
  ]);
  // Embed hooks archive so the installer is self-contained (no --registry needed)
  entries.push(['package/dist/hooks.tar.gz', fs.readFileSync(HOOKS_TARBALL)]);
  entries.push(['package/package.json', pkgJson]);

  const gz = buildTarGz(entries);
  fs.writeFileSync(CLI_TARBALL, gz);
  console.log(`  Written: ${CLI_TARBALL}`);
}

// Blanked `.artisyn/config/log-hub.json` template shipped in the plugin tree. Every other config
// key is intentionally omitted here so the hook-side default table (env-context.js) applies.
function buildConfigTemplate() {
  return JSON.stringify({ serverUrl: '', telemetryDir: '', context: [] }, null, 2) + '\n';
}

// --- hooks.json (plugin hook wiring) ---
//
// Mirrors the exec form documented in hook/INSTALL_HOOK.md and verified against the plugins
// reference docs: { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js"] }.
function mkPluginCmd(scriptFile) {
  return { type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/scripts/${scriptFile}`] };
}

function singleHook(scriptFile, statusMessage) {
  return [{ hooks: [{ ...mkPluginCmd(scriptFile), statusMessage }] }];
}

// 14 events, all monitoring/logging (lifecycle-hook.js, except UserPromptSubmit/Stop and the
// second SessionEnd script) — matching hook/INSTALL_HOOK.md's documented event set exactly (see
// the drift check below) and preserving every statusMessage documented there. There is no
// PreToolUse entry: the guardrail hook was removed in 2.19.0.
const HOOKS_JSON = {
  hooks: {
    UserPromptSubmit: singleHook('telemetry-hook.js', 'Recording prompt...'),
    PostToolUse: singleHook('lifecycle-hook.js', 'Recording tool call...'),
    PostToolUseFailure: singleHook('lifecycle-hook.js', 'Recording tool failure...'),
    SessionStart: singleHook('lifecycle-hook.js', 'Recording session start...'),
    // Two scripts on SessionEnd: lifecycle-hook.js writes the SessionEnd telemetry event, and
    // send-logs-hook.js then flushes this session's own artisyn/claude files. Without that flush
    // a session whose final `Stop` lost the upload lock never ships its own transcript, and a
    // session whose artisyn log carries no `prompt_start` is filtered out of the server's session
    // list entirely (NULL `first_prompt`) — i.e. it silently never appears in the UI.
    SessionEnd: [
      {
        hooks: [
          { ...mkPluginCmd('lifecycle-hook.js'), statusMessage: 'Recording session end...' },
          { ...mkPluginCmd('send-logs-hook.js'), statusMessage: 'Flushing session logs...' },
        ],
      },
    ],
    PermissionRequest: singleHook('lifecycle-hook.js', 'Recording permission request...'),
    PermissionDenied: singleHook('lifecycle-hook.js', 'Recording permission denial...'),
    SubagentStart: singleHook('lifecycle-hook.js', 'Recording subagent start...'),
    SubagentStop: singleHook('lifecycle-hook.js', 'Recording subagent stop...'),
    PreCompact: singleHook('lifecycle-hook.js', 'Recording compaction...'),
    PostCompact: singleHook('lifecycle-hook.js', 'Recording compaction...'),
    PostToolBatch: singleHook('lifecycle-hook.js', 'Recording tool batch...'),
    StopFailure: singleHook('lifecycle-hook.js', 'Recording stop failure...'),
    // Two scripts on Stop: send-logs-hook.js does its existing full multi-session upload scan,
    // and post-turn-analysis-hook.js separately resolves this turn's context and
    // spawns the detached post-turn-analysis-worker.js (Turn-End Cost Advisor + AI Session
    // Attribution) — no network I/O in the trigger itself, so the turn is never
    // blocked by either script's own work.
    Stop: [
      {
        hooks: [
          { ...mkPluginCmd('send-logs-hook.js'), statusMessage: 'Uploading logs...' },
          { ...mkPluginCmd('post-turn-analysis-hook.js'), statusMessage: 'Analyzing turn...' },
        ],
      },
    ],
  },
};

// Pulls the event names out of every ```json fenced block in hook/INSTALL_HOOK.md that has a
// top-level "hooks" key. The union across blocks is what is compared against HOOKS_JSON's event set.
function parseEventNamesFromInstallMd(text) {
  const blockRe = /```json\r?\n([\s\S]*?)```/g;
  const names = new Set();
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue; // not a strict standalone JSON block — skip
    }
    if (parsed && typeof parsed === 'object' && parsed.hooks && typeof parsed.hooks === 'object') {
      for (const key of Object.keys(parsed.hooks)) names.add(key);
    }
  }
  return names;
}

// Returns null when HOOKS_JSON's event set matches hook/INSTALL_HOOK.md's documented set exactly,
// otherwise an object describing the drift.
function findHooksEventDrift(installMdText, hooksJson) {
  const docEvents = parseEventNamesFromInstallMd(installMdText);
  const jsonEvents = new Set(Object.keys(hooksJson.hooks));
  const missingFromJson = [...docEvents].filter(e => !jsonEvents.has(e));
  const missingFromDoc = [...jsonEvents].filter(e => !docEvents.has(e));
  if (missingFromJson.length || missingFromDoc.length) {
    return { missingFromJson, missingFromDoc };
  }
  return null;
}

// Returns null when every version source agrees, otherwise the disagreeing map.
function findVersionMismatch(versions) {
  const unique = new Set(Object.values(versions));
  return unique.size <= 1 ? null : versions;
}

function buildMarketplaceJson() {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'Artisyn' },
    description: 'Local marketplace for the artisyn-log-hub telemetry hook plugin.',
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./plugins/${PLUGIN_NAME}`,
        description: 'Records Claude Code session telemetry and uploads it to artisyn-log-hub.',
      },
    ],
  };
}

function buildPluginJson(version) {
  return {
    name: PLUGIN_NAME,
    displayName: 'Log Hub Hooks',
    version,
    description: 'Records Claude Code session telemetry and uploads it to artisyn-log-hub.',
    author: { name: 'Artisyn' },
  };
}

function packMarketplaceTarball() {
  const version = readHookVersion();
  const entries = [];

  entries.push([
    `${MARKETPLACE_ROOT}/.claude-plugin/marketplace.json`,
    JSON.stringify(buildMarketplaceJson(), null, 2) + '\n',
  ]);

  const pluginJson = buildPluginJson(version);
  entries.push([`${PLUGIN_ROOT}/.claude-plugin/plugin.json`, JSON.stringify(pluginJson, null, 2) + '\n']);

  entries.push([`${PLUGIN_ROOT}/hooks/hooks.json`, JSON.stringify(HOOKS_JSON, null, 2) + '\n']);

  for (const filename of HOOK_JS_FILES) {
    const data = fs.readFileSync(path.join(HOOK_TOOL_DIR, filename));
    entries.push([`${PLUGIN_ROOT}/scripts/${filename}`, data]);
  }

  const scriptsVersionJson = Buffer.from(JSON.stringify({ version }) + '\n', 'utf8');
  entries.push([`${PLUGIN_ROOT}/scripts/version.json`, scriptsVersionJson]);

  entries.push([`${PLUGIN_ROOT}/config-template/log-hub.json`, buildConfigTemplate()]);

  const overlong = findOverlongTarNames(entries);
  if (overlong.length) {
    console.error('Tar entry name(s) exceed the 100-byte ustar name limit:');
    for (const name of overlong) console.error(`  ${name} (${Buffer.byteLength(name, 'utf8')} bytes)`);
    process.exit(1);
  }

  const gz = buildTarGz(entries);
  fs.writeFileSync(HOOKS_TARBALL, gz);
  console.log(`  Written: ${HOOKS_TARBALL}`);

  return { version, pluginJson, scriptsVersionJson };
}

function writeVersionManifest() {
  const version = readHookVersion();
  fs.writeFileSync(
    path.join(STATIC_DIR, 'installer-version.json'),
    JSON.stringify({ version }) + '\n',
    'utf8',
  );
  console.log(`  Version: ${version}`);
}

function main() {
  try {
    setStaticDir(parseStaticDirArg(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  fs.mkdirSync(STATIC_DIR, { recursive: true });
  if (STATIC_DIR !== DEFAULT_STATIC_DIR) console.log(`Static output dir: ${STATIC_DIR}`);

  console.log('Syncing installer package version to bundled hook version...');
  ensureInstallerVersionTracksHook();

  console.log('Checking hooks.json against INSTALL_HOOK.md...');
  const installMdText = fs.readFileSync(INSTALL_MD, 'utf8');
  const drift = findHooksEventDrift(installMdText, HOOKS_JSON);
  if (drift) {
    console.error('HOOKS_JSON event names have drifted from hook/INSTALL_HOOK.md:');
    if (drift.missingFromJson.length) {
      console.error(`  In INSTALL_HOOK.md but missing from HOOKS_JSON: ${drift.missingFromJson.join(', ')}`);
    }
    if (drift.missingFromDoc.length) {
      console.error(`  In HOOKS_JSON but missing from INSTALL_HOOK.md: ${drift.missingFromDoc.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('Checking every hook module is bundled...');
  assertHookFilesComplete();

  console.log('Compiling CLI...');
  compileCli();

  console.log('Adding shebang...');
  addShebang();

  console.log('Packing marketplace/plugin tarball...');
  const { pluginJson, scriptsVersionJson } = packMarketplaceTarball();

  console.log('Packing CLI tarball...');
  packCliTarball();

  console.log('Writing version manifest...');
  writeVersionManifest();

  console.log('Checking version agreement...');
  const versions = {
    hookVersionFile: readHookVersion(),
    bundledScriptsVersion: JSON.parse(scriptsVersionJson.toString('utf8')).version,
    pluginJsonVersion: pluginJson.version,
    installerVersionFile: JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'installer-version.json'), 'utf8')).version,
  };
  const mismatch = findVersionMismatch(versions);
  if (mismatch) {
    console.error(`Version mismatch across plugin artifacts: ${JSON.stringify(mismatch)}`);
    process.exit(1);
  }

  console.log('Done.');
}

if (require.main === module) {
  main();
}

module.exports = {
  findHooksEventDrift,
  parseEventNamesFromInstallMd,
  findVersionMismatch,
  findOverlongTarNames,
  buildConfigTemplate,
  buildMarketplaceJson,
  buildPluginJson,
  readHookVersion,
  ensureInstallerVersionTracksHook,
  parseStaticDirArg,
  DEFAULT_STATIC_DIR,
  HOOKS_JSON,
  HOOK_JS_FILES,
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  MARKETPLACE_ROOT,
  PLUGIN_ROOT,
};
