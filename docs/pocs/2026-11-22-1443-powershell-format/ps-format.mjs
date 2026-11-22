// Readable layout of a PowerShell tool command, driven only by the tree-sitter-powershell tree.
//
// Like the Bash view: the output is the original token sequence, only whitespace changes, and only
// where PowerShell allows a newline:
//   - between statements of a statement list (`;` → newline) — but only where the source already
//     had a `;` or a newline between them (so an ERROR node can never be split off its neighbour);
//   - after `{` and before `}` of a block whose body is a statement list (statement blocks of
//     if / foreach / while / for / do / try / catch / finally / function, and script blocks
//     `{ … }` passed as command arguments, e.g. `ForEach-Object { … }`);
//   - after `|` (and, optionally, `&&` / `||`) of a pipeline that does not fit WIDTH.
// A statement that fits WIDTH, a statement containing an ERROR node, and every other node are
// copied verbatim; multi-line verbatim text (here-strings, strings) is never re-indented.

import { maskForParse } from './ps-mask.mjs';
import { topLevelSemicolons } from './ps-split.mjs';

export const WIDTH = 80;
export const IND = '  ';

const STRINGS = new Set(['string_literal', 'expandable_string_literal', 'expandable_here_string_literal', 'verbatim_string_characters', 'verbatim_here_string_characters']);
const CLAUSES = new Set(['statement_block', 'else_clause', 'elseif_clauses', 'elseif_clause', 'catch_clauses', 'catch_clause', 'finally_clause']);
const BLOCK_BODY = new Set(['statement_list', 'script_block', 'script_block_body']);

class Out {
  constructor() { this.text = ''; }
  put(s) { this.text += s; }
  nl(ind) { this.text = this.text.replace(/[ \t]+$/, '') + '\n' + ind; }
  col() { return this.text.length - this.text.lastIndexOf('\n') - 1; }
}

let SRC = '';
/** Node text from the original source (the parser may have read a masked copy). */
export const txt = (n) => SRC.slice(n.startIndex, n.endIndex);
export const setSource = (s) => { SRC = s; };
const oneLine = (n) => (txt(n).includes('\n') ? null : txt(n));
const fits = (n, col) => { const t = oneLine(n); return t !== null && col + t.length <= WIDTH; };

/** Separator between two statement siblings: true when the source had `;` or a newline there. */
function separated(src, a, b, between) {
  if (between.some((x) => x.type === 'empty_statement')) return true;
  return src.slice(a.endIndex, b.startIndex).includes('\n');
}

export function makeFormatter({ breakChainOps = true } = {}) {
  const CHAIN = breakChainOps ? new Set(['|', '&&', '||']) : new Set(['|']);

  function printList(src, out, list, ind, first) {
    // list: a statement_list node (or the program's children)
    const kids = list.children;
    let prev = null;
    let between = [];
    let wrote = !first;
    for (const k of kids) {
      if (k.type === 'empty_statement') { between.push(k); continue; }
      if (prev) {
        if (separated(src, prev, k, between)) {
          out.nl(ind);
          // keep the `;` only when the separator was `;` with a non-statement in between (never here)
        } else {
          // not separated in the source (only possible around an ERROR) → copy the gap as-is
          out.put(src.slice(prev.endIndex, k.startIndex));
        }
      } else if (wrote) out.nl(ind);
      printStmt(src, out, k, ind);
      prev = k;
      between = [];
      wrote = true;
    }
  }

  function printStmt(src, out, node, ind) {
    if (node.hasError || node.type === 'ERROR' || fits(node, out.col())) { out.put(txt(node)); return; }
    emit(src, out, node, ind);
  }

  /** Copies node, opening blocks and breaking pipelines where it does not fit. */
  function emit(src, out, node, ind) {
    // strings (and the $( … ) inside them) are text: a newline there would change the value
    if (!node.childCount || node.hasError || STRINGS.has(node.type)) { out.put(txt(node)); return; }
    // clauses of an expanded if / try (else, elseif, catch, finally) expand with it
    if (!CLAUSES.has(node.type) && fits(node, out.col()) && !txt(node).includes('\n')) { out.put(txt(node)); return; }
    const kids = node.children;
    const isChainHost = node.type === 'pipeline_chain' || node.type === 'pipeline';
    let cont = false; // inside a broken pipeline: following segments go on continuation lines
    out.put(src.slice(node.startIndex, kids[0].startIndex));
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const next = kids[i + 1];
      const after = kids[i + 2];
      if (i > 0) {
        const gap = src.slice(kids[i - 1].endIndex, k.startIndex);
        if (cont) { out.nl(ind + IND); cont = false; }
        else out.put(gap);
      }
      // block: `{` BODY `}`
      if (k.type === '{' && next && BLOCK_BODY.has(next.type) && after?.type === '}') {
        out.put('{');
        const inner = ind + IND;
        const list = next.type === 'statement_list' ? next : (next.descendantsOfType('statement_list')[0] ?? null);
        if (list && list.parent && bodyIsOnlyList(next, list)) printList(src, out, list, inner, false);
        else { out.nl(inner); out.put(txt(next)); }
        out.nl(ind);
        out.put('}');
        i += 2;
        continue;
      }
      if (k.type === '{' && next?.type === '}') { out.put('{'); continue; }
      // chain operator in a pipeline that does not fit: break after it
      if (isChainHost && !k.isNamed && CHAIN.has(k.type)) { out.put(k.type); cont = true; continue; }
      if (k.type === 'pipeline_chain_tail') {
        const op = k.children[0];
        if (op && CHAIN.has(op.type)) { out.put(txt(k)); cont = true; continue; }
      }
      emit(src, out, k, isChainHost && i > 0 ? ind + IND : ind);
    }
    out.put(src.slice(kids[kids.length - 1].endIndex, node.endIndex));
  }

  /** The body node holds just the statement list (no param block, no named blocks). */
  function bodyIsOnlyList(body, list) {
    if (body === list) return true;
    let n = list;
    while (n && n !== body) {
      const p = n.parent;
      if (!p) return false;
      if (p.namedChildren.filter((c) => c.type !== 'comment').length !== 1) return false;
      n = p;
    }
    return n === body;
  }

  /** Indented layout; ok:false (script === src) when nothing could be formatted at all. */
  /** Formats a command whose (masked) tree has no ERROR; null when it has one. */
  function formatClean(parser, src) {
    const tree = parseSrc(parser, src);
    try {
      const root = tree.rootNode;
      const list = root.namedChildren.find((c) => c.type === 'statement_list');
      if (root.hasError || !list) return null;
      const out = new Out();
      printList(src, out, list, '', true);
      const lead = src.slice(0, list.startIndex);
      const trail = src.slice(list.endIndex);
      return (lead.trim() ? lead : '') + out.text + (trail.trim() ? trail : '');
    } finally { tree.delete(); }
  }

  /**
   * Whole tree first; when it has an ERROR, the command is cut at its top-level `;` (PowerShell
   * lexing, ps-split.mjs) and each piece is formatted alone — a piece that still has an ERROR is
   * copied verbatim on its own line(s). ok:false (script === src) when no piece parses.
   */
  function format(parser, src) {
    const whole = formatClean(parser, src);
    if (whole !== null) return { ok: true, partial: false, script: whole };
    const semis = topLevelSemicolons(src);
    if (!semis.length) return { ok: false, partial: false, script: src };
    const bounds = [-1, ...semis, src.length];
    const lines = [];
    let parsed = 0;
    for (let k = 0; k + 1 < bounds.length; k++) {
      const raw = src.slice(bounds[k] + 1, bounds[k + 1]);
      const piece = raw.trimStart().replace(/(?<!`)\s+$/, '');
      if (!piece) continue;
      const f = formatClean(parser, piece);
      if (f !== null) parsed++;
      lines.push(f ?? piece);
    }
    if (!parsed) return { ok: false, partial: false, script: src };
    return { ok: true, partial: true, script: lines.join('\n') };
  }
  return { format };
}

/** Leading `Set-Location|cd|sl|Push-Location|pushd <literal>` lifted into a working-dir header. */
export function liftCd(parser, src, script) {
  const tree = parseSrc(parser, src);
  try {
    const list = tree.rootNode.namedChildren.find((c) => c.type === 'statement_list');
    const first = list?.namedChildren[0];
    const cmd = first?.type === 'pipeline' && first.namedChildCount === 1 ? first.namedChildren[0] : null;
    const c = cmd?.type === 'pipeline_chain' && cmd.namedChildCount === 1 ? cmd.namedChildren[0] : cmd;
    if (!c || c.type !== 'command' || c.hasError) return { workDir: null, script };
    const name = c.childForFieldName('command_name'); const nameText = name ? txt(name).toLowerCase() : null;
    if (!['set-location', 'cd', 'sl', 'chdir', 'push-location', 'pushd'].includes(nameText)) return { workDir: null, script };
    const els = c.childForFieldName('command_elements')?.namedChildren.filter((e) => e.type !== 'command_argument_sep') ?? [];
    let arg = null;
    if (els.length === 1) arg = els[0];
    else if (els.length === 2 && /^-(path|literalpath|lp|p)$/i.test(txt(els[0]))) arg = els[1];
    const dir = arg ? literalOf(arg) : null;
    const lines = script.split('\n');
    if (!dir || dir === '-' || dir === '+' || lines[0] !== txt(first)) return { workDir: null, script };
    return { workDir: dir, script: lines.slice(1).join('\n') };
  } finally { tree.delete(); }
}

/** Literal value of an argument node, or null when it is built from a variable / expression. */
export function literalOf(n) {
  const t = txt(n);
  if (n.type === 'generic_token') return /[$`(]/.test(t) || /^@/.test(t) ? null : t;
  const s = n.type === 'string_literal' ? n.namedChildren[0] : n;
  if (!s) return null;
  if (s.type === 'verbatim_string_characters') return t.slice(1, -1).replace(/''/g, "'");
  if (s.type === 'expandable_string_literal') return /[$`]/.test(t.slice(1, -1)) ? null : t.slice(1, -1);
  return null;
}

export const HERE_INLINE_MAX = 8;

/** Here-string bodies over HERE_INLINE_MAX lines folded out of the script, like Bash heredocs. */
export function foldHereStrings(parser, src, script) {
  const tree = parseSrc(parser, src);
  try {
    const folded = [];
    let out = script;
    for (const h of tree.rootNode.descendantsOfType(['verbatim_here_string_characters', 'expandable_here_string_literal'])) {
      const text = txt(h);
      const body = text.split('\n').slice(1, -1);
      if (body.length <= HERE_INLINE_MAX || !out.includes(text)) continue;
      const n = folded.length + 1;
      folded.push({ n, lines: body.length });
      const opener = text.split('\n')[0];
      const closer = text.split('\n').at(-1);
      const at = out.indexOf(text);
      out = `${out.slice(0, at)}${opener}\n# ▼ block ${n}: ${body.length} lines, shown below\n${closer}${out.slice(at + text.length)}`;
    }
    return { script: out, folded };
  } finally { tree.delete(); }
}

let MASKING = true;
export const setMasking = (on) => { MASKING = on; };
/** Parses `src` (masked when MASKING) and makes txt() read slices of the original `src`. */
export const maskStats = {};
export function parseSrc(parser, src) {
  setSource(src);
  const plain = parser.parse(src);
  if (!MASKING || !plain.rootNode.hasError) return plain;
  const { text, used } = maskForParse(src);
  const masked = parser.parse(text);
  if (masked.rootNode.hasError) { masked.delete(); return plain; }
  plain.delete();
  for (const u of used) maskStats[u] = (maskStats[u] || 0) + 1;
  return masked;
}
