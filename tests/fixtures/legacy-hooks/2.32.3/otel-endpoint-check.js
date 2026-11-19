'use strict';
/**
 * Claude Code Hook helper — the `SessionStart` OTEL endpoint self-check (not a hook entry point).
 *
 * Answers one question per session: does Claude Code's OTLP exporter actually post to the port this
 * project's receiver binds? When it does not, every OTEL record of the session is lost without a
 * trace — the exporter pushes over HTTP, does not spool, and nothing ever errors visibly. Measured
 * case: a project whose committed `.claude/settings.json` pointed at `:50280` while its gitignored
 * `.artisyn/config/otel-port.json` (and so the receiver) said `50962`; two days of OTEL data went
 * nowhere. That is why the installer now writes the endpoints to the gitignored, per-checkout
 * `.claude/settings.local.json` instead (older installs still have them in `.claude/settings.json`,
 * and the next installer "upgrade" moves them).
 *
 * Why the check reads the settings files instead of `process.env`: Claude Code does not pass the
 * `OTEL_*` keys of a settings `env` block on to hook processes (measured on 2.1.280 —
 * `CLAUDE_CODE_ENABLE_TELEMETRY` from the same block does arrive, every `OTEL_*` key does not). So
 * `resolveOtelPort`'s own endpoint cross-check never sees the endpoint and silently falls back to
 * `otelReceiverPort`. `process.env` is still consulted, last, for the case it IS set there (a shell
 * export, or a Claude Code version that forwards it).
 *
 * Hook 2.30.0+: the endpoint each key resolves to is the *effective* one (DD-14) — managed settings
 * first (`readManagedOtel`), then user, then (only for Claude Code before 2.1.282, see
 * `resolveEffectiveOtel`) project-local and project. Three more warning classes are written to
 * hook.log once per SessionStart (`deriveConfigWarnings`):
 *  - `project-only`: Artisyn keys exist only in project scope, which this Claude Code ignores;
 *  - `endpoint-drift`: the user-scope endpoint is not Artisyn's although `forward.json` says
 *    `proxy`/`replace` (someone re-pointed it after install);
 *  - `port-mismatch`: a user-scope Artisyn endpoint names another port than `port.json` (skipped
 *    when `resolveOtelPort` already wrote it for this session).
 *
 * Detection only: the hook never rewrites any settings file — this module writes no file at all. The installer owns the endpoints it
 * writes to `.claude/settings.local.json`, `.claude/settings.json` is usually committed, and a
 * rewrite would not reach the already-running exporter anyway — Claude Code reads its env once, at
 * startup.
 */

const fs = require('fs');
const path = require('path');

const { getGitRoot } = require('./git-context');
const { hookLog } = require('./hook-log');
const { claudeConfigDir } = require('./claude-config-dir');
const { readManagedOtel } = require('./managed-settings');
const { resolveEffectiveOtel, deriveConfigWarnings } = require('./otel-status');
const { readForward } = require('./user-state');
const { hasSessionWarning } = require('./throttle-state');

const HOOK_FILE = 'otel-endpoint-check.js';

const LOGS_KEY = 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';
const METRICS_KEY = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT';
const ENDPOINT_KEYS = [LOGS_KEY, METRICS_KEY];
// Hook 2.29.0+: the traces endpoint is checked only when the project opted in to traces
// (`otelTraces === true` in log-hub.json, written by the installer). A project that answered "no",
// or one installed by an older installer (key absent), has no traces endpoint by design.
const TRACES_KEY = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';

// Any loopback endpoint is treated as "meant for an Artisyn receiver"; anything else is the user's
// own collector and is deliberately left alone (same ownership rule as the installer's uninstall).
const LOOPBACK_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:\/.*)?$/i;

/**
 * The `env` object of one settings file, or `null` when the file is absent, unreadable, not JSON,
 * or has no `env` object. Never throws.
 * @param {string} file
 * @returns {Record<string, *>|null}
 */
function readSettingsEnv(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const env = parsed && typeof parsed === 'object' ? parsed.env : null;
    return env && typeof env === 'object' && !Array.isArray(env) ? env : null;
  } catch {
    return null;
  }
}

/**
 * The user-level Claude config dir, labelled without a machine-local absolute path.
 * @param {Record<string, *>} env
 * @returns {{ dir: string, label: string }}
 */
function userConfigSource(env) {
  const custom = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim() !== '';
  return { dir: claudeConfigDir(env), label: custom ? '$CLAUDE_CONFIG_DIR' : '~/.claude' };
}

/**
 * The settings files Claude Code merges `env` from, highest precedence first: project-local, then
 * project (for the session cwd and, when it differs, the git root), then the user's own. Each entry
 * carries a display label that never contains a machine-local absolute path.
 * @param {string|null} cwd
 * @param {{ dir: string, label: string }} user  the user-level Claude config dir and its display label
 * @returns {{ file: string, label: string }[]}
 */
function settingsSources(cwd, user) {
  const baseDir = cwd || process.cwd();
  const gitRoot = getGitRoot(baseDir);
  const projectDirs = [baseDir];
  if (path.resolve(gitRoot) !== path.resolve(baseDir)) projectDirs.push(gitRoot);

  const label = (dir, name) => {
    const rel = path.relative(gitRoot, path.join(dir, '.claude', name)).split(path.sep).join('/');
    return rel || `.claude/${name}`;
  };

  const sources = [];
  for (const name of ['settings.local.json', 'settings.json']) {
    for (const dir of projectDirs) {
      sources.push({ file: path.join(dir, '.claude', name), label: label(dir, name) });
    }
  }
  sources.push({ file: path.join(user.dir, 'settings.json'), label: `${user.label}/settings.json` });
  return sources;
}

/**
 * Merge the `env` objects of several same-scope files, earlier files winning per key.
 * @param {{ file: string, label: string, env: Record<string, *>|null }[]} loaded
 * @returns {{ env: Record<string, string>|null, labels: Record<string, string> }}
 */
function mergeScope(loaded) {
  const env = {};
  const labels = {};
  for (const src of loaded) {
    if (!src.env) continue;
    for (const [key, value] of Object.entries(src.env)) {
      if (key in env || typeof value !== 'string') continue;
      env[key] = value;
      labels[key] = src.label;
    }
  }
  return { env: Object.keys(env).length > 0 ? env : null, labels };
}

/**
 * Read every scope Claude Code takes OTEL keys from (DD-14): managed (all DD-12 sources merged),
 * user, project-local and project. Read-only.
 * @param {string|null} cwd
 * @param {{ env?: Record<string, *>, homeDir?: string, managed?: { env: Record<string, string> }|null }} [opts]
 *   `managed` is a pre-read `readManagedOtel()` result (it shells out on win32/darwin)
 * @returns {{ scopes: { managed: Record<string,string>|null, user: Record<string,string>|null,
 *   local: Record<string,string>|null, project: Record<string,string>|null },
 *   labels: { managed: Record<string,string>, user: Record<string,string>, local: Record<string,string>,
 *   project: Record<string,string> } }}
 */
function loadOtelScopes(cwd, opts = {}) {
  const env = opts.env || process.env;
  // `opts.homeDir` pins `<home>/.claude` (tests); otherwise follow Claude Code's own resolution,
  // which honors `CLAUDE_CONFIG_DIR`.
  const user = opts.homeDir
    ? { dir: path.join(opts.homeDir, '.claude'), label: '~/.claude' }
    : userConfigSource(env);
  const loaded = settingsSources(cwd, user).map((src) => ({ ...src, env: readSettingsEnv(src.file) }));
  const userFile = path.join(user.dir, 'settings.json');
  const local = mergeScope(loaded.filter((src) => path.basename(src.file) === 'settings.local.json'));
  const project = mergeScope(loaded.filter((src) => path.basename(src.file) === 'settings.json' && src.file !== userFile));
  const userScope = mergeScope(loaded.filter((src) => src.file === userFile));

  let managedRead = opts.managed;
  if (managedRead === undefined) {
    managedRead = readManagedOtel(opts.homeDir ? { env, homeDir: opts.homeDir } : { env });
  }
  const managedEnv = managedRead && managedRead.env && Object.keys(managedRead.env).length > 0 ? managedRead.env : null;
  const managedLabels = {};
  if (managedEnv) for (const key of Object.keys(managedEnv)) managedLabels[key] = 'managed settings';

  return {
    scopes: { managed: managedEnv, user: userScope.env, local: local.env, project: project.env },
    labels: { managed: managedLabels, user: userScope.labels, local: local.labels, project: project.labels },
  };
}

/**
 * The value Claude Code's exporter will use for `key`: the effective scope's value (DD-14), else
 * `env`. `null` when nothing that counts sets it.
 * @param {string} key
 * @param {ReturnType<typeof resolveEffectiveOtel>} effective
 * @param {ReturnType<typeof loadOtelScopes>['labels']} labels
 * @param {Record<string, *>} env
 * @returns {{ value: string, source: string }|null}
 */
function resolveEndpoint(key, effective, labels, env) {
  const hit = effective.effective[key];
  if (hit) {
    const scopeLabels = labels[hit.scope] || {};
    return { value: hit.value, source: scopeLabels[key] || `${hit.scope} settings` };
  }
  const fromEnv = env && typeof env[key] === 'string' ? env[key].trim() : '';
  return fromEnv ? { value: fromEnv, source: 'process environment' } : null;
}

/**
 * The endpoint keys to check: logs + metrics always, traces only when `otelTraces === true`.
 * @param {*} otelTraces
 * @returns {string[]}
 */
function endpointKeysFor(otelTraces) {
  return otelTraces === true ? [...ENDPOINT_KEYS, TRACES_KEY] : ENDPOINT_KEYS;
}

/**
 * The whole effective-config picture of this session (DD-14). Read-only.
 * @param {number} receiverPort
 * @param {string|null} cwd
 * @param {{ env?: Record<string, *>, homeDir?: string, otelTraces?: boolean, claudeVersion?: string|null,
 *   mode?: 'shared'|'legacy', managed?: { env: Record<string, string> }|null,
 *   forwardMode?: string|null }} [opts]
 * @returns {{ problems: { key: string, kind: 'missing'|'mismatch', value: string|null, source: string|null, port: number|null }[],
 *   warnings: ('project-only'|'endpoint-drift'|'port-mismatch')[],
 *   effective: ReturnType<typeof resolveEffectiveOtel> }}
 */
function analyzeOtelConfig(receiverPort, cwd, opts = {}) {
  const env = opts.env || process.env;
  const { scopes, labels } = loadOtelScopes(cwd, opts);
  const effective = resolveEffectiveOtel(scopes, opts.claudeVersion || null);

  const problems = [];
  for (const key of endpointKeysFor(opts.otelTraces)) {
    const resolved = resolveEndpoint(key, effective, labels, env);
    if (!resolved) {
      // A key that only the (ignored) project scope sets is reported as `project-only` instead.
      if (!effective.projectOnlyKeys.includes(key)) {
        problems.push({ key, kind: 'missing', value: null, source: null, port: null });
      }
      continue;
    }
    const match = LOOPBACK_ENDPOINT_RE.exec(resolved.value);
    if (!match) continue;
    const port = Number(match[1]);
    if (port !== receiverPort) {
      problems.push({ key, kind: 'mismatch', value: resolved.value, source: resolved.source, port });
    }
  }

  let forwardMode = opts.forwardMode;
  if (forwardMode === undefined) {
    const forward = readForward(opts.homeDir ? { homeDir: opts.homeDir } : {});
    forwardMode = forward ? forward.mode : null;
  }
  const warnings = deriveConfigWarnings({
    effective,
    userEnv: scopes.user,
    forwardMode,
    sharedPort: opts.mode === 'shared' ? receiverPort : null,
  });
  return { problems, warnings, effective };
}

/**
 * Every endpoint that will not reach the receiver on `receiverPort`.
 *  - `missing`: nothing effective sets it, so nothing is exported to the receiver at all.
 *  - `mismatch`: a loopback endpoint on a different port.
 * A non-loopback endpoint is the user's own (or the admin's) collector and is never reported.
 * @param {number} receiverPort
 * @param {string|null} cwd
 * @param {Parameters<typeof analyzeOtelConfig>[2]} [opts] - `otelTraces` is the project's config
 *   value; only `true` adds the traces endpoint to the check
 * @returns {{ key: string, kind: 'missing'|'mismatch', value: string|null, source: string|null, port: number|null }[]}
 */
function findOtelEndpointProblems(receiverPort, cwd, opts = {}) {
  return analyzeOtelConfig(receiverPort, cwd, opts).problems;
}

/**
 * The one-paragraph, user-facing description of `problems`, with the exact fix.
 * @param {number} receiverPort
 * @param {ReturnType<typeof findOtelEndpointProblems>} problems
 * @param {'shared'|'legacy'} [mode]
 * @returns {string}
 */
function formatProblems(receiverPort, problems, mode = 'legacy') {
  const keys = problems.some((p) => p.key === TRACES_KEY)
    ? `${LOGS_KEY}/${METRICS_KEY}/${TRACES_KEY}`
    : `${LOGS_KEY}/${METRICS_KEY}`;
  const details = problems.map((p) => (p.kind === 'missing'
    ? `${p.key} is not set`
    : `${p.source} sets ${p.key}=${p.value}`));
  const owner = mode === 'shared' ? 'your shared OTEL receiver' : 'this project\'s OTEL receiver';
  const target = mode === 'shared' ? '~/.claude/settings.json and .claude/settings.local.json' : '.claude/settings.local.json';
  return `Artisyn log-hub: OTEL telemetry of this session will be lost — ${owner} listens on ` +
    `127.0.0.1:${receiverPort}, but ${details.join('; ')}. Fix: re-run the log-hub installer "upgrade" (it writes ` +
    `${keys} for port ${receiverPort} to ${target}), then restart Claude Code.`;
}

// The hook.log text of each DD-14 warning class.
const WARNING_TEXT = {
  'project-only': (eff) => `otel project-only: ${eff.projectOnlyKeys.join(', ')} are set only in .claude/settings*.json, ` +
    'which Claude Code 2.1.282+ ignores for telemetry — re-run the log-hub installer to write them to ' +
    '~/.claude/settings.json, then restart Claude Code',
  'endpoint-drift': () => 'otel endpoint-drift: the user-scope OTLP endpoint no longer points at the Artisyn receiver ' +
    'although the installer set it up (~/.artisyn/otel/forward.json) — re-run the log-hub installer',
  'port-mismatch': (eff, port) => 'otel port-mismatch: a user-scope OTLP endpoint points at a loopback port other ' +
    `than the shared receiver's ${port} — re-run the log-hub installer "upgrade", then restart Claude Code`,
};

/**
 * Run the check, log the outcome to hook.log, and return the user-facing warning (or `null` when
 * everything points at the receiver). Each DD-14 warning class is logged once (this runs once per
 * SessionStart); `project-only` is also part of the returned message, since it loses the
 * session's OTEL data just like a wrong endpoint. Writes no file. Never throws.
 * @param {number} receiverPort
 * @param {string|null} cwd
 * @param {string|null} sessionId
 * @param {Parameters<typeof analyzeOtelConfig>[2]} [opts]
 * @returns {string|null}
 */
function checkOtelEndpoints(receiverPort, cwd, sessionId, opts = {}) {
  try {
    const { problems, warnings, effective } = analyzeOtelConfig(receiverPort, cwd, opts);

    for (const warning of warnings) {
      // `resolveOtelPort` may have written the same port-mismatch for this session already.
      if (warning === 'port-mismatch' && hasSessionWarning(sessionId, 'port-mismatch', cwd)) continue;
      hookLog(HOOK_FILE, sessionId, 'warn', WARNING_TEXT[warning](effective, receiverPort), cwd);
    }

    const parts = [];
    if (problems.length > 0) {
      const message = formatProblems(receiverPort, problems, opts.mode);
      hookLog(HOOK_FILE, sessionId, 'warn', message, cwd);
      parts.push(message);
    } else {
      hookLog(HOOK_FILE, sessionId, 'result', `otel endpoints point at the receiver on 127.0.0.1:${receiverPort}`, cwd);
    }
    if (warnings.includes('project-only')) {
      parts.push(`Artisyn log-hub: ${WARNING_TEXT['project-only'](effective, receiverPort)}.`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  } catch (err) {
    hookLog(HOOK_FILE, sessionId, 'error', `otel endpoint check failed: ${err.message}`, cwd);
    return null;
  }
}

module.exports = {
  analyzeOtelConfig,
  checkOtelEndpoints,
  findOtelEndpointProblems,
  loadOtelScopes,
  formatProblems,
  settingsSources,
  LOGS_KEY,
  METRICS_KEY,
  TRACES_KEY,
};
