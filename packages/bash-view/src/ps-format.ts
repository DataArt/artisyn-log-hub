/**
 * Readable layout of a PowerShell tool command, driven only by the `tree-sitter-powershell` tree.
 * Algorithm doc: `docs/knowledgebase/algorithms/powershell-command-view.md` (ported from the PoC
 * `docs/pocs/2026-11-22-1443-powershell-format/ps-format.mjs`).
 *
 * Like the Bash layout, the output is the original token sequence and only whitespace changes,
 * only where PowerShell allows a newline:
 *   - between statements of a statement list — only where the source already had a `;` or a
 *     newline between them (so an error node is never split off its neighbour);
 *   - after `{` and before `}` of a block whose body is just a statement list (statement blocks of
 *     if / foreach / while / for / do / try / catch / finally / function, and script blocks passed
 *     as command arguments, e.g. `ForEach-Object { … }`);
 *   - after `|`, `&&` and `||` of a pipeline that does not fit `WIDTH`.
 * A node that fits `WIDTH`, a node with an error, and strings are copied verbatim; multi-line
 * verbatim text (here-strings, strings) is never re-indented. All node text is read through
 * `textOf`, so the masks of `withPsTree` never reach the output.
 */
import {
  type FoldedHeredoc,
  type FoldedScript,
  IND,
  type LiftedCd,
  WIDTH,
} from './bash-format.ts';
import { topLevelPieces } from './ps-split.ts';
import { textOf, withPsTree } from './ps-parse.ts';
import type { BashParser, BashSyntaxNode as Node } from './syntax.ts';

/** Here-string bodies with more lines than this are folded out of the script. */
export const HERE_STRING_INLINE_MAX = 8;

export interface FormattedPowerShell {
  /** false → nothing could be parsed; `script` is then the source unchanged. */
  ok: boolean;
  /**
   * true → the whole tree had an error even after masking: the command was cut at its top-level
   * `;` and each piece formatted alone (a piece that still has an error is copied verbatim).
   */
  partial: boolean;
  script: string;
}

const STRINGS = new Set([
  'string_literal',
  'expandable_string_literal',
  'expandable_here_string_literal',
  'verbatim_string_characters',
  'verbatim_here_string_characters',
]);
/** Clauses of an expanded if / try that expand with it even when they fit. */
const CLAUSES = new Set([
  'statement_block',
  'else_clause',
  'elseif_clauses',
  'elseif_clause',
  'catch_clauses',
  'catch_clause',
  'finally_clause',
]);
const BLOCK_BODY = new Set(['statement_list', 'script_block', 'script_block_body']);
const CHAIN = new Set(['|', '&&', '||']);
const CD_NAMES = new Set([
  'set-location',
  'cd',
  'sl',
  'chdir',
  'push-location',
  'pushd',
]);

/** Output buffer that knows the current column. */
class Out {
  text = '';
  put(s: string): void {
    this.text += s;
  }
  /** Newline (dropping trailing blanks of the current line), then `ind`. */
  nl(ind: string): void {
    this.text = this.text.replace(/[ \t]+$/, '') + '\n' + ind;
  }
  col(): number {
    return this.text.length - this.text.lastIndexOf('\n') - 1;
  }
}

const isError = (n: Node): boolean => n.hasError || n.type === 'ERROR';

/** The single top-level statement list of a program, or null. */
const statementList = (root: Node): Node | null =>
  root.namedChildren.find((c) => c.type === 'statement_list') ?? null;

/** Layout printer over one source; `src` is the original text the tree's offsets refer to. */
class Printer {
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private txt(n: Node): string {
    return textOf(this.src, n);
  }

  private fits(n: Node, col: number): boolean {
    const t = this.txt(n);
    return !t.includes('\n') && col + t.length <= WIDTH;
  }

  /** Separator between two statement siblings: true when the source had `;` or a newline there. */
  private separated(a: Node, b: Node, between: Node[]): boolean {
    if (between.some((x) => x.type === 'empty_statement')) return true;
    return this.src.slice(a.endIndex, b.startIndex).includes('\n');
  }

  /** Statements of a statement list, one per line where the source separated them. */
  printList(out: Out, list: Node, ind: string, first: boolean): void {
    let prev: Node | null = null;
    let between: Node[] = [];
    let wrote = !first;
    for (const k of list.children) {
      if (k.type === 'empty_statement') {
        between.push(k);
        continue;
      }
      if (prev) {
        if (this.separated(prev, k, between)) out.nl(ind);
        // not separated in the source (only possible around an error) → copy the gap as-is
        else out.put(this.src.slice(prev.endIndex, k.startIndex));
      } else if (wrote) out.nl(ind);
      this.printStmt(out, k, ind);
      prev = k;
      between = [];
      wrote = true;
    }
  }

  private printStmt(out: Out, node: Node, ind: string): void {
    if (isError(node) || this.fits(node, out.col())) {
      out.put(this.txt(node));
      return;
    }
    this.emit(out, node, ind);
  }

  /** Copies `node`, opening blocks and breaking pipelines where it does not fit. */
  private emit(out: Out, node: Node, ind: string): void {
    const kids = node.children;
    // strings (and the $( … ) inside them) are text: a newline there would change the value
    if (!kids.length || isError(node) || STRINGS.has(node.type)) {
      out.put(this.txt(node));
      return;
    }
    if (!CLAUSES.has(node.type) && this.fits(node, out.col())) {
      out.put(this.txt(node));
      return;
    }
    const src = this.src;
    const isChainHost =
      node.type === 'pipeline_chain' || node.type === 'pipeline';
    let cont = false; // inside a broken pipeline: the next segment goes on a continuation line
    out.put(src.slice(node.startIndex, kids[0].startIndex));
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const next = kids[i + 1];
      const after = kids[i + 2];
      if (i > 0) {
        if (cont) {
          out.nl(ind + IND);
          cont = false;
        } else out.put(src.slice(kids[i - 1].endIndex, k.startIndex));
      }
      // block: `{` BODY `}`
      if (
        k.type === '{' &&
        next &&
        BLOCK_BODY.has(next.type) &&
        after?.type === '}'
      ) {
        out.put('{');
        const inner = ind + IND;
        const list =
          next.type === 'statement_list'
            ? next
            : (next.descendantsOfType('statement_list')[0] ?? null);
        if (list && bodyIsOnlyList(next, list))
          this.printList(out, list, inner, false);
        else {
          out.nl(inner);
          out.put(this.txt(next));
        }
        out.nl(ind);
        out.put('}');
        i += 2;
        continue;
      }
      if (k.type === '{' && next?.type === '}') {
        out.put('{');
        continue;
      }
      // chain operator in a pipeline that does not fit: break after it
      if (isChainHost && !k.isNamed && CHAIN.has(k.type)) {
        out.put(k.type);
        cont = true;
        continue;
      }
      if (k.type === 'pipeline_chain_tail') {
        const op = k.children[0];
        if (op && CHAIN.has(op.type)) {
          out.put(this.txt(k));
          cont = true;
          continue;
        }
      }
      this.emit(out, k, isChainHost && i > 0 ? ind + IND : ind);
    }
    out.put(src.slice(kids[kids.length - 1].endIndex, node.endIndex));
  }
}

/** The body node holds just the statement list (no param block, no named blocks). */
function bodyIsOnlyList(body: Node, list: Node): boolean {
  let n: Node = list;
  while (n !== body) {
    const p = n.parent;
    if (!p) return false;
    if (p.namedChildren.filter((c) => c.type !== 'comment').length !== 1)
      return false;
    n = p;
  }
  return true;
}

/** Formats a command whose (masked) tree has no error; null when it has one. */
function formatClean(parser: BashParser, src: string): string | null {
  return withPsTree(parser, src, (root) => {
    const list = statementList(root);
    if (root.hasError || !list) return null;
    const out = new Out();
    new Printer(src).printList(out, list, '', true);
    const lead = src.slice(0, list.startIndex);
    const trail = src.slice(list.endIndex);
    return (lead.trim() ? lead : '') + out.text + (trail.trim() ? trail : '');
  });
}

/**
 * Indented layout of `src`. Whole tree first; when it has an error even after masking, the
 * command is cut at its top-level `;` (`topLevelSemicolons`) and each trimmed piece is formatted
 * alone — a piece that still has an error is copied verbatim — joined by newlines
 * (`partial: true`). `ok: false` (and `script === src`) when there is no `;` or no piece parses.
 */
export function formatPowerShell(
  parser: BashParser,
  src: string,
): FormattedPowerShell {
  const whole = formatClean(parser, src);
  if (whole !== null) return { ok: true, partial: false, script: whole };
  const pieces = topLevelPieces(src);
  if (!pieces.length) return { ok: false, partial: false, script: src };
  const lines: string[] = [];
  let parsed = 0;
  for (const piece of pieces) {
    const f = formatClean(parser, piece);
    if (f !== null) parsed++;
    lines.push(f ?? piece);
  }
  if (!parsed) return { ok: false, partial: false, script: src };
  return { ok: true, partial: true, script: lines.join('\n') };
}

/**
 * Literal value of a command argument node of `src`, or null when it is built from a variable,
 * a subexpression or an escape.
 */
export function psLiteral(src: string, arg: Node): string | null {
  let n = arg;
  // a quoted argument comes wrapped: array_literal_expression > unary_expression > string_literal
  while (
    (n.type === 'array_literal_expression' || n.type === 'unary_expression') &&
    n.namedChildren.length === 1
  )
    n = n.namedChildren[0];
  const t = textOf(src, n);
  if (n.type === 'generic_token') return /[$`(]/.test(t) || t.startsWith('@') ? null : t;
  const s = n.type === 'string_literal' ? (n.namedChildren[0] ?? null) : n;
  if (!s) return null;
  if (s.type === 'verbatim_string_characters')
    return t.slice(1, -1).replace(/''/g, "'");
  if (s.type === 'expandable_string_literal')
    return /[$`]/.test(t.slice(1, -1)) ? null : t.slice(1, -1);
  return null;
}

/**
 * A leading `Set-Location` / `cd` / `sl` / `chdir` / `Push-Location` / `pushd` with one literal
 * argument (bare, or after `-Path` / `-LiteralPath`) lifted out of `script` into a working-dir
 * header. Not lifted: `-` / `+` (location history), a non-literal argument, or a first formatted
 * line that is not exactly the statement's text.
 */
export function liftPowerShellCd(
  parser: BashParser,
  src: string,
  script: string,
): LiftedCd {
  return withPsTree(parser, src, (root) => {
    const none: LiftedCd = { workDir: null, script };
    const first = statementList(root)?.namedChildren[0];
    if (!first) return none;
    const inner =
      first.type === 'pipeline' && first.namedChildren.length === 1
        ? first.namedChildren[0]
        : null;
    const c =
      inner?.type === 'pipeline_chain' && inner.namedChildren.length === 1
        ? inner.namedChildren[0]
        : inner;
    if (!c || c.type !== 'command' || c.hasError) return none;
    const name = c.childForFieldName('command_name');
    if (!name || !CD_NAMES.has(textOf(src, name).toLowerCase())) return none;
    const els =
      c
        .childForFieldName('command_elements')
        ?.namedChildren.filter((e) => e.type !== 'command_argument_sep') ?? [];
    let arg: Node | null = null;
    if (els.length === 1) arg = els[0];
    else if (
      els.length === 2 &&
      /^-(path|literalpath|lp|p)$/i.test(textOf(src, els[0]))
    )
      arg = els[1];
    const dir = arg ? psLiteral(src, arg) : null;
    const lines = script.split('\n');
    if (
      !dir ||
      dir === '-' ||
      dir === '+' ||
      lines[0] !== textOf(src, first)
    )
      return none;
    return { workDir: dir, script: lines.slice(1).join('\n') };
  });
}

/** The statement `n` belongs to: its nearest ancestor that sits directly in a statement list. */
function enclosingStatement(n: Node): Node {
  let cur: Node = n;
  while (cur.parent && cur.parent.type !== 'statement_list') cur = cur.parent;
  return cur.parent ? cur : n;
}

/**
 * Here-string bodies of `src` with more than `HERE_STRING_INLINE_MAX` lines, folded out of
 * `script`: the opener line (`@'` / `@"`) and the closer line stay, the body becomes a
 * `# ▼ block <n>: <lines> lines, shown below` marker. Blocks are numbered from `firstBlock`
 * (a partial command is folded piece by piece, continuing the numbering).
 */
export function foldHereStrings(
  parser: BashParser,
  src: string,
  script: string,
  firstBlock = 1,
): FoldedScript {
  return withPsTree(parser, src, (root) => {
    const folded: FoldedHeredoc[] = [];
    let out = script;
    const hereStrings = [
      ...root.descendantsOfType('verbatim_here_string_characters'),
      ...root.descendantsOfType('expandable_here_string_literal'),
    ].sort((a, b) => a.startIndex - b.startIndex);
    for (const h of hereStrings) {
      const text = textOf(src, h);
      const all = text.split('\n');
      const body = all.slice(1, -1);
      if (body.length <= HERE_STRING_INLINE_MAX || !out.includes(text)) continue;
      const n = folded.length + firstBlock;
      folded.push({
        n,
        head: textOf(src, enclosingStatement(h)).split('\n')[0],
        body: body.join('\n'),
        lines: body.length,
      });
      const at = out.indexOf(text);
      out = `${out.slice(0, at)}${all[0]}\n# ▼ block ${n}: ${body.length} lines, shown below\n${all[all.length - 1]}${out.slice(at + text.length)}`;
    }
    return { script: out, folded };
  });
}
