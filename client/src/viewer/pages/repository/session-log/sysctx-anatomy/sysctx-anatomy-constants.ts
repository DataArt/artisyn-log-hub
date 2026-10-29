// Constants and vocabularies of the "System context anatomy" session tab.
// Algorithm: docs/knowledgebase/algorithms/sysctx-anatomy.md. Plan: DD 6, 7, 13, 14, 27 of
// docs/tasks/todo/2026-10-29-sysctx-anatomy-tab/impl-plan.md.

/** Partition kinds, in partition-table order (DD 6). */
export const ANATOMY_PARTITION_KINDS = [
  'system-prompt',
  'memory',
  'environment',
  'deferred-tools',
  'mcp-server',
  'agent-types',
  'skills',
  'instruction-file',
  'system-reminder',
  'first-prompt',
  'harness-internals',
] as const;

export type AnatomyPartitionKind = (typeof ANATOMY_PARTITION_KINDS)[number];

/**
 * The full kind vocabulary (DD 27): every partition kind plus `mcp-instructions`, the kind of a
 * server's instructions part inside `mcp-server` (DD 7) — never a bar partition of its own.
 */
export type AnatomyKind = AnatomyPartitionKind | 'mcp-instructions';

/** Source vocabulary (DD 27). */
export const ANATOMY_SOURCES = [
  'harness',
  'project',
  'user',
  'plugin',
  'org-synced',
  'built-in',
  'mcp-server',
  'system-reminder',
] as const;

export type AnatomySource = (typeof ANATOMY_SOURCES)[number];

/** Git vocabulary: the hook's `gitStatus` values plus `unknown` (no status reported). */
export const ANATOMY_GIT_VALUES = [
  'tracked',
  'untracked',
  'ignored',
  'outside-repo',
  'unknown',
] as const;

export type AnatomyGit = (typeof ANATOMY_GIT_VALUES)[number];

/** Role of one `type:user` line of the startup block (DD 11). */
export type FirstPromptRole =
  | 'command-caveat'
  | 'slash-command'
  | 'injected-body'
  | 'typed-prompt';

export const KIND_LABELS: Record<AnatomyKind, string> = {
  'system-prompt': 'System prompt (harness core)',
  memory: 'Memory index (MEMORY.md)',
  environment: 'Environment (estimated)',
  'deferred-tools': 'Deferred tool names (built-in)',
  'mcp-server': 'MCP servers',
  'mcp-instructions': 'MCP server instructions',
  'agent-types': 'Subagent types',
  skills: 'Skills listing',
  'instruction-file': 'Instruction files',
  'system-reminder': 'System reminders',
  'first-prompt': 'First user prompt',
  'harness-internals': 'Harness internals',
};

/** Fixed segment colours (Tailwind 400/500 hexes), one distinct colour per kind (DD 14). */
export const KIND_COLORS: Record<AnatomyKind, string> = {
  'system-prompt': '#6366f1', // indigo-500
  memory: '#a855f7', // purple-500
  environment: '#94a3b8', // slate-400
  'deferred-tools': '#14b8a6', // teal-500
  'mcp-server': '#0ea5e9', // sky-500
  'mcp-instructions': '#38bdf8', // sky-400
  'agent-types': '#f97316', // orange-500
  skills: '#22c55e', // green-500
  'instruction-file': '#f59e0b', // amber-500
  'system-reminder': '#ec4899', // pink-500
  'first-prompt': '#ef4444', // red-500
  'harness-internals': '#cbd5e1', // slate-300 (drawn hatched)
};

export const SOURCE_LABELS: Record<AnatomySource, string> = {
  harness: 'harness',
  project: 'project',
  user: 'user',
  plugin: 'plugin',
  'org-synced': 'org-synced',
  'built-in': 'built-in',
  'mcp-server': 'MCP server',
  'system-reminder': 'system reminder',
};

export const GIT_LABELS: Record<AnatomyGit, string> = {
  tracked: 'tracked',
  untracked: 'untracked',
  ignored: 'ignored',
  'outside-repo': 'outside repo',
  unknown: 'unknown',
};

export const FIRST_PROMPT_ROLE_LABELS: Record<FirstPromptRole, string> = {
  'command-caveat': 'command caveat',
  'slash-command': 'slash command',
  'injected-body': 'injected skill/command body',
  'typed-prompt': 'typed prompt',
};

/** Display path of the memory index (never the real project slug). */
export const MEMORY_DISPLAY_PATH =
  '~/.claude/projects/<project-slug>/memory/MEMORY.md';

/** Prefix of a file shown outside the repository and the user's `~/.claude` (DD 10). */
export const OUTSIDE_PATH_PREFIX = '<outside>/';

/** Bar: a segment with share in (0, MIN_SHARE_FOR_NATURAL) gets MIN_SEGMENT_PX width (DD 14). */
export const MIN_SEGMENT_PX = 6;
export const MIN_SHARE_FOR_NATURAL = 0.005;
/** Bar: a segment shows its label inside only when at least this wide (DD 14). */
export const LABEL_MIN_PX = 64;
/** Drill-downs: rows shown before the "Show all N" toggle (DD 8, 9). */
export const SKILLS_PREVIEW = 10;
export const MCP_PREVIEW = 10;

export interface HarnessInternalsHint {
  title: string;
  body: string;
  bullets: { term: string; text: string }[];
  closing: string;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Text of the Harness internals hint (DD 13). `n` = internals tokens, `p` = its share in %
 * (shown with 1 decimal), `m` = measured total, `a` = attributed sum.
 */
export function HARNESS_INTERNALS_HINT(
  n: number,
  p: number,
  m: number,
  a: number,
): HarnessInternalsHint {
  return {
    title: `Harness internals — ≈ ${fmtInt(n)} tokens (${p.toFixed(1)} % of the startup context)`,
    body: `Tokens that Claude Code sent in the first request but did not write to the session log, so they cannot be split further. Measured total ${fmtInt(m)} minus everything attributed above (${fmtInt(a)}). Mostly:`,
    bullets: [
      {
        term: 'Tool definitions',
        text: 'the JSON schemas and descriptions of the built-in tools (Bash, Read, Edit, Grep, Agent, …) and of MCP tools loaded at start. Usually the largest part.',
      },
      {
        term: 'Message wrapping',
        text: 'system-reminder tags, message framing and separators.',
      },
      {
        term: 'Estimate error',
        text: 'every other partition is a byte-based estimate, while the total is exact; their combined error lands here (it can be positive or negative).',
      },
    ],
    closing:
      'Deferred MCP tools are not here: only their names are loaded at start, shown under each MCP server.',
  };
}
