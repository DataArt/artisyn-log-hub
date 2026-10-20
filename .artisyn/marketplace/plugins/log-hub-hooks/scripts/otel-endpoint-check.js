'use strict';
/**
 * Claude Code Hook helper — the `SessionStart` OTEL endpoint self-check (not a hook entry point).
 *
 * Answers one question per session: does Claude Code's OTLP exporter actually post to the port this
 * project's receiver binds? When it does not, every OTEL record of the session is lost without a
 * trace — the exporter pushes over HTTP, does not spool, and nothing ever errors visibly. Measured
 * case: a project whose committed `.claude/settings.json` pointed at `:50280` while its gitignored
 * `.artisyn/config/otel-port.json` (and so the receiver) said `50962`; two days of OTEL data went
 * nowhere.
 *
 * Why the check reads the settings files instead of `process.env`: Claude Code does not pass the
 * `OTEL_*` keys of a settings `env` block on to hook processes (measured on 2.1.280 —
 * `CLAUDE_CODE_ENABLE_TELEMETRY` from the same block does arrive, every `OTEL_*` key does not). So
 * `resolveOtelPort`'s own endpoint cross-check never sees the endpoint and silently falls back to
 * `otelReceiverPort`. `process.env` is still consulted, last, for the case it IS set there (a shell
 * export, or a Claude Code version that forwards it).
 *
 * Detection only: the hook never rewrites `.claude/settings.json`. That file is usually committed,
 * the port is per checkout, and a rewrite would not reach the already-running exporter anyway —
 * Claude Code reads its env once, at startup.
 */

const fs = require('fs');
const path = require('path');

const { getGitRoot } = require('./git-context');
const { hookLog } = require('./hook-log');
const { claudeConfigDir } = require('./claude-config-dir');

const HOOK_FILE = 'otel-endpoint-check.js';

const LOGS_KEY = 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';
const METRICS_KEY = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT';
const ENDPOINT_KEYS = [LOGS_KEY, METRICS_KEY];

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
 * The value Claude Code's exporter will use for `key`: the first settings file that sets it, else
 * `env`. `null` when nothing sets it.
 * @param {string} key
 * @param {{ file: string, label: string, env: Record<string, *>|null }[]} loaded
 * @param {Record<string, *>} env
 * @returns {{ value: string, source: string }|null}
 */
function resolveEndpoint(key, loaded, env) {
  for (const src of loaded) {
    if (src.env && typeof src.env[key] === 'string' && src.env[key].trim()) {
      return { value: src.env[key].trim(), source: src.label };
    }
  }
  const fromEnv = env && typeof env[key] === 'string' ? env[key].trim() : '';
  return fromEnv ? { value: fromEnv, source: 'process environment' } : null;
}

/**
 * Every endpoint that will not reach the receiver on `receiverPort`.
 *  - `missing`: nothing sets it, so nothing is exported to the receiver at all.
 *  - `mismatch`: a loopback endpoint on a different port.
 * A non-loopback endpoint is the user's own collector and is never reported.
 * @param {number} receiverPort
 * @param {string|null} cwd
 * @param {{ env?: Record<string, *>, homeDir?: string }} [opts]
 * @returns {{ key: string, kind: 'missing'|'mismatch', value: string|null, source: string|null, port: number|null }[]}
 */
function findOtelEndpointProblems(receiverPort, cwd, opts = {}) {
  const env = opts.env || process.env;
  // `opts.homeDir` pins `<home>/.claude` (tests); otherwise follow Claude Code's own resolution,
  // which honors `CLAUDE_CONFIG_DIR`.
  const user = opts.homeDir
    ? { dir: path.join(opts.homeDir, '.claude'), label: '~/.claude' }
    : userConfigSource(env);
  const loaded = settingsSources(cwd, user).map((src) => ({ ...src, env: readSettingsEnv(src.file) }));

  const problems = [];
  for (const key of ENDPOINT_KEYS) {
    const resolved = resolveEndpoint(key, loaded, env);
    if (!resolved) {
      problems.push({ key, kind: 'missing', value: null, source: null, port: null });
      continue;
    }
    const match = LOOPBACK_ENDPOINT_RE.exec(resolved.value);
    if (!match) continue;
    const port = Number(match[1]);
    if (port !== receiverPort) {
      problems.push({ key, kind: 'mismatch', value: resolved.value, source: resolved.source, port });
    }
  }
  return problems;
}

/**
 * The one-paragraph, user-facing description of `problems`, with the exact fix.
 * @param {number} receiverPort
 * @param {ReturnType<typeof findOtelEndpointProblems>} problems
 * @returns {string}
 */
function formatProblems(receiverPort, problems) {
  const details = problems.map((p) => (p.kind === 'missing'
    ? `${p.key} is not set`
    : `${p.source} sets ${p.key}=${p.value}`));
  return 'Artisyn log-hub: OTEL telemetry of this session will be lost — this project\'s OTEL receiver listens on ' +
    `127.0.0.1:${receiverPort}, but ${details.join('; ')}. Fix: set ${LOGS_KEY}=http://127.0.0.1:${receiverPort}/v1/logs ` +
    `and ${METRICS_KEY}=http://127.0.0.1:${receiverPort}/v1/metrics in .claude/settings.json (or remove both and re-run ` +
    'the log-hub installer "upgrade"), then restart Claude Code.';
}

/**
 * Run the check, log the outcome to hook.log, and return the user-facing warning (or `null` when
 * everything points at the receiver). Never throws.
 * @param {number} receiverPort
 * @param {string|null} cwd
 * @param {string|null} sessionId
 * @param {{ env?: Record<string, *>, homeDir?: string }} [opts]
 * @returns {string|null}
 */
function checkOtelEndpoints(receiverPort, cwd, sessionId, opts = {}) {
  try {
    const problems = findOtelEndpointProblems(receiverPort, cwd, opts);
    if (problems.length === 0) {
      hookLog(HOOK_FILE, sessionId, 'result', `otel endpoints point at the receiver on 127.0.0.1:${receiverPort}`, cwd);
      return null;
    }
    const message = formatProblems(receiverPort, problems);
    hookLog(HOOK_FILE, sessionId, 'warn', message, cwd);
    return message;
  } catch (err) {
    hookLog(HOOK_FILE, sessionId, 'error', `otel endpoint check failed: ${err.message}`, cwd);
    return null;
  }
}

module.exports = {
  checkOtelEndpoints,
  findOtelEndpointProblems,
  formatProblems,
  settingsSources,
  LOGS_KEY,
  METRICS_KEY,
};
