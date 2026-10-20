/**
 * The "Harness usage" tab's element-kind vocabulary.
 *
 * Deliberately NOT an extension of `models/harness-usage.ts`: that module's
 * `HarnessElementKind` (`skill | rule | mcp | tool`) is the wire contract of the repo-level
 * Harness Usage report — aggregated, no timestamps, mirrored by a server writer. This tab derives
 * the same five kinds from raw transcripts instead of a server-aggregated table, so it declares
 * its own union rather than importing that one. The symbols here carry a `TAB` infix to make a
 * wrong import obvious at the call site.
 */

/** The five harness producers this tab records. Anything else is not inspected at all. */
export type HarnessTabElementKind =
  | 'skill'
  | 'rule'
  | 'workflow'
  | 'mcp'
  | 'tool';

/** Fixed render order for anything that needs to enumerate the kinds. */
export const HARNESS_TAB_KIND_ORDER: readonly HarnessTabElementKind[] = [
  'skill',
  'rule',
  'workflow',
  'mcp',
  'tool',
];

export const HARNESS_TAB_KIND_LABELS: Record<HarnessTabElementKind, string> = {
  skill: 'SKILL',
  rule: 'RULE',
  workflow: 'WORKFLOW',
  mcp: 'MCP',
  tool: 'TOOL',
};

/**
 * Badge palette. `skill`/`rule`/`mcp` are copied verbatim from
 * `reports/harness-usage-rows.ts` so the two harness surfaces agree on colour; `tool` copies that
 * same report's `tool` colour for the same reason. `workflow` continues the same `-100/-700` +
 * dark `-900/40 / -300` shape with a colour the report doesn't need (it has no `workflow` kind).
 */
export const HARNESS_TAB_KIND_BADGE_CLASSNAMES: Record<
  HarnessTabElementKind,
  string
> = {
  skill:
    'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  rule: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  mcp: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  tool: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  workflow:
    'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
};

/**
 * Rule label from an attachment's `displayPath`/`path` — `.claude/rules/client.md` → `client`,
 * `server/CLAUDE.md` → `server`.
 *
 * Mirrors `normalizeRuleName` in `log-parser.ts`, which is module-private there. Re-declared
 * rather than exported from that module so this tab does not widen the parser's export surface
 * for a ten-line pure helper.
 */
export function normalizeRuleName(displayPath: string): string {
  const normalized = displayPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return displayPath;
  const filename = parts[parts.length - 1].replace(/\.md$/i, '');
  // For CLAUDE.md-style files, the parent directory is the useful label.
  if (filename.toUpperCase() === 'CLAUDE' && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return filename;
}
