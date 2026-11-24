/**
 * Same-length masking of the spots where `tree-sitter-powershell` 0.26.6 gives an ERROR node for
 * valid PowerShell (ported from the PoC `docs/pocs/2026-11-22-1443-powershell-format/ps-mask.mjs`).
 *
 * The parser reads the masked text; every consumer prints / analyses slices of the ORIGINAL text by
 * node index (same length → same indexes, see `textOf` in `ps-parse.ts`), so a mask never leaks
 * into the output. Masks are tried only when the plain parse has an error (`withPsTree`), so a
 * command the grammar already reads is never touched. A mask inside a string is harmless: strings
 * stay strings.
 */

export interface PsMask {
  id: string;
  re: RegExp;
  /** Replacement for one match; `group` is the first capture group ('' when the regex has none). */
  to: (match: string, group: string) => string;
}

/** Applied in this order; a replacement whose length differs from its match is skipped. */
export const PS_MASKS: readonly PsMask[] = [
  // numeric multiplier after a digit: `$x/1MB`, `* 2GB` → zeros of the same length
  {
    id: 'num-multiplier',
    re: /(?<=\d)(?:KB|MB|GB|TB|PB)\b/gi,
    to: (m) => '0'.repeat(m.length),
  },
  // bare word starting with `@` that is not a splat (`npm ls @nestjs/core`, `@types/node@26`)
  { id: 'at-word', re: /(?<=[\s,(])@(?=[\w.-]+[/@])/g, to: () => '_' },
  // bare word that starts with a variable and goes on with a path: `$HOME\.claude\x`, `$d/rows`
  {
    id: 'var-path',
    re: /(?<=[\s,(=])\$(?=[\w:]+[\\/][^\s;|)]*)/g,
    to: () => '_',
  },
  // git revision suffix in a bare word: `HEAD^{tree}`
  {
    id: 'caret-brace',
    re: /\^\{(\w*)\}/g,
    to: (_m, word) => '^_' + word + '_',
  },
  // bare word starting with `.` after a comma: `1, .vscode`
  { id: 'comma-dot', re: /(?<=,\s*)\.(?=\w)/g, to: () => '_' },
  // PowerShell 7 `??` and `??=` → `-f` (a binary operator of the same length)
  { id: 'null-coalesce', re: /\?\?(?==?)/g, to: () => '-f' },
  // PowerShell 7 `?.` / `?[` null-conditional member access after a name → a name character
  { id: 'null-cond', re: /(?<=[\w}])\?(?=[.[])/g, to: () => '_' },
  // hashtable followed by `,` in command arguments: `Select-Object @{n='p';e={…}}, Length`
  { id: 'hash-comma', re: /(?<=\})(\s*),/g, to: (_m, ws) => ws + ' ' },
  // bash-style `\"` inside "…" (ssh / wsl / docker arguments): PowerShell closes the string there
  // and glues the next word on; the grammar cannot glue → read it as an escaped quote
  { id: 'bs-quote', re: /\\"/g, to: () => '`"' },
  // PowerShell 7 ternary `c ? a : b` → `c + a + b` (same length, still one expression)
  {
    id: 'ternary',
    re: / \? ([^;\n?]*?) : /g,
    to: (_m, a) => ' + ' + a + ' + ',
  },
];

export interface MaskedSource {
  /** The masked text; always `text.length === src.length`. */
  text: string;
  /** Ids of the masks that changed something, in `PS_MASKS` order. */
  used: string[];
}

/** Applies every mask of `PS_MASKS` to `src`, keeping the length (and so every offset) unchanged. */
export function maskForParse(src: string): MaskedSource {
  let text = src;
  const used: string[] = [];
  for (const m of PS_MASKS) {
    text = text.replace(m.re, (match: string, first: unknown) => {
      // without a capture group the second callback argument is the match offset (a number)
      const rep = m.to(match, typeof first === 'string' ? first : '');
      if (rep.length !== match.length) return match;
      if (!used.includes(m.id)) used.push(m.id);
      return rep;
    });
  }
  return { text, used };
}
