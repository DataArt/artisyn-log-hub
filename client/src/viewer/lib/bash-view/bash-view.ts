/**
 * Everything the Bash command view shows for one command, derived from the bash syntax tree:
 * the formatted script (lifted `cd`, folded heredocs), the file summary and the list preview.
 * Algorithm doc: `docs/knowledgebase/algorithms/bash-command-view.md`.
 *
 * Display strings are made repo-relative (`toRepoRelative`); "Copy original" must use the call's
 * own `input.command`, never anything from here.
 */
import { analyzeBash } from './bash-analyze';
import {
  type FoldedHeredoc,
  foldHeredocs,
  formatBash,
  liftCd,
} from './bash-format';
import type { BashParser } from './bash-parser';
import { toRepoRelative } from './display-paths';

export interface BashFiles {
  changes: string[];
  reads: string[];
  runs: string[];
  /** `inline <cmd> script, N lines — not analysed` notes. */
  inline: string[];
  unresolved: number;
}

export interface BashView {
  /** false → unparseable: show `rawDisplay` as is, no toggle, no FILES, no highlighting. */
  ok: boolean;
  /** Lifted leading `cd` target (repo-relative), or null. */
  workDir: string | null;
  /** Formatted script after the `cd` lift, folded heredocs replaced by markers; `rawDisplay` when !ok. */
  script: string;
  /** The original command, repo-relative. */
  rawDisplay: string;
  folded: FoldedHeredoc[];
  /** Lines of `script`. */
  lineCount: number;
  /** Lines of the original command. */
  rawLineCount: number;
  files: BashFiles;
  /** First formatted statement line after the lifted `cd` (list preview), or null. */
  firstStatement: string | null;
}

const lineCountOf = (s: string): number => s.split('\n').length;

export function buildBashView(
  parser: BashParser,
  command: string,
  root: string | null | undefined,
): BashView {
  const rel = (s: string): string => toRepoRelative(s, root);
  const rawDisplay = rel(command);
  const rawLineCount = lineCountOf(command);
  const formatted = formatBash(parser, command);
  if (!formatted.ok) {
    return {
      ok: false,
      workDir: null,
      script: rawDisplay,
      rawDisplay,
      folded: [],
      lineCount: rawLineCount,
      rawLineCount,
      files: { changes: [], reads: [], runs: [], inline: [], unresolved: 0 },
      firstStatement: null,
    };
  }
  const lifted = liftCd(parser, command, formatted.script);
  const { script, folded } = foldHeredocs(parser, command, lifted.script);
  const analysis = analyzeBash(parser, command);
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
    },
    firstStatement: first === undefined ? null : rel(first.trim()),
  };
}
