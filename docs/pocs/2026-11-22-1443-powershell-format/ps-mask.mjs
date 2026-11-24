// Same-length masking of the spots where tree-sitter-powershell 0.26.6 gives an ERROR node for
// valid PowerShell. The parser reads the masked text; every consumer prints / analyses slices of the
// ORIGINAL text by node index (same length → same indexes), so the mask never leaks into the output.
//
// Masks are tried only when the plain parse has an ERROR (see parseSrc), so a command the grammar
// already reads is never touched. A mask inside a string is harmless: strings stay strings.
export const MASKS = [
  // G1 numeric multiplier after an operator: `$x/1MB`, `* 2GB` → digits of the same length
  { id: 'num-multiplier', re: /(?<=\d)(?:KB|MB|GB|TB|PB)\b/gi, to: (m) => '0'.repeat(m.length) },
  // G2 bare word starting with `@` that is not a splat (`npm ls @nestjs/core`, `@types/node@26`)
  { id: 'at-word', re: /(?<=[\s,(])@(?=[\w.-]+[/@])/g, to: () => '_' },
  // G3 bare word that starts with a variable and goes on with a path: `$HOME\.claude\x`, `$d/rows`
  { id: 'var-path', re: /(?<=[\s,(=])\$(?=[\w:]+[\\/][^\s;|)]*)/g, to: () => '_' },
  // G4 git revision suffix in a bare word: `HEAD^{tree}`
  { id: 'caret-brace', re: /\^\{(\w*)\}/g, to: (m) => '^_' + m.slice(2, -1) + '_' },
  // G5 bare word starting with `.` after a comma: `1, .vscode`
  { id: 'comma-dot', re: /(?<=,\s*)\.(?=\w)/g, to: () => '_' },
  // G6 PowerShell 7: `??` and `??=` → `-f` (a binary operator of the same length)
  { id: 'null-coalesce', re: /\?\?(?==?)/g, to: () => '-f' },
  // G7 PowerShell 7: `?.` / `?[` null-conditional member access after a name → name char
  { id: 'null-cond', re: /(?<=[\w}])\?(?=[.[])/g, to: () => '_' },
  // G8 PowerShell 7 ternary `c ? a : b` → `c + a + b` (same length, still one expression)
  // G9 hashtable followed by `,` in command arguments: `Select-Object @{n='p';e={…}}, Length`
  { id: 'hash-comma', re: /(?<=\})(\s*),/g, to: (m, ws) => ws + ' ' },
  // G10 bash-style `\"` inside "…" (ssh / wsl / docker arguments): PowerShell closes the string
  // there and glues the next word on; the grammar cannot glue → read it as an escaped quote
  { id: 'bs-quote', re: /\\"/g, to: () => '`"' },
  { id: 'ternary', re: / \? ([^;\n?]*?) : /g, to: (m, a) => ' + ' + a + ' + ' },
];

/** Returns { text, used: [rule ids] }; text.length === src.length always. */
export function maskForParse(src) {
  let text = src;
  const used = new Set();
  for (const m of MASKS) {
    text = text.replace(m.re, (...args) => {
      const match = args[0];
      const rep = m.to(...args);
      if (rep.length !== match.length) return match;
      used.add(m.id);
      return rep;
    });
  }
  return { text, used: [...used] };
}
