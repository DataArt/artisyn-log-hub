/**
 * Syntax highlighting of a Bash command from the same `tree-sitter-bash` syntax tree — the
 * grammar's own `queries/highlights.scm` (plus `(file_redirect) @redirect`) through the `Query`
 * API, never regexes. Algorithm doc: `docs/knowledgebase/algorithms/bash-command-view.md`.
 */
import type { BashCapture, BashParser } from './syntax.ts';

export type HighlightKind =
  | 'keyword'
  | 'redirect'
  | 'string'
  | 'variable'
  | 'command'
  | 'flag'
  | 'comment';

/** A coloured range of the highlighted text (UTF-16 offsets, `end` exclusive). */
export interface HighlightSegment {
  start: number;
  end: number;
  kind: HighlightKind;
}

/**
 * The highlight query of the Bash view: the grammar's own `queries/highlights.scm` text plus one
 * capture of ours — whole `file_redirect` nodes as `@redirect`, so a redirect target is coloured
 * like its operator. Shared by the browser entry (`browser-parser.ts`) and the algorithm test.
 */
export function bashHighlightQuery(grammarHighlightsScm: string): string {
  return `${grammarHighlightsScm}\n(file_redirect) @redirect`;
}

/** Highlight-query capture name → our kind. Captures not listed here stay plain. */
const CAPTURE_KIND: Record<string, HighlightKind> = {
  keyword: 'keyword',
  operator: 'keyword',
  redirect: 'redirect',
  number: 'redirect',
  string: 'string',
  property: 'variable',
  embedded: 'variable',
  function: 'command',
  constant: 'flag',
  comment: 'comment',
};

/** Tailwind classes per kind (light theme). */
export const HIGHLIGHT_CLASS: Record<HighlightKind, string> = {
  keyword: 'text-purple-700',
  redirect: 'text-orange-700',
  string: 'text-green-700',
  variable: 'text-sky-700',
  command: 'text-blue-700 font-medium',
  flag: 'text-slate-600',
  comment: 'text-slate-400 italic',
};

/**
 * Sorted, non-overlapping segments of `text`; plain text is omitted. Overlapping captures are
 * painted from the largest node to the smallest, so inner captures win.
 */
export function highlightBash(
  parser: BashParser,
  text: string,
  querySource: string,
): HighlightSegment[] {
  return highlightWith(parser, text, querySource, CAPTURE_KIND);
}

/**
 * Sorted, non-overlapping segments of `text` for any grammar: the captures of `querySource`
 * mapped through `kindMap` (captures not in it stay plain), painted from the largest node to the
 * smallest, so inner captures win; plain text is omitted.
 */
export function highlightWith(
  parser: BashParser,
  text: string,
  querySource: string,
  kindMap: Readonly<Record<string, HighlightKind>>,
): HighlightSegment[] {
  if (!text) return [];
  return paintCaptures(text, parser.highlight(text, querySource), kindMap);
}

/**
 * Segments of `text` from captures already computed (the painting rule of `highlightWith`).
 * `highlightPowerShell` uses it for captures taken from a same-length masked copy of `text`.
 */
export function paintCaptures(
  text: string,
  raw: readonly BashCapture[],
  kindMap: Readonly<Record<string, HighlightKind>>,
): HighlightSegment[] {
  if (!text) return [];
  const captures = raw
    .flatMap((c) => {
      const kind = kindMap[c.name];
      return kind && c.end > c.start
        ? [{ start: c.start, end: Math.min(c.end, text.length), kind }]
        : [];
    })
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const paint: (HighlightKind | undefined)[] = new Array<
    HighlightKind | undefined
  >(text.length);
  for (const c of captures) paint.fill(c.kind, c.start, c.end);

  const segments: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const kind = paint[i];
    let j = i + 1;
    while (j < text.length && paint[j] === kind) j++;
    if (kind) segments.push({ start: i, end: j, kind });
    i = j;
  }
  return segments;
}
