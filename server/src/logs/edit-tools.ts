/**
 * The single server-side list of tool names that count as "the model edited or wrote code".
 *
 * The literal triple `'Edit' | 'Write' | 'MultiEdit'` used to be hand-copied into every
 * counter that measures code impact, and one of those copies fell behind: the analytics
 * timeline's raw-JSONB fallback and two client derives still listed only `Edit`/`Write`, so
 * a `MultiEdit`-heavy session reported fewer files and fewer lines than `session_stats` did
 * for the very same transcript. Both packages now import the list from one
 * module — this file on the server, `client/src/viewer/pages/repository/session-log/
 * edit-tools.ts` on the client — so adding a fourth edit tool is a two-line change instead
 * of a hunt through six files.
 *
 * Order matters only for readability; every consumer treats it as a set.
 */
export const EDIT_WRITE_TOOL_NAMES = ['Edit', 'Write', 'MultiEdit'] as const;

export type EditWriteToolName = (typeof EDIT_WRITE_TOOL_NAMES)[number];

/**
 * `true` when `name` is one of {@link EDIT_WRITE_TOOL_NAMES}.
 *
 * Takes `string | null | undefined` because the transcript walkers read tool names out of
 * untyped JSONL (`asString(...)` yields `string | null`), and narrows on success so a caller
 * can keep switching on the concrete name afterwards.
 */
export function isEditWriteTool(
  name: string | null | undefined,
): name is EditWriteToolName {
  if (name === null || name === undefined) return false;
  return (EDIT_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}
