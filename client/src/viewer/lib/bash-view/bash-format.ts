/**
 * Readable layout of a Bash tool command, driven only by the `tree-sitter-bash` syntax tree.
 * Algorithm doc: `docs/knowledgebase/algorithms/bash-command-view.md` (ported from the PoC
 * `docs/pocs/2026-10-22-2035-bash-pretty-format/bash-view.mjs` and `format.mjs`).
 *
 * The output is the original token sequence; only whitespace changes, and only where the grammar
 * allows a newline: between statements, after `&&` `||` `|` `|&` past `WIDTH` columns, inside
 * `do…done`, `then…fi`, `{ … }` and `( … )`. Every other node is copied verbatim, and multi-line
 * verbatim text (heredocs, strings) is never re-indented.
 */
import type { Node } from 'web-tree-sitter';
import { literal } from './bash-analyze';
import { type BashParser, withTree } from './bash-parser';

const WIDTH = 80;
const IND = '  ';
/** Heredoc bodies with more lines than this are folded out of the script. */
export const HEREDOC_INLINE_MAX = 8;

export interface FormattedBash {
  /** false → the command does not parse as bash; `script` is then the source unchanged. */
  ok: boolean;
  script: string;
}

export interface LiftedCd {
  /** The literal target of a leading `cd <literal>`, or null when nothing was lifted. */
  workDir: string | null;
  script: string;
}

export interface FoldedHeredoc {
  /** 1-based block number, as in the `# ▼ block n` marker. */
  n: number;
  /** First line of the statement the heredoc belongs to. */
  head: string;
  /** The heredoc body without its trailing newline. */
  body: string;
  lines: number;
}

export interface FoldedScript {
  script: string;
  folded: FoldedHeredoc[];
}

const hasDesc = (n: Node, type: string): boolean =>
  n.type === type || n.descendantsOfType(type).length > 0;

/** Verbatim source of a node: indent only the first line, never touch the rest (heredocs, strings). */
function verbatim(
  src: string,
  start: number,
  end: number,
  ind: string,
): string[] {
  const [first, ...rest] = src.slice(start, end).split('\n');
  return [ind + first, ...rest];
}

interface Stmt {
  node: Node;
  bg: boolean;
}

/** Statement nodes of a block plus whether each one is followed by `&`. */
function statements(nodes: Node[]): Stmt[] {
  const out: Stmt[] = [];
  for (const c of nodes) {
    if (c.isNamed) out.push({ node: c, bg: false });
    else if (c.type === '&' && out.length) out[out.length - 1].bg = true;
  }
  return out;
}

/**
 * Prints a block of statements, one after another. A statement with a heredoc anywhere inside it
 * (also in a loop, `if`, group, subshell or `$(…)`) is verbatim as a whole (rule 2.6). Two
 * statements never share a heredoc's lines: `tree-sitter-bash` reads `;`, `&` or a next statement
 * after a heredoc start on its line as a syntax error (`ok: false`), and `&&` / `|` there as part
 * of the heredoc redirect, i.e. of the same statement.
 */
function printSeq(src: string, nodes: Node[], ind: string): string[] {
  const lines: string[] = [];
  for (const { node, bg } of statements(nodes)) {
    const out = hasDesc(node, 'heredoc_redirect')
      ? verbatim(src, node.startIndex, node.endIndex, ind)
      : printStmt(src, node, ind);
    if (bg) out[out.length - 1] += ' &';
    lines.push(...out);
  }
  return lines;
}

const oneLine = (n: Node): string | null =>
  n.text.includes('\n') ? null : n.text;

/** Operands and operators of a left-nested `list` / `pipeline`. */
function chain(node: Node, type: string): Node[] {
  const parts: Node[] = [];
  for (const c of node.children) {
    if (c.type === type && c.isNamed) parts.push(...chain(c, type));
    else parts.push(c);
  }
  return parts;
}

const CHAIN_OPS = new Set(['&&', '||', '|', '|&']);

function printChain(src: string, node: Node, ind: string): string[] {
  const flat = oneLine(node);
  if (flat !== null && ind.length + flat.length <= WIDTH) return [ind + flat];
  const parts = chain(node, node.type);
  if (
    parts.some((p) => !p.isNamed && !CHAIN_OPS.has(p.type)) ||
    parts.some((p) => p.type === 'comment')
  ) {
    return verbatim(src, node.startIndex, node.endIndex, ind);
  }
  const lines: string[] = [];
  let first = true;
  for (const p of parts) {
    if (!p.isNamed) {
      lines[lines.length - 1] += ' ' + p.type;
      continue;
    }
    lines.push(...printStmt(src, p, first ? ind : ind + IND));
    first = false;
  }
  return lines;
}

function printStmt(src: string, node: Node, ind: string): string[] {
  switch (node.type) {
    case 'list':
    case 'pipeline':
      return printChain(src, node, ind);
    case 'redirected_statement': {
      const flat = oneLine(node);
      if (flat !== null && ind.length + flat.length <= WIDTH)
        return [ind + flat];
      const body = node.childForFieldName('body');
      if (!body) return verbatim(src, node.startIndex, node.endIndex, ind);
      const lines = printStmt(src, body, ind);
      const redirects = src.slice(body.endIndex, node.endIndex);
      if (redirects.includes('\n'))
        return verbatim(src, node.startIndex, node.endIndex, ind);
      lines[lines.length - 1] += redirects;
      return lines;
    }
    case 'for_statement':
    case 'while_statement':
      return printLoop(src, node, ind);
    case 'if_statement':
      return printIf(src, node, ind);
    case 'compound_statement':
    case 'subshell': {
      const flat = oneLine(node);
      if (flat !== null && ind.length + flat.length <= WIDTH)
        return [ind + flat];
      const open = node.type === 'subshell' ? '(' : '{';
      const close = node.type === 'subshell' ? ')' : '}';
      const inner = node.children.filter(
        (c) => c.type !== open && c.type !== close,
      );
      return [ind + open, ...printSeq(src, inner, ind + IND), ind + close];
    }
    default:
      return verbatim(src, node.startIndex, node.endIndex, ind);
  }
}

/**
 * `for x in a b c; do … done` and `while|until cond; do … done` (both `while_statement`).
 * A C-style `for ((…))` is a `c_style_for_statement`, which never reaches here: `printStmt`
 * copies it verbatim. A `for x; do` without `in` takes the generic header branch below.
 */
function printLoop(src: string, node: Node, ind: string): string[] {
  const body = node.childForFieldName('body');
  if (!body || body.type !== 'do_group')
    return verbatim(src, node.startIndex, node.endIndex, ind);
  const headerNodes = node.children.filter(
    (c) => c.endIndex <= body.startIndex && c.type !== ';',
  );
  const variable = node.childForFieldName('variable');
  let header: string[];
  if (
    node.type === 'for_statement' &&
    node.children[0]?.type === 'for' &&
    variable &&
    headerNodes.some((c) => c.type === 'in')
  ) {
    const words = node.childrenForFieldName('value').map((v) => v.text);
    if (words.some((w) => w.includes('\n')))
      return verbatim(src, node.startIndex, node.endIndex, ind);
    header = [`${ind}for ${variable.text} in ${words.join(' ')}; do`];
    if (header[0].length > WIDTH && words.length > 2) {
      header = [
        `${ind}for ${variable.text} in \\`,
        ...words.map(
          (w, k) =>
            `${ind}${IND}${IND}${w}${k < words.length - 1 ? ' \\' : '; do'}`,
        ),
      ];
    }
  } else {
    const last = headerNodes.at(-1);
    if (!last) return verbatim(src, node.startIndex, node.endIndex, ind);
    const h = src.slice(node.startIndex, last.endIndex);
    if (h.includes('\n'))
      return verbatim(src, node.startIndex, node.endIndex, ind);
    header = [`${ind}${h}; do`];
  }
  const inner = body.children.filter(
    (c) => c.type !== 'do' && c.type !== 'done',
  );
  return [...header, ...printSeq(src, inner, ind + IND), `${ind}done`];
}

/** if cond; then … [elif cond; then …] [else …] fi */
function printIf(src: string, node: Node, ind: string): string[] {
  const lines: string[] = [];
  const clause = (kw: string, cond: Node[] | null, stmts: Node[]): boolean => {
    if (cond) {
      const c = src.slice(cond[0].startIndex, cond[cond.length - 1].endIndex);
      if (c.includes('\n')) return false;
      lines.push(`${ind}${kw} ${c}; then`);
    } else lines.push(`${ind}${kw}`);
    lines.push(...printSeq(src, stmts, ind + IND));
    return true;
  };
  const split = (children: Node[]): { cond: Node[]; rest: Node[] } => {
    const t = children.findIndex((c) => c.type === 'then');
    const cond = children.slice(1, t).filter((c) => c.isNamed);
    return { cond, rest: children.slice(t + 1) };
  };
  const kids = node.children;
  const firstClauseEnd = kids.findIndex(
    (c) =>
      c.type === 'elif_clause' || c.type === 'else_clause' || c.type === 'fi',
  );
  const { cond, rest } = split(kids.slice(0, firstClauseEnd));
  if (!cond.length || !clause('if', cond, rest))
    return verbatim(src, node.startIndex, node.endIndex, ind);
  for (const c of kids.slice(firstClauseEnd)) {
    if (c.type === 'elif_clause') {
      const e = split(c.children);
      if (!e.cond.length || !clause('elif', e.cond, e.rest))
        return verbatim(src, node.startIndex, node.endIndex, ind);
    } else if (c.type === 'else_clause') {
      clause('else', null, c.children.slice(1));
    }
  }
  lines.push(`${ind}fi`);
  return lines;
}

/** Indented layout of `src`; `ok: false` (and `script === src`) when the command does not parse. */
export function formatBash(parser: BashParser, src: string): FormattedBash {
  return withTree(parser, src, (root) => {
    if (root.hasError) return { ok: false, script: src };
    return { ok: true, script: printSeq(src, root.children, '').join('\n') };
  });
}

/** A leading `cd <literal>` statement of `src` lifted out of `script` into a working-dir header. */
export function liftCd(
  parser: BashParser,
  src: string,
  script: string,
): LiftedCd {
  return withTree(parser, src, (root) => {
    const first = root.namedChildren[0];
    if (!first || first.type !== 'command') return { workDir: null, script };
    const name = first.childForFieldName('name');
    const args = first.childrenForFieldName('argument');
    if (name?.text !== 'cd' || args.length !== 1)
      return { workDir: null, script };
    const dir = literal(args[0], {});
    const lines = script.split('\n');
    // `cd ''` and `cd -` / `cd -P` (flags) name no directory.
    if (
      dir === null ||
      dir === '' ||
      dir.startsWith('-') ||
      lines[0] !== first.text
    )
      return { workDir: null, script };
    return { workDir: dir, script: lines.slice(1).join('\n') };
  });
}

/** Heredoc bodies of `src` longer than `HEREDOC_INLINE_MAX` lines, folded out of `script`. */
export function foldHeredocs(
  parser: BashParser,
  src: string,
  script: string,
): FoldedScript {
  return withTree(parser, src, (root) => {
    const folded: FoldedHeredoc[] = [];
    let out = script;
    for (const b of root.descendantsOfType('heredoc_body')) {
      const text = b.text;
      const lines = text.replace(/\n$/, '').split('\n');
      if (lines.length <= HEREDOC_INLINE_MAX || !out.includes(text)) continue;
      const stmt = b.parent?.parent ?? b;
      const n = folded.length + 1;
      folded.push({
        n,
        head: stmt.text.split('\n')[0],
        body: lines.join('\n'),
        lines: lines.length,
      });
      const at = out.indexOf(text);
      out = `${out.slice(0, at)}# ▼ block ${n}: ${lines.length} lines, shown below\n${out.slice(at + text.length)}`;
    }
    return { script: out, folded };
  });
}
