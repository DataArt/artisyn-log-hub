'use strict';
/**
 * Claude Code Hook helper — CLI tool-wrap name rules and constants (not a hook entry point).
 *
 * Plain-JS twin of the shared TypeScript package `packages/tool-monitor` (`@loghub/tool-monitor`,
 * used by the Log Hub server and client). The hook cannot import that package, so the denylist,
 * `validateToolName()` and the capture constants are copied here — change both together. Both
 * copies are tested from one algorithm doc,
 * docs/knowledgebase/algorithms/tool-monitor-name-validation.md.
 *
 * Below the shared part are the hook-only constants of the tool-wrap feature (shim pruning,
 * breaker, config refresh, upload cap, self-test marker) and `toolMentionRegex()`, used by the
 * PowerShell PreToolUse wrapper to decide whether a command mentions a monitored tool.
 */

// ---------------------------------------------------------------------------
// Shared with @loghub/tool-monitor (DD-4)
// ---------------------------------------------------------------------------

/** Longest accepted tool name. */
const TOOL_NAME_MAX = 64;
/** Per-stream cap on the stdout / stderr text the wrapper captures. */
const CAPTURE_LIMIT_BYTES = 102400;
/** Cap on the stdin text the wrapper captures. */
const STDIN_CAPTURE_LIMIT_BYTES = 102400;
/** Most tools one configuration level may list. */
const MAX_MONITORED_TOOLS = 100;

const ROLE_NAMES = {
  shell: ['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'cmd', 'wsl'],
  wrapper: ['node', 'tee', 'env', 'cygpath', 'cat', 'printf', 'mkdir', 'date', 'command'],
  agent: ['claude', 'git', 'npx', 'npm'],
  process: ['sudo', 'su', 'doas', 'runas', 'exec', 'nohup', 'timeout', 'xargs', 'time'],
  builtin: [
    'cd', 'echo', 'export', 'source', '.', 'set', 'alias', 'exit', 'eval', 'trap', 'read', 'test',
    '[', 'true', 'false', 'type', 'which', 'where',
  ],
};

const ROLE_ORDER = ['shell', 'wrapper', 'agent', 'process', 'builtin'];

/** Names that can never be monitored, each with the role it plays (lower case). */
const TOOL_DENYLIST = Object.freeze(
  ROLE_ORDER.flatMap((role) => ROLE_NAMES[role].map((name) => Object.freeze({ name, role }))),
);

const DENYLIST_BY_NAME = new Map(TOOL_DENYLIST.map((e) => [e.name, e.role]));

const ROLE_MESSAGES = {
  shell: "is the agent's shell and cannot be monitored",
  wrapper: 'is used by the wrapper itself and cannot be monitored',
  agent: 'is agent infrastructure and cannot be monitored',
  process: 'is a process-control command and cannot be monitored',
  builtin: 'is a shell builtin and cannot be monitored',
};

const EXECUTABLE_SUFFIX = /\.(exe|cmd|bat|ps1)$/i;
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * The comparison key of a tool name: trimmed, lower case, without a trailing
 * `.exe` / `.cmd` / `.bat` / `.ps1`.
 * @param {string} name
 * @returns {string}
 */
function normalizeToolName(name) {
  return String(name).trim().toLowerCase().replace(EXECUTABLE_SUFFIX, '');
}

/**
 * The denylist role of a name (case-insensitive, executable suffix ignored), or null.
 * @param {string} name
 * @returns {string|null}
 */
function denylistRole(name) {
  const role = DENYLIST_BY_NAME.get(normalizeToolName(name));
  return role === undefined ? null : role;
}

/**
 * Checks a tool name. The name is not trimmed: surrounding whitespace is `bad_chars`. Checks run
 * in order empty → too_long → bad_chars → denylisted.
 * @param {string} name
 * @returns {{ ok: true } | { ok: false, code: 'empty'|'too_long'|'bad_chars'|'denylisted', message: string }}
 */
function validateToolName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, code: 'empty', message: 'Tool name is required' };
  }
  if (name.length > TOOL_NAME_MAX) {
    return {
      ok: false,
      code: 'too_long',
      message: `Tool name must be at most ${TOOL_NAME_MAX} characters`,
    };
  }
  if (!NAME_PATTERN.test(name) || name === '.' || name === '..') {
    return {
      ok: false,
      code: 'bad_chars',
      message: 'Tool name may contain only letters, digits, ".", "_" and "-" (no paths)',
    };
  }
  const role = denylistRole(name);
  if (role !== null) {
    return { ok: false, code: 'denylisted', message: `\`${name}\` ${ROLE_MESSAGES[role]}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Hook-only constants (DD-22)
// ---------------------------------------------------------------------------

/** Cap on the assembled `tool-calls` upload file; past it the oldest calls' text is dropped. */
const UPLOAD_CAP_BYTES = 52428800;
/** Session dirs under `<workDir>/tool-wrap/` older than this are pruned at SessionStart. */
const SESSION_DIR_MAX_AGE_MS = 604800000;
/** Wrapper faults after which the global breaker trips. */
const BREAKER_GLOBAL_FAULTS = 3;
/** Throttle window of the UserPromptSubmit config refresh. */
const CONFIG_REFRESH_THROTTLE_MS = 60000;
/** Throttle state file of the UserPromptSubmit config refresh (under the work dir). */
const CONFIG_REFRESH_THROTTLE_FILE = 'tool-wrap-config.json';
/** What `tool-wrap-tee.js --self-test` prints on success. */
const SELF_TEST_OUTPUT = 'loghub-selftest-ok';
/** File name of the self-test shim in a session's shim dir (never a monitored tool). */
const SELF_TEST_SHIM_NAME = '__selftest';
/** Default of the config key `toolWrapConfigTimeoutMs`. */
const CONFIG_FETCH_TIMEOUT_MS_DEFAULT = 2000;
/**
 * Upper bound of the UserPromptSubmit config refresh fetch. The prompt hook must never hold
 * Claude up on a slow or hanging server, so this caps `toolWrapConfigTimeoutMs` on that path
 * (SessionStart still uses the configured value).
 */
const PROMPT_CONFIG_REFRESH_TIMEOUT_MS = 1000;
/** The only config response schema this hook understands (DD-3). */
const CONFIG_SCHEMA_VERSION = 1;

/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a PowerShell command mentions `tool` as a command word (DD-14): preceded by the start,
 * whitespace, `;`, `|`, `&` or `(`, optionally followed by `.exe`, then whitespace or the end.
 * Case-insensitive.
 * @param {string} tool
 * @returns {RegExp}
 */
function toolMentionRegex(tool) {
  return new RegExp('(^|[\\s;|&(])' + escapeRegExp(tool) + '(\\.exe)?(\\s|$)', 'i');
}

module.exports = {
  TOOL_NAME_MAX,
  CAPTURE_LIMIT_BYTES,
  STDIN_CAPTURE_LIMIT_BYTES,
  MAX_MONITORED_TOOLS,
  TOOL_DENYLIST,
  normalizeToolName,
  denylistRole,
  validateToolName,
  UPLOAD_CAP_BYTES,
  SESSION_DIR_MAX_AGE_MS,
  BREAKER_GLOBAL_FAULTS,
  CONFIG_REFRESH_THROTTLE_MS,
  CONFIG_REFRESH_THROTTLE_FILE,
  SELF_TEST_OUTPUT,
  SELF_TEST_SHIM_NAME,
  CONFIG_FETCH_TIMEOUT_MS_DEFAULT,
  PROMPT_CONFIG_REFRESH_TIMEOUT_MS,
  CONFIG_SCHEMA_VERSION,
  escapeRegExp,
  toolMentionRegex,
};
