// Top-level `;` positions of a PowerShell command, by PowerShell's own lexing rules (not the
// grammar's): '…' with '' escape, "…" with ` escape / "" and nested $( … ) code, here-strings,
// # and <# #> comments, backtick escapes, () {} [] nesting. Used only when the syntax tree has an
// ERROR even after masking: each `;`-separated piece is then parsed and formatted on its own.

/** Returns indexes of `;` at nesting depth 0 outside strings/comments. */
export function topLevelSemicolons(src) {
  const semis = [];
  let i = 0;
  const n = src.length;

  function code(stopAt, depth0) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '`') { i += 2; continue; }
      if (c === "'" ) { single(); continue; }
      if (c === '"') { double(); continue; }
      if (c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2))) { here(src[i + 1]); continue; }
      if (c === '<' && src[i + 1] === '#') { const j = src.indexOf('#>', i + 2); i = j < 0 ? n : j + 2; continue; }
      if (c === '#' && (i === 0 || /[\s;|({]/.test(src[i - 1]))) { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
      if (c === '(' || c === '{' || c === '[') { depth++; i++; continue; }
      if (c === ')' || c === '}' || c === ']') {
        if (depth === 0 && stopAt === c) { i++; return; }
        depth = Math.max(0, depth - 1); i++; continue;
      }
      if (c === ';' && depth === 0 && depth0) semis.push(i);
      i++;
    }
  }
  function single() { i++; while (i < n) { if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue; } i++; return; } i++; } }
  function double() {
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '`') { i += 2; continue; }
      if (c === '"') { if (src[i + 1] === '"') { i += 2; continue; } i++; return; }
      if (c === '$' && src[i + 1] === '(') { i += 2; code(')', false); continue; }
      i++;
    }
  }
  function here(q) { const j = src.indexOf('\n' + q + '@', i + 2); i = j < 0 ? n : j + 3; }

  code(null, true);
  return semis;
}
