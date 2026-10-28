// CLI tool monitoring rules shared by the Log Hub server and client (DD-4 of the
// 2026-06-19-mcp-invocation-log-tab plan). The hook keeps a plain-JS twin,
// hook/.claude/telemetry_tool/tool-wrap-names.js — change both together; both are tested from
// docs/knowledgebase/algorithms/tool-monitor-name-validation.md.

/** Longest accepted tool name. */
export const TOOL_NAME_MAX = 64;
/** Per-stream cap on the stdout / stderr text the wrapper captures (and on MCP input / agentSaw). */
export const CAPTURE_LIMIT_BYTES = 102400;
/** Cap on the stdin text the wrapper captures. */
export const STDIN_CAPTURE_LIMIT_BYTES = 102400;
/** Most tools one configuration level may list. */
export const MAX_MONITORED_TOOLS = 100;

/** Why a denylisted name cannot be monitored; drives the validation message. */
export type DenylistRole = 'shell' | 'wrapper' | 'agent' | 'process' | 'builtin';

export interface DenylistEntry {
  readonly name: string;
  readonly role: DenylistRole;
}

const ROLE_NAMES: Readonly<Record<DenylistRole, readonly string[]>> = {
  shell: ['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'cmd', 'wsl'],
  wrapper: ['node', 'tee', 'env', 'cygpath', 'cat', 'printf', 'mkdir', 'date', 'command'],
  agent: ['claude', 'git', 'npx', 'npm'],
  process: ['sudo', 'su', 'doas', 'runas', 'exec', 'nohup', 'timeout', 'xargs', 'time'],
  builtin: [
    'cd', 'echo', 'export', 'source', '.', 'set', 'alias', 'exit', 'eval', 'trap', 'read', 'test',
    '[', 'true', 'false', 'type', 'which', 'where',
  ],
};

const ROLE_ORDER: readonly DenylistRole[] = ['shell', 'wrapper', 'agent', 'process', 'builtin'];

/** Names that can never be monitored, each with the role it plays (lower case). */
export const TOOL_DENYLIST: readonly DenylistEntry[] = ROLE_ORDER.flatMap((role) =>
  ROLE_NAMES[role].map((name) => ({ name, role })),
);

const DENYLIST_BY_NAME: ReadonlyMap<string, DenylistRole> = new Map(
  TOOL_DENYLIST.map((e) => [e.name, e.role] as const),
);

const ROLE_MESSAGES: Readonly<Record<DenylistRole, string>> = {
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
 * `.exe` / `.cmd` / `.bat` / `.ps1`. Used for denylist matching and for case-insensitive
 * uniqueness.
 */
export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(EXECUTABLE_SUFFIX, '');
}

/** The denylist role of a name (case-insensitive, executable suffix ignored), or null. */
export function denylistRole(name: string): DenylistRole | null {
  return DENYLIST_BY_NAME.get(normalizeToolName(name)) ?? null;
}

export type ToolNameErrorCode = 'empty' | 'too_long' | 'bad_chars' | 'denylisted';

export type ToolNameValidation =
  | { ok: true }
  | { ok: false; code: ToolNameErrorCode; message: string };

/**
 * Checks a tool name as typed by the user. The name is not trimmed: surrounding whitespace is
 * `bad_chars`. Checks run in order empty → too_long → bad_chars → denylisted.
 */
export function validateToolName(name: string): ToolNameValidation {
  if (name.length === 0) {
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
