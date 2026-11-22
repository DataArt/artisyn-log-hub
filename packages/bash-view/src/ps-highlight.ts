/**
 * Syntax highlighting of a PowerShell command from the `tree-sitter-powershell` tree — the
 * grammar's own `queries/highlights.scm` plus three captures of ours, through the `Query` API,
 * never regexes. Algorithm doc: `docs/knowledgebase/algorithms/powershell-command-view.md`.
 *
 * When the plain text has a syntax error but its same-length masked copy (`ps-mask.ts`) parses
 * clean, the captures are taken from the masked copy: offsets are identical, and only offsets are
 * used, so masked characters never reach the screen.
 */
import {
  type HighlightKind,
  type HighlightSegment,
  paintCaptures,
} from './bash-highlight.ts';
import { maskForParse } from './ps-mask.ts';
import type { BashParser } from './syntax.ts';

/**
 * The highlight query of the PowerShell view: the grammar's `queries/highlights.scm` plus
 * parameters as `@flag`, `redirection` nodes as `@redirect`, and an unspaced redirect such as
 * `2>$null` (which the grammar gives as a `generic_token`) as `@redirect`.
 */
export function powershellHighlightQuery(grammarHighlightsScm: string): string {
  return (
    grammarHighlightsScm +
    '\n(command_parameter) @flag\n(redirection) @redirect\n((generic_token) @redirect (#match? @redirect "^[0-9*]?>"))\n'
  );
}

/** Highlight-query capture name → our kind. Captures not listed here stay plain. */
export const PS_CAPTURE_KIND: Readonly<Record<string, HighlightKind>> = {
  keyword: 'keyword',
  operator: 'keyword',
  string: 'string',
  variable: 'variable',
  function: 'command',
  comment: 'comment',
  flag: 'flag',
  redirect: 'redirect',
};

/** True when `text` parses without a syntax error. */
function parsesClean(parser: BashParser, text: string): boolean {
  const tree = parser.parse(text);
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

/**
 * Sorted, non-overlapping segments of `text` (see `highlightWith`), from the plain text, or from
 * its masked copy when only that one parses clean.
 */
export function highlightPowerShell(
  parser: BashParser,
  text: string,
  querySource: string,
): HighlightSegment[] {
  if (!text) return [];
  let source = text;
  if (!parsesClean(parser, text)) {
    const masked = maskForParse(text);
    if (masked.used.length && parsesClean(parser, masked.text))
      source = masked.text;
  }
  return paintCaptures(
    text,
    parser.highlight(source, querySource),
    PS_CAPTURE_KIND,
  );
}
