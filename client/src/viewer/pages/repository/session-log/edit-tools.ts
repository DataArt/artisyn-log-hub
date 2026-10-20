/**
 * The single client-side list of tool names that count as "the model edited or wrote code".
 *
 * The literal pair `'Edit' | 'Write'` used to be hand-copied into every counter that measures
 * code impact, and those copies fell behind the server: `session-usage-derive.ts` and
 * `session-info-derive.ts` listed only `Edit`/`Write` while `claude-extractor.ts` has always
 * counted `MultiEdit` too, so a `MultiEdit`-heavy session reported fewer files and fewer lines
 * in the browser than `session_stats` did for the very same transcript. Both
 * packages now import the list from one module — this file on the client,
 * `server/src/logs/edit-tools.ts` on the server — so adding a fourth edit tool is a two-line
 * change instead of a hunt through six files.
 *
 * This lives in its own module rather than inside `session-usage-derive.ts` so that
 * `tree-code-impact.ts` and the `session-info-derive.ts` gate can use it without either of
 * them importing the derive layer (and without forming an import cycle).
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
