'use strict';
/**
 * Claude Code Hook helper — the per-session OTEL status: effective config, state, reason, the
 * write rule and the Claude Code version (not a hook entry point itself).
 *
 * The pure functions here are the algorithm documented in
 * `docs/knowledgebase/algorithms/otel-status-reason.md` and table-tested by
 * `__tests__/otel-status-reason.algo.test.js`:
 *
 *  - `resolveEffectiveOtel(scopes, claudeVersion)` — DD-14: per Artisyn OTEL key, which scope wins
 *    (managed > local > project > user before Claude Code 2.1.282, Claude Code's own settings
 *    precedence; managed > user from 2.1.282 on, or when the version is unknown) and which keys are
 *    ignored.
 *  - `deriveConfigWarnings(input)` — DD-14: the `project-only` / `endpoint-drift` / `port-mismatch`
 *    warning classes.
 *  - `deriveState(received, signals)` — DD-15: `ok` / `partial` / `none`.
 *  - `deriveReason(input)` — DD-15: first matching reason.
 *  - `shouldWriteStatus(phase, prev, next)` — DD-15: when Stop / SessionEnd emits `otel-status`.
 *  - `buildOtelStatusEvent(input)` — DD-16: the `otel-status` event line.
 *
 * `resolveClaudeVersion` (DD-13) is the only function with I/O: transcript tail → the
 * `claude-version.json` cache → `claude --version` at most once per 24 h.
 *
 * Never writes a settings file.
 */

const childProcess = require('child_process');
const fs = require('fs');

const { stateFilePath, readJsonObject, atomicWriteJson } = require('./user-state');
const {
  SIGNALS,
  SIGNAL_ENDPOINT_KEYS,
  SIGNAL_EXPORTER_KEYS,
  ENABLE_TELEMETRY_KEY,
} = require('./managed-settings');

// From this Claude Code version on, telemetry keys in `.claude/settings.json` and
// `.claude/settings.local.json` are ignored — they must be in user or managed settings.
const CLAUDE_CODE_PROJECT_OTEL_CUTOFF = '2.1.282';

// DD-13: how much of the transcript tail is scanned for a `version` field, how often the CLI may be
// asked, and how long it may take.
const TRANSCRIPT_VERSION_SCAN_BYTES = 65536;
const CLAUDE_VERSION_CLI_INTERVAL_MS = 86400000;
const CLAUDE_VERSION_CLI_TIMEOUT_MS = 1500;

// The keys the installer writes (otel-env.ts `OTEL_ENV_KEYS` + `OTEL_TRACE_ENV_KEYS`, plus the
// resource attributes of DD-23).
const ARTISYN_OTEL_KEYS = [
  ENABLE_TELEMETRY_KEY,
  SIGNAL_EXPORTER_KEYS.logs,
  SIGNAL_EXPORTER_KEYS.metrics,
  SIGNAL_EXPORTER_KEYS.spans,
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  SIGNAL_ENDPOINT_KEYS.logs,
  SIGNAL_ENDPOINT_KEYS.metrics,
  SIGNAL_ENDPOINT_KEYS.spans,
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_RESOURCE_ATTRIBUTES',
];

const ENDPOINT_KEYS = [SIGNAL_ENDPOINT_KEYS.logs, SIGNAL_ENDPOINT_KEYS.metrics, SIGNAL_ENDPOINT_KEYS.spans];

// Scope order, highest precedence first — Claude Code's settings precedence (managed > local >
// project > user). From 2.1.282 on the project scopes are skipped, leaving managed > user.
const SCOPE_ORDER = ['managed', 'local', 'project', 'user'];
const PROJECT_SCOPES = ['local', 'project'];

const STATE_RANK = { none: 0, partial: 1, ok: 2 };

const LOOPBACK_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:\/.*)?$/i;

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * Compare two `x.y.z` versions; `null` when either does not parse.
 * @param {string} a
 * @param {string} b
 * @returns {number|null} negative, 0 or positive
 */
function compareVersions(a, b) {
  const ma = VERSION_RE.exec(String(a || ''));
  const mb = VERSION_RE.exec(String(b || ''));
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether Claude Code reads telemetry keys from the project scopes: only a known version below the
 * cutoff does. An unknown version is treated as "at or past the cutoff".
 * @param {string|null|undefined} claudeVersion
 * @returns {boolean}
 */
function projectScopeHonored(claudeVersion) {
  const cmp = compareVersions(claudeVersion, CLAUDE_CODE_PROJECT_OTEL_CUTOFF);
  return cmp !== null && cmp < 0;
}

/**
 * Whether an endpoint value points at an Artisyn receiver: loopback, and on `port` when given.
 * @param {*} value
 * @param {number|null} [port]
 * @returns {boolean}
 */
function isArtisynEndpoint(value, port) {
  if (typeof value !== 'string') return false;
  const match = LOOPBACK_ENDPOINT_RE.exec(value.trim());
  if (!match) return false;
  return port == null || Number(match[1]) === Number(port);
}

/**
 * @param {*} env
 * @param {string} key
 * @returns {boolean}
 */
function hasKey(env, key) {
  return !!env && typeof env === 'object' && typeof env[key] === 'string' && env[key].trim() !== '';
}

/**
 * DD-14 effective-config resolution (pure).
 * @param {{ managed?: Record<string,string>|null, user?: Record<string,string>|null,
 *   local?: Record<string,string>|null, project?: Record<string,string>|null }} scopes - each the
 *   `env` object of that scope (or null)
 * @param {string|null} claudeVersion
 * @returns {{
 *   projectScopeHonored: boolean,
 *   effective: Record<string, { value: string, scope: string }>,
 *   ignored: { key: string, scope: string, why: 'shadowed'|'project-scope-ignored' }[],
 *   projectOnlyKeys: string[],
 * }}
 */
function resolveEffectiveOtel(scopes, claudeVersion) {
  const s = scopes || {};
  const honored = projectScopeHonored(claudeVersion);
  const effective = {};
  const ignored = [];
  const projectOnlyKeys = [];
  for (const key of ARTISYN_OTEL_KEYS) {
    let winner = null;
    for (const scope of SCOPE_ORDER) {
      if (!hasKey(s[scope], key)) continue;
      const counts = honored || !PROJECT_SCOPES.includes(scope);
      if (!counts) {
        ignored.push({ key, scope, why: 'project-scope-ignored' });
        continue;
      }
      if (winner) {
        ignored.push({ key, scope, why: 'shadowed' });
        continue;
      }
      winner = scope;
      effective[key] = { value: s[scope][key].trim(), scope };
    }
    if (!winner && !honored && PROJECT_SCOPES.some((scope) => hasKey(s[scope], key))) projectOnlyKeys.push(key);
  }
  return { projectScopeHonored: honored, effective, ignored, projectOnlyKeys };
}

/**
 * DD-14 warning classes, one per class (pure).
 * @param {{ effective: ReturnType<typeof resolveEffectiveOtel>, userEnv?: Record<string,string>|null,
 *   forwardMode?: string|null, sharedPort?: number|null }} input
 * @returns {('project-only'|'endpoint-drift'|'port-mismatch')[]}
 */
function deriveConfigWarnings(input) {
  const out = [];
  const eff = input.effective;
  if (eff && eff.projectOnlyKeys.length > 0) out.push('project-only');
  const userEnv = input.userEnv || {};
  const userEndpoints = ENDPOINT_KEYS.filter((key) => hasKey(userEnv, key)).map((key) => userEnv[key].trim());
  if ((input.forwardMode === 'proxy' || input.forwardMode === 'replace')
    && userEndpoints.some((value) => !isArtisynEndpoint(value, null))) {
    out.push('endpoint-drift');
  }
  if (input.sharedPort != null && userEndpoints.some((value) => isArtisynEndpoint(value, null)
    && !isArtisynEndpoint(value, input.sharedPort))) {
    out.push('port-mismatch');
  }
  return out;
}

/**
 * The enabled signals of a `{logs, metrics, spans}` flag map.
 * @param {*} signals
 * @returns {string[]}
 */
function enabledSignals(signals) {
  const s = signals || {};
  return SIGNALS.filter((signal) => s[signal] === true);
}

/**
 * DD-15 state (pure): `ok` = every enabled signal has ≥ 1 record, `partial` = some, `none` = none.
 * `received` excludes pending records.
 * @param {{ logs?: number, metrics?: number, spans?: number }} received
 * @param {{ logs?: boolean, metrics?: boolean, spans?: boolean }} signals
 * @returns {'ok'|'partial'|'none'}
 */
function deriveState(received, signals) {
  const enabled = enabledSignals(signals);
  if (enabled.length === 0) return 'none';
  const r = received || {};
  const present = enabled.filter((signal) => Number(r[signal]) >= 1).length;
  if (present === enabled.length) return 'ok';
  return present > 0 ? 'partial' : 'none';
}

/**
 * DD-15 reason (pure), first match wins.
 * @param {{
 *   state: 'ok'|'partial'|'none',
 *   receiverDown?: boolean,
 *   detail?: string|null,
 *   signals?: { logs?: boolean, metrics?: boolean, spans?: boolean },
 *   managed?: { pinnedSignals?: string[], disabledSignals?: string[] }|null,
 *   userHasArtisynEndpoint?: boolean,
 *   projectHasArtisynEndpoint?: boolean,
 *   effectiveHasArtisynEndpoint?: boolean,
 *   claudeVersion?: string|null,
 * }} input
 * @returns {'receiver-down'|'managed-disabled'|'managed-endpoint'|'project-only'|'not-configured'|'unknown'|null}
 */
function deriveReason(input) {
  const i = input || {};
  if (i.receiverDown === true || i.detail === 'port-conflict') return 'receiver-down';
  if (i.state === 'ok') return null;
  const enabled = enabledSignals(i.signals);
  const pinned = (i.managed && i.managed.pinnedSignals) || [];
  const disabled = (i.managed && i.managed.disabledSignals) || [];
  const anyPinned = enabled.some((signal) => pinned.includes(signal));
  const anyDisabled = enabled.some((signal) => disabled.includes(signal));
  if (anyDisabled && !anyPinned) return 'managed-disabled';
  if (anyPinned) return 'managed-endpoint';
  if (!i.userHasArtisynEndpoint && i.projectHasArtisynEndpoint && !projectScopeHonored(i.claudeVersion)) {
    return 'project-only';
  }
  if (!i.effectiveHasArtisynEndpoint) return 'not-configured';
  return 'unknown';
}

/**
 * DD-15 write rule (pure).
 *  - `stop`: write when nothing was written yet and ≥ 1 record arrived, or when the state improved.
 *  - `session-end`: write when nothing was written yet, or when the state improved.
 * @param {'stop'|'session-end'} phase
 * @param {{ state: string }|null} prev - the mark of the last written status
 * @param {{ state: string, received?: { logs?: number, metrics?: number, spans?: number } }} next
 * @returns {boolean}
 */
function shouldWriteStatus(phase, prev, next) {
  if (!next) return false;
  const improved = !!prev && (STATE_RANK[next.state] ?? -1) > (STATE_RANK[prev.state] ?? -1);
  if (prev) return improved;
  if (phase === 'session-end') return true;
  if (phase === 'stop') {
    const r = next.received || {};
    const total = (Number(r.logs) || 0) + (Number(r.metrics) || 0) + (Number(r.spans) || 0);
    return total >= 1;
  }
  return false;
}

/**
 * DD-16: the `otel-status` event line of one session (pure, except `Date.now()` when `now` is not
 * given).
 *
 * `status` is what `queryOtelSessionStatus` (otel-register.js) answered, or `{legacy: true}` for the
 * DD-6 per-project fallback, which has no session-status route:
 *  - DD-11 body → counts, `firstAt`, `forward`, `receiverVersion` from it;
 *  - `{unreachable: true, detail}` → zero counts, `reason: 'receiver-down'`;
 *  - `{unsupported: true, detail}` → zero counts, `reason: 'unknown'` and the given detail
 *    (`no-session-status` for a missing capability or a 404, DD-16);
 *  - `{legacy: true}` → zero counts, `detail: 'legacy-receiver'`, reason from `deriveReason`.
 * @param {{
 *   sessionId: string,
 *   status: Record<string, *>|null,
 *   signals: { logs?: boolean, metrics?: boolean, spans?: boolean },
 *   managed?: { pinnedSignals?: string[], disabledSignals?: string[] }|null,
 *   userHasArtisynEndpoint?: boolean,
 *   projectHasArtisynEndpoint?: boolean,
 *   effectiveHasArtisynEndpoint?: boolean,
 *   claudeVersion?: string|null,
 *   hookVersion?: string|null,
 *   now?: number,
 * }} input
 * @returns {{ type: 'otel-status', timestamp: string, sessionId: string, state: 'ok'|'partial'|'none',
 *   reason: string|null, detail: string|null,
 *   received: { logs: number, metrics: number, spans: number, firstAt: string|null },
 *   claudeVersion: string|null, forward: 'ok'|'degraded'|'off', hookVersion: string|null,
 *   receiverVersion: string|null }}
 */
function buildOtelStatusEvent(input) {
  const i = input || {};
  const status = i.status && typeof i.status === 'object' ? i.status : { unreachable: true, detail: null };
  const legacy = status.legacy === true;
  const unreachable = !legacy && status.unreachable === true;
  const unsupported = !legacy && !unreachable && status.unsupported === true;
  const answered = !legacy && !unreachable && !unsupported;

  const r = answered && status.received && typeof status.received === 'object' ? status.received : {};
  const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
  const received = {
    logs: count(r.logs),
    metrics: count(r.metrics),
    spans: count(r.spans),
    firstAt: answered && typeof status.firstRecordAt === 'string' ? status.firstRecordAt : null,
  };
  const state = deriveState(received, i.signals);

  let detail = null;
  if (legacy) detail = 'legacy-receiver';
  else if (unreachable || unsupported) detail = typeof status.detail === 'string' && status.detail ? status.detail : null;

  const reason = unsupported
    ? 'unknown'
    : deriveReason({
      state,
      receiverDown: unreachable,
      detail,
      signals: i.signals,
      managed: i.managed || null,
      userHasArtisynEndpoint: !!i.userHasArtisynEndpoint,
      projectHasArtisynEndpoint: !!i.projectHasArtisynEndpoint,
      effectiveHasArtisynEndpoint: !!i.effectiveHasArtisynEndpoint,
      claudeVersion: i.claudeVersion || null,
    });

  const forward = answered && (status.forward === 'ok' || status.forward === 'degraded') ? status.forward : 'off';
  const receiverVersion = !legacy && typeof status.receiverVersion === 'string' ? status.receiverVersion : null;

  return {
    type: 'otel-status',
    timestamp: new Date(typeof i.now === 'number' ? i.now : Date.now()).toISOString(),
    sessionId: i.sessionId,
    state,
    reason,
    detail,
    received,
    claudeVersion: typeof i.claudeVersion === 'string' && i.claudeVersion ? i.claudeVersion : null,
    forward,
    hookVersion: typeof i.hookVersion === 'string' && i.hookVersion ? i.hookVersion : null,
    receiverVersion,
  };
}

/**
 * The last `version` field among the complete JSON lines of a transcript tail (pure).
 * @param {string} text
 * @returns {string|null}
 */
function versionFromTranscriptTail(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.includes('"version"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.version === 'string' && VERSION_RE.test(parsed.version)) return parsed.version;
    } catch {
      // a partial first line of the tail, or a malformed line — skip it
    }
  }
  return null;
}

/**
 * Read the last `TRANSCRIPT_VERSION_SCAN_BYTES` of a file as utf8. `''` on any failure.
 * @param {string} file
 * @returns {string}
 */
function readTail(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_VERSION_SCAN_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * `claude --version` → `x.y.z`, or `null`. Runs through a shell on win32 (`claude` is a `.cmd`
 * shim there); the command is a fixed string, never user input.
 * @returns {string|null}
 */
function runClaudeVersionCli() {
  try {
    const output = childProcess.execSync('claude --version', {
      encoding: 'utf8',
      timeout: CLAUDE_VERSION_CLI_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /(\d+\.\d+\.\d+)/.exec(String(output || ''));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * DD-13: the Claude Code version of this session and where it came from.
 * @param {{ transcriptPath?: string|null, stateDir?: string, homeDir?: string, now?: number,
 *   runCli?: () => string|null }} [opts]
 * @returns {{ version: string|null, source: 'transcript'|'cache'|'cli'|'none' }}
 */
function resolveClaudeVersion(opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const cacheFile = stateFilePath('claudeVersion', opts);
  const cache = readJsonObject(cacheFile) || {};
  const cachedVersion = typeof cache.version === 'string' && VERSION_RE.test(cache.version) ? cache.version : null;
  const seenAt = typeof cache.seenAt === 'string' ? Date.parse(cache.seenAt) : NaN;
  const cliAttemptAt = typeof cache.cliAttemptAt === 'string' ? Date.parse(cache.cliAttemptAt) : NaN;

  try {
    const fromTranscript = opts.transcriptPath ? versionFromTranscriptTail(readTail(opts.transcriptPath)) : null;
    if (fromTranscript) {
      if (fromTranscript !== cachedVersion || Number.isNaN(seenAt) || now - seenAt >= CLAUDE_VERSION_CLI_INTERVAL_MS) {
        atomicWriteJson(cacheFile, { ...cache, version: fromTranscript, seenAt: new Date(now).toISOString() });
      }
      return { version: fromTranscript, source: 'transcript' };
    }

    if (cachedVersion && !Number.isNaN(seenAt) && now - seenAt < CLAUDE_VERSION_CLI_INTERVAL_MS) {
      return { version: cachedVersion, source: 'cache' };
    }

    const cliAllowed = Number.isNaN(cliAttemptAt) || now - cliAttemptAt >= CLAUDE_VERSION_CLI_INTERVAL_MS;
    if (cliAllowed) {
      const fromCli = (opts.runCli || runClaudeVersionCli)();
      const attemptIso = new Date(now).toISOString();
      if (fromCli) {
        atomicWriteJson(cacheFile, { version: fromCli, seenAt: attemptIso, cliAttemptAt: attemptIso });
        return { version: fromCli, source: 'cli' };
      }
      atomicWriteJson(cacheFile, { ...cache, cliAttemptAt: attemptIso });
    }
  } catch {
    // fall through to whatever the cache has
  }
  return cachedVersion ? { version: cachedVersion, source: 'cache' } : { version: null, source: 'none' };
}

module.exports = {
  CLAUDE_CODE_PROJECT_OTEL_CUTOFF,
  TRANSCRIPT_VERSION_SCAN_BYTES,
  CLAUDE_VERSION_CLI_INTERVAL_MS,
  CLAUDE_VERSION_CLI_TIMEOUT_MS,
  ARTISYN_OTEL_KEYS,
  STATE_RANK,
  compareVersions,
  projectScopeHonored,
  isArtisynEndpoint,
  resolveEffectiveOtel,
  deriveConfigWarnings,
  enabledSignals,
  deriveState,
  deriveReason,
  shouldWriteStatus,
  buildOtelStatusEvent,
  versionFromTranscriptTail,
  resolveClaudeVersion,
};
