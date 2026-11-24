/**
 * Top-level `;` positions of a PowerShell command, by PowerShell's own lexing rules (not the
 * grammar's): `'…'` with the `''` escape, `"…"` with backtick / `""` escapes and nested `$( … )`
 * code, here-strings, `#` and `<# #>` comments, backtick escapes, `()` `{}` `[]` nesting.
 * Ported from the PoC `docs/pocs/2026-11-22-1443-powershell-format/ps-split.mjs`.
 *
 * Used only when the syntax tree has an error even after masking: each `;`-separated piece is then
 * parsed and formatted on its own (fallback ladder of `formatPowerShell`).
 */

const HERE_OPENER_TAIL = /^[ \t]*\r?\n/;
const COMMENT_START_PREV = /[\s;|({]/;

/** Indexes of the `;` characters at nesting depth 0, outside strings and comments. */
export function topLevelSemicolons(src: string): number[] {
  const semis: number[] = [];
  const n = src.length;
  let i = 0;

  /** Skips a `'…'` string; `''` is an escaped quote. */
  const single = (): void => {
    i++;
    while (i < n) {
      if (src[i] === "'") {
        if (src[i + 1] === "'") {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      i++;
    }
  };

  /** Skips a `"…"` string: backtick escapes, `""`, nested `$( … )` code. */
  const double = (): void => {
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '`') {
        i += 2;
        continue;
      }
      if (c === '"') {
        if (src[i + 1] === '"') {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      if (c === '$' && src[i + 1] === '(') {
        i += 2;
        code(')', false);
        continue;
      }
      i++;
    }
  };

  /** Skips a here-string opened by `@'` / `@"` at `i`, up to its `'@` / `"@` closer line. */
  const here = (q: string): void => {
    const j = src.indexOf('\n' + q + '@', i + 2);
    i = j < 0 ? n : j + 3;
  };

  /**
   * Walks code until `stopAt` closes at depth 0 (or the end); records `;` at depth 0 only when
   * `topLevel` (the outermost walk, not code nested inside a string).
   */
  function code(stopAt: string | null, topLevel: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '`') {
        i += 2;
        continue;
      }
      if (c === "'") {
        single();
        continue;
      }
      if (c === '"') {
        double();
        continue;
      }
      if (
        c === '@' &&
        (src[i + 1] === "'" || src[i + 1] === '"') &&
        HERE_OPENER_TAIL.test(src.slice(i + 2))
      ) {
        here(src[i + 1]);
        continue;
      }
      if (c === '<' && src[i + 1] === '#') {
        const j = src.indexOf('#>', i + 2);
        i = j < 0 ? n : j + 2;
        continue;
      }
      if (c === '#' && (i === 0 || COMMENT_START_PREV.test(src[i - 1]))) {
        const j = src.indexOf('\n', i);
        i = j < 0 ? n : j;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') {
        depth++;
        i++;
        continue;
      }
      if (c === ')' || c === '}' || c === ']') {
        if (depth === 0 && stopAt === c) {
          i++;
          return;
        }
        depth = Math.max(0, depth - 1);
        i++;
        continue;
      }
      if (c === ';' && depth === 0 && topLevel) semis.push(i);
      i++;
    }
  }

  code(null, true);
  return semis;
}

/**
 * The non-empty pieces of `src` between its top-level `;` (`topLevelSemicolons`), each without
 * leading blanks and without trailing blanks — except a backtick-escaped one (a line
 * continuation). Empty when `src` has no top-level `;`. The fallback ladder of the format and the
 * analysis both cut a command this way.
 */
export function topLevelPieces(src: string): string[] {
  const semis = topLevelSemicolons(src);
  if (!semis.length) return [];
  const bounds = [-1, ...semis, src.length];
  const pieces: string[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const raw = src.slice(bounds[k] + 1, bounds[k + 1]);
    const piece = raw.trimStart().replace(/(?<!`)\s+$/, '');
    if (piece) pieces.push(piece);
  }
  return pieces;
}
