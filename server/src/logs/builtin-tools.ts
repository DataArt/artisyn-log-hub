/**
 * Claude Code's built-in tool names — the single list on the server.
 *
 * `harness_elements` seeds one read-only `tool`-kind row per name here for every repo
 * (`harness-elements-writer.ts`, `onConflictDoNothing`, so a name added here reaches existing
 * repos on their next harness sync): built-in tools always exist and were never "added" by a
 * specific repo's self-report, so they carry no `first_seen`/`last_seen` (both `NULL`) and are
 * never `removed`.
 *
 * No client copy or drift test exists any more; this list is the only source.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'PowerShell',
  'Glob',
  'Grep',
  'Agent',
  'ToolSearch',
  'Skill',
  'PlanMode',
  'AskUserQuestion',
  'advisor',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'NotebookEdit',
  'LSP',
  'LoadedRule',
];
