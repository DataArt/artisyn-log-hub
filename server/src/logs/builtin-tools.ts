/**
 * Static mirror of `client/src/viewer/lib/tools/registry.ts`'s `TOOLS` array.
 *
 * `harness_elements` seeds one read-only `tool`-kind row per name here for every repo, once:
 * built-in tools always exist and were never "added" by a specific repo's self-report, so they carry
 * no `first_seen`/`last_seen` (both `NULL`) and are never `removed`.
 *
 * `client/` and `server/` are isolated packages (see `client.md`), so this list is kept in
 * sync with `registry.ts`'s `TOOLS` by convention + a drift-check test, not by a shared import. Update both together.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
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
