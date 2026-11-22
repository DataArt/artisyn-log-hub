/**
 * Everything the command view shows for one PowerShell command — the same `BashView` shape as
 * `buildBashView`: the formatted script (lifted `Set-Location`, folded here-strings), the file
 * summary and the list preview. Algorithm doc:
 * `docs/knowledgebase/algorithms/powershell-command-view.md`.
 *
 * The hook's wrap prefix is cut first (`stripLhWrap`): the formatted script, the preview and FILES
 * use the typed command, `rawDisplay` the stored one. Display strings are made repo-relative
 * (`toRepoRelative`).
 */
import type { BashView } from './bash-view.ts';
import { emptyBashFiles } from './bash-view.ts';
import type { FoldedHeredoc } from './bash-format.ts';
import { toRepoRelative } from './display-paths.ts';
import { analyzePowerShell } from './ps-analyze.ts';
import {
  foldHereStrings,
  formatPowerShell,
  liftPowerShellCd,
} from './ps-format.ts';
import { topLevelPieces } from './ps-split.ts';
import { stripLhWrap } from './ps-wrap.ts';
import type { BashParser } from './syntax.ts';

const lineCountOf = (s: string): number => s.split('\n').length;

export function buildPowerShellView(
  parser: BashParser,
  command: string,
  root: string | null | undefined,
): BashView {
  const rel = (s: string): string => toRepoRelative(s, root);
  const rawDisplay = rel(command);
  const rawLineCount = lineCountOf(command);
  const typed = stripLhWrap(parser, command);
  const formatted = formatPowerShell(parser, typed);
  if (!formatted.ok) {
    return {
      ok: false,
      workDir: null,
      script: rel(typed),
      rawDisplay,
      folded: [],
      lineCount: lineCountOf(typed),
      rawLineCount,
      files: emptyBashFiles(),
      firstStatement: null,
    };
  }
  // A partial command (cut at its top-level `;`) is lifted from its first piece and folded piece
  // by piece, numbering the blocks on.
  const pieces = formatted.partial ? topLevelPieces(typed) : [typed];
  const lifted = liftPowerShellCd(parser, pieces[0] ?? typed, formatted.script);
  let script = lifted.script;
  const folded: FoldedHeredoc[] = [];
  for (const piece of pieces) {
    const r = foldHereStrings(parser, piece, script, folded.length + 1);
    script = r.script;
    folded.push(...r.folded);
  }
  const analysis = analyzePowerShell(parser, typed);
  const first = lifted.script.split('\n').find((line) => line.trim() !== '');
  return {
    ok: true,
    workDir: lifted.workDir === null ? null : rel(lifted.workDir),
    script: rel(script),
    rawDisplay,
    folded: folded.map((f) => ({ ...f, head: rel(f.head), body: rel(f.body) })),
    lineCount: lineCountOf(script),
    rawLineCount,
    files: {
      changes: analysis.changes.map(rel),
      reads: analysis.reads.map(rel),
      runs: analysis.runs,
      inline: analysis.inline,
      unresolved: analysis.unresolved,
      deleted: analysis.deleted.map(rel),
    },
    firstStatement: first === undefined ? null : rel(first.trim()),
  };
}
