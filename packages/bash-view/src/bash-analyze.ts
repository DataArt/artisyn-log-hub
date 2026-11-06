/**
 * Best-effort "which files did this command touch" summary of a Bash tool command. The structure
 * (commands, arguments, redirects, loops, subshells) comes from `tree-sitter-bash` syntax-tree
 * nodes; text patterns are used only on the literal values of single words (command tables,
 * backslash escapes, absolute-path and ignored-target checks). Nothing is executed.
 * Algorithm doc: `docs/knowledgebase/algorithms/bash-command-view.md` (ported from the PoC
 * `docs/pocs/2026-10-22-2035-bash-pretty-format/bash-view.mjs`).
 *
 * - redirects `>` `>>` `&>` `>&` → changes, `<` → reads;
 * - command name + literal arguments against the tables below; every other command → runs;
 * - literal `VAR=…` assignments and `for x in <literal words>` values are substituted, `cd` is
 *   tracked outside pipelines, subshells and `&` background statements get a copy; non-literal
 *   arguments count as unresolved;
 * - inline interpreter scripts (`node -e`, heredoc into `python`, …) are only noted, never analysed.
 */
import {
  type BashParser,
  type BashSyntaxNode as Node,
  withTree,
} from './syntax.ts';

/** A file list longer than this is shown grouped by directory (`groupByDir`). */
export const GROUP_BY_DIR_ABOVE = 3;

const W_CMDS = new Set([
  'rm',
  'mkdir',
  'touch',
  'tee',
  'chmod',
  'rmdir',
  'truncate',
]);
const R_CMDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'wc',
  'cut',
  'ls',
  'stat',
  'diff',
  'sort',
  'uniq',
  'file',
  'nl',
  'tac',
  'md5sum',
  'sha256sum',
]);
const SCRIPT_CMDS =
  /^(python3?|node|bun|deno|bash|sh|zsh|pwsh|powershell|ruby|perl|psql|sqlite3|tsx|ts-node)$/;
const NOT_RUNS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  'sleep',
  'break',
  'continue',
  'exit',
  'set',
  'test',
  'seq',
  'read',
  'return',
  'shift',
  'wait',
  ':',
]);
const SUBCOMMAND_TOOLS =
  /^(npm|npx|pnpm|yarn|git|docker|bunx|gh|dotnet|mvn|gradle|cargo|go)$/;
const RUN_SCRIPT_TOOLS = /^(npm|pnpm|yarn|bun)$/;
/** At most this many literal `for` values are walked through the loop body. */
const FOR_VALUES_MAX = 30;
/** Command base names whose read paths are searched (`readAccess` kind `grep`). */
const GREP_CMDS = /^(grep|rg|ag|egrep|fgrep)$/;
/** Command base names whose read paths are listed (`readAccess` kind `list`). */
const LIST_CMDS = /^(ls|find|tree|dir)$/;

/** How a command reached a read path: its content, a search through it, or a directory listing. */
export type BashReadKind = 'read' | 'grep' | 'list';

/** A line range of a read: 1-based, `to` inclusive; `to: null` = to the end; a negative `from` counts from the end. */
export interface BashReadRange {
  from: number;
  to: number | null;
}

export interface BashReadAccess {
  path: string;
  kind: BashReadKind;
  /** Line range of a `sed -n 'a,bp'` / `head -n N` / `tail -n N` read; only when known. */
  range?: BashReadRange;
  /** Search pattern of a `grep`-kind read (first non-option argument or the `-e` value); only when known. */
  pattern?: string;
}

/** The optional extras of one read access, taken from the first command that read the path. */
type ReadMeta = Pick<BashReadAccess, 'range' | 'pattern'>;

/** Positive integer of a literal argument, or null. */
const posInt = (s: string | null | undefined): number | null =>
  s !== null && s !== undefined && /^\d+$/.test(s) ? Number(s) : null;

/**
 * `head` / `tail` line count: `-n N`, `-nN`, `--lines=N`, `--lines N` or `-N`. For `tail` a `+N`
 * count means "from line N". Null when absent or not a plain number (`-n -5`, `-c 10`).
 */
function headTailRange(
  base: 'head' | 'tail',
  args: (string | null)[],
): BashReadRange | null {
  let count: string | null = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === null) continue;
    if (a === '-n' || a === '--lines') count = args[++k] ?? null;
    else if (a.startsWith('--lines=')) count = a.slice('--lines='.length);
    else if (/^-n.+/.test(a)) count = a.slice(2);
    else if (/^-\d+$/.test(a)) count = a.slice(1);
  }
  if (count === null) return null;
  if (base === 'tail' && /^\+\d+$/.test(count)) {
    const from = Number(count.slice(1));
    return { from: Math.max(from, 1), to: null };
  }
  const n = posInt(count);
  if (n === null) return null;
  return base === 'head' ? { from: 1, to: n } : { from: -n, to: null };
}

/** `sed -n` print script `a,bp` / `Np` → its line range, else null. */
function sedPrintRange(script: string | null | undefined): BashReadRange | null {
  if (script === null || script === undefined) return null;
  const m = /^\s*(\d+)(?:\s*,\s*(\d+))?\s*p\s*;?\s*$/.exec(script);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return { from, to };
}

/** Search-command options whose value is the next argument (so it is neither pattern nor path). */
const GREP_VALUE_FLAGS = new Set([
  '-A',
  '-B',
  '-C',
  '-m',
  '--max-count',
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '--include',
  '--exclude',
]);

/**
 * Pattern and path arguments of a search command's arguments (`grep`-like, or `git grep` after
 * the sub-command): the first `-e` / `--regexp` value, else the first positional; the paths are
 * the positionals after the pattern (all positionals when `-e` gave it), and everything after `--`.
 */
function grepArgs(args: (string | null)[]): {
  pattern: string | null;
  paths: (string | null)[];
} {
  let pattern: string | null | undefined;
  let fromFlag = false;
  const pos: (string | null)[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (a === '-e' || a === '--regexp') {
      const v = args[++k] ?? null;
      if (!fromFlag) pattern = v;
      fromFlag = true;
    } else if (a !== null && a.startsWith('--regexp=')) {
      if (!fromFlag) pattern = a.slice('--regexp='.length);
      fromFlag = true;
    } else if (a === '-f' || a === '--file') {
      // Patterns from a file: the pattern is not known, and no positional is the pattern.
      k++;
      if (!fromFlag) pattern = null;
      fromFlag = true;
    } else if (a !== null && GREP_VALUE_FLAGS.has(a)) k++;
    else if (a === null || !a.startsWith('-')) pos.push(a);
  }
  if (!fromFlag) pattern = pos.shift();
  return { pattern: pattern ?? null, paths: pos };
}

/** `readAccess` kind of a read path by the base name of the command that reads it. */
export function readKindOf(base: string): BashReadKind {
  if (GREP_CMDS.test(base)) return 'grep';
  if (LIST_CMDS.test(base)) return 'list';
  return 'read';
}

export interface BashAnalysis {
  /** The first `cd` target (absolute or as written); paths below are relative to it. */
  workDir: string | null;
  changes: string[];
  /** Read paths that are not also in `changes`. */
  reads: string[];
  /**
   * One entry per path of `reads`, in the same order: the kind of the first command that read it
   * (`<` redirects, `sed` and `cp` sources are `read`). The Bash view ignores it.
   */
  readAccess: BashReadAccess[];
  /** Labels such as `npm run build`, `git status`, `jq`. */
  runs: string[];
  /** `inline <cmd> script, N lines — not analysed` notes. */
  inline: string[];
  /** Number of paths / command names skipped because they are not literal. */
  unresolved: number;
}

export type Env = Record<string, string>;

/** Literal value of a word-like node, or null when it depends on anything non-literal. */
export function literal(n: Node, env: Env): string | null {
  switch (n.type) {
    case 'word':
    case 'number':
      return n.text.replace(/\\(.)/g, '$1');
    case 'raw_string':
      return n.text.slice(1, -1);
    case 'string': {
      // Inside "…" bash drops a backslash only before $ ` " \ and a newline (a backslash-newline
      // disappears entirely); before anything else it stays.
      let s = '';
      for (const c of n.namedChildren) {
        const v =
          c.type === 'string_content'
            ? c.text.replace(/\\([$`"\\\n])/g, (_, ch: string) =>
                ch === '\n' ? '' : ch,
              )
            : literal(c, env);
        if (v === null) return null;
        s += v;
      }
      return s;
    }
    case 'simple_expansion':
    case 'expansion': {
      const only = n.namedChildren.length === 1 ? n.namedChildren[0] : null;
      const name = only && only.type === 'variable_name' ? only.text : null;
      return name !== null && Object.hasOwn(env, name) ? env[name] : null;
    }
    case 'concatenation': {
      let s = '';
      for (const c of n.namedChildren) {
        const v = literal(c, env);
        if (v === null) return null;
        s += v;
      }
      return s;
    }
    default:
      return null;
  }
}

const isAbs = (p: string): boolean =>
  /^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith('~');

function joinPath(cwd: string | null, p: string): string {
  const norm = p.replace(/\\/g, '/');
  if (isAbs(norm) || !cwd) return norm;
  const parts = cwd.split('/');
  for (const seg of norm.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

interface WalkState {
  cwd: string | null;
  env: Env;
  inPipe: boolean;
}

interface InlineScript {
  command: string;
  lines: number;
}

export function analyzeBash(parser: BashParser, src: string): BashAnalysis {
  return withTree(parser, src, (rootNode) => analyzeTree(rootNode));
}

function analyzeTree(rootNode: Node): BashAnalysis {
  const found: { workDir: string | null } = { workDir: null };
  const written: string[] = [];
  const read: string[] = [];
  /** `readAccess` kind per read path; the first read wins, like the order of `read`. */
  const readKind = new Map<string, BashReadKind>();
  /** `range` / `pattern` per read path, from the same first read as `readKind`. */
  const readMeta = new Map<string, ReadMeta>();
  const runs: string[] = [];
  const scripts: InlineScript[] = [];
  /** Start offsets of the script commands already noted (rule 5.3). */
  const noted = new Set<number>();
  let unresolved = 0;

  const add = (
    list: string[],
    st: WalkState,
    p: string | null,
    kind: BashReadKind = 'read',
    meta: ReadMeta = {},
  ): void => {
    if (p === null) {
      unresolved++;
      return;
    }
    if (p === '' || p === '-' || /^&?\d+$/.test(p)) return;
    const full = joinPath(st.cwd, p);
    // A device is ignored however it is reached (`/dev/null`, `../dev/null` from `/tmp`).
    if (full.startsWith('/dev/')) return;
    if (!list.includes(full)) list.push(full);
    if (list === read && !readKind.has(full)) {
      readKind.set(full, kind);
      readMeta.set(full, meta);
    }
  };
  const run = (label: string): void => {
    if (!runs.includes(label)) runs.push(label);
  };

  const redirect = (r: Node, st: WalkState): void => {
    const op =
      r.children.find((c) => !c.isNamed && c.type !== 'file_descriptor')
        ?.type ?? '';
    const dest = r.childForFieldName('destination') ?? r.namedChildren.at(-1);
    if (!dest || dest.type === 'file_descriptor') return;
    if (op === '<') add(read, st, literal(dest, st.env));
    // `>& word` writes the file like `&>` unless the word is a number or `-` (fd duplication /
    // close), which `add` ignores.
    else if (/^(>|>>|&>|&>>|>\||>&)$/.test(op))
      add(written, st, literal(dest, st.env));
  };

  const command = (n: Node, st: WalkState, heredocs: string[]): void => {
    const nameNode = n.childForFieldName('name');
    for (const c of n.namedChildren)
      if (c.type === 'file_redirect') redirect(c, st);
    if (!nameNode) return;
    const name = literal(nameNode.namedChildren[0] ?? nameNode, st.env);
    if (name === null) {
      unresolved++;
      return;
    }
    const args = n
      .childrenForFieldName('argument')
      .map((a) => literal(a, st.env));
    const flags = args.filter(
      (a): a is string => a !== null && a.startsWith('-'),
    );
    const pos = args.filter((a) => a === null || !a.startsWith('-'));
    const base = name.replace(/^.*[\\/]/, '');
    if (base === 'cd') {
      if (st.inPipe) return;
      const target = pos[0];
      // `cd ''` and `cd -` (a flag, so no positional) say nothing about where the shell is.
      if (target === null || target === undefined || target === '') {
        st.cwd = null;
        return;
      }
      st.cwd = joinPath(st.cwd, target);
      if (found.workDir === null) found.workDir = st.cwd;
      return;
    }
    if (W_CMDS.has(base)) pos.forEach((p) => add(written, st, p));
    else if (R_CMDS.has(base)) {
      const range =
        base === 'head' || base === 'tail' ? headTailRange(base, args) : null;
      pos
        // `tail -n +5`: the `+N` count is not a path.
        .filter((p) => !(range && p !== null && /^\+\d+$/.test(p)))
        .forEach((p) =>
          add(read, st, p, readKindOf(base), range ? { range } : {}),
        );
    } else if (base === 'grep' || base === 'rg') {
      const g = grepArgs(args);
      const meta: ReadMeta = g.pattern !== null ? { pattern: g.pattern } : {};
      g.paths.forEach((p) => add(read, st, p, 'grep', meta));
    } else if (
      base === 'git' &&
      args[0] === 'grep' &&
      grepArgs(args.slice(1)).paths.length > 0
    ) {
      // `git grep <pattern> <paths>` searches like `grep`; without paths it searches the whole
      // tree and stays a `git grep` run.
      const g = grepArgs(args.slice(1));
      const meta: ReadMeta = g.pattern !== null ? { pattern: g.pattern } : {};
      g.paths.forEach((p) => add(read, st, p, 'grep', meta));
    } else if (base === 'sed') {
      const inPlace = flags.some(
        (f) => /^-i/.test(f) || /^--in-place(=|$)/.test(f),
      );
      // `-e <script>` / `--expression <script>` give the script itself (not a path);
      // `-f <file>` / `--file <file>` give a script file (a read). Either means no positional
      // is the script.
      let scriptGiven = false;
      /** The first `-e` script, when one is given that way. */
      let exprScript: string | null | undefined;
      const files: (string | null)[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '-e' || a === '--expression') {
          scriptGiven = true;
          k++;
          if (exprScript === undefined) exprScript = args[k] ?? null;
        } else if (a === '-f' || a === '--file') {
          scriptGiven = true;
          k++;
          add(read, st, args[k] ?? '');
        } else if (a !== null && a.startsWith('--expression=')) {
          scriptGiven = true;
          if (exprScript === undefined)
            exprScript = a.slice('--expression='.length);
        } else if (a !== null && a.startsWith('--file=')) {
          scriptGiven = true;
          add(read, st, a.slice('--file='.length));
        } else if (a === null || !a.startsWith('-')) files.push(a);
      }
      // `sed -n 'a,bp' file` prints only lines a..b: a ranged read (DD-4).
      const quiet = flags.some(
        (f) => /^-[a-zA-Z]*n/.test(f) || f === '--quiet' || f === '--silent',
      );
      const range =
        quiet && !inPlace
          ? sedPrintRange(scriptGiven ? exprScript : files[0])
          : null;
      files
        .slice(scriptGiven ? 0 : 1)
        .forEach((p) =>
          inPlace
            ? add(written, st, p)
            : add(read, st, p, 'read', range ? { range } : {}),
        );
    } else if (base === 'mv') {
      pos.forEach((p) => add(written, st, p));
    } else if (base === 'cp') {
      pos.slice(0, -1).forEach((p) => add(read, st, p));
      add(written, st, pos.at(-1) ?? '');
    } else if (!NOT_RUNS.has(base)) {
      const sub = args[0] ?? '';
      const label =
        RUN_SCRIPT_TOOLS.test(base) && sub === 'run'
          ? `${base} run ${args[1] ?? '?'}`
          : SUBCOMMAND_TOOLS.test(base) && sub && !sub.startsWith('-')
            ? `${base} ${sub}`
            : base;
      run(label);
    }
    // One note per script as written: a loop body walked once per `for` value notes it once.
    if (SCRIPT_CMDS.test(base) && !noted.has(n.startIndex)) {
      noted.add(n.startIndex);
      for (const h of heredocs)
        scripts.push({ command: base, lines: h.split('\n').length - 1 });
      // The script is the argument right after the first `-e` / `-c` / `--eval`; when it is
      // missing or not literal it counts as 1 line.
      const flagAt = args.findIndex(
        (a) => a === '-e' || a === '-c' || a === '--eval',
      );
      if (flagAt >= 0) {
        const body = args[flagAt + 1];
        scripts.push({
          command: base,
          lines: typeof body === 'string' ? body.split('\n').length : 1,
        });
      }
    }
  };

  const walk = (n: Node, st: WalkState, heredocs: string[] = []): void => {
    switch (n.type) {
      case 'command':
        command(n, st, heredocs);
        return;
      case 'variable_assignment': {
        const name = n.childForFieldName('name')?.text;
        if (!name) return;
        const val = n.childForFieldName('value');
        const v = val ? literal(val, st.env) : '';
        if (v === null) delete st.env[name];
        else st.env[name] = v;
        return;
      }
      case 'redirected_statement':
        redirected(n, st);
        return;
      case 'pipeline':
        for (const c of n.namedChildren)
          walk(c, { ...st, env: { ...st.env }, inPipe: true }, heredocs);
        return;
      case 'subshell':
        walkSeq(n.children, { ...st, env: { ...st.env } });
        return;
      case 'for_statement': {
        const v = n.childForFieldName('variable')?.text;
        const values = n
          .childrenForFieldName('value')
          .map((x) => literal(x, st.env));
        const body = n.childForFieldName('body');
        if (!body) return;
        const known: (string | null)[] =
          v && values.length && values.every((x) => x !== null && !/\s/.test(x))
            ? values.slice(0, FOR_VALUES_MAX)
            : [null];
        for (const val of known) {
          if (v && val !== null) st.env[v] = val;
          else if (v) delete st.env[v];
          walkSeq(body.children, st);
        }
        if (v) delete st.env[v];
        return;
      }
      case 'command_substitution':
      case 'process_substitution':
        return;
      default:
        // A heredoc on a compound statement (`{ … }`, `if`, `while`, `case`) is the stdin of the
        // whole compound, not a script of one inner command: the inner commands get none (5.3).
        walkSeq(n.children, st);
    }
  };

  const pipeCopy = (st: WalkState): WalkState => ({
    ...st,
    env: { ...st.env },
    inPipe: true,
  });

  /**
   * A `redirected_statement` as bash runs it (rules 5.1, 5.5). The grammar hangs the redirects on
   * the whole body, also when the body is a `list` / `pipeline`, where bash binds them to the last
   * command only. And after a heredoc start it puts the rest of the line inside the heredoc
   * redirect: `&&` / `||` as its `operator` + `right`, `|` / `|&` as a nested `pipeline`, whose
   * operand is a whole statement — `cat <<EOF | grep x && rm y` arrives as
   * `cat <<EOF` + pipeline(`| ` list(`grep x`, `rm y`)) but is `(cat | grep x) && rm y`.
   */
  const redirected = (n: Node, st: WalkState): void => {
    const redirects: Node[] = [];
    let seqTail: Node | null = null;
    let pipeTail: Node | null = null;
    for (const c of n.namedChildren) {
      if (c.type === 'file_redirect') redirects.push(c);
      if (c.type !== 'heredoc_redirect') continue;
      for (const r of c.namedChildren) {
        if (r.type === 'file_redirect') redirects.push(r);
        else if (r.type === 'pipeline') pipeTail = r;
      }
      seqTail = c.childForFieldName('right') ?? seqTail;
    }
    const bodies = n.descendantsOfType('heredoc_body').map((b) => b.text);

    // Leading `&&` / `||` operands of the body run first, in this state, with no redirect open.
    let last = n.childForFieldName('body');
    while (last?.type === 'list') {
      const ops = last.namedChildren;
      for (const o of ops.slice(0, -1)) walk(o, st);
      last = ops.at(-1) ?? null;
    }
    // The pipe tail: its first operand's leftmost `&&` / `||` operand continues the pipeline,
    // the other operands run after the whole pipeline.
    const tailElements: Node[] = [];
    const after: Node[] = [];
    if (pipeTail) {
      const [first, ...more] = pipeTail.namedChildren;
      let head: Node | undefined = first;
      while (head?.type === 'list') {
        const ops: Node[] = head.namedChildren;
        after.unshift(...ops.slice(1));
        head = ops[0];
      }
      if (head) tailElements.push(head);
      tailElements.push(...more);
    }
    const inPipe = pipeTail !== null || last?.type === 'pipeline';
    // Earlier elements of a body pipeline do not read the heredoc.
    let target = last;
    if (last?.type === 'pipeline') {
      const els = last.namedChildren;
      for (const e of els.slice(0, -1)) walk(e, pipeCopy(st));
      target = els.at(-1) ?? null;
    }
    // Bash opens the redirect targets before the command runs, with the state of that moment:
    // `cd /x > out.txt` writes ./out.txt, and a loop's `done > "$f"` uses $f from before it.
    for (const r of redirects) redirect(r, st);
    if (target) walk(target, inPipe ? pipeCopy(st) : st, bodies);
    // What follows `|` reads the heredoc command's output, so it gets the heredocs too (5.3).
    for (const e of tailElements) walk(e, pipeCopy(st), bodies);
    for (const a of after) walk(a, st);
    if (seqTail) walk(seqTail, st);
  };

  /**
   * The named children of a node in order. One followed by `&` runs in the background, which
   * bash does in a subshell: it gets a copy of the directory and the variables, like `( … )`.
   */
  const walkSeq = (nodes: Node[], st: WalkState): void => {
    for (const c of nodes) {
      if (!c.isNamed) continue;
      const bg = c.nextSibling?.type === '&';
      walk(c, bg ? { ...st, env: { ...st.env } } : st);
    }
  };

  const st: WalkState = { cwd: null, env: {}, inPipe: false };
  if (!rootNode.hasError) walkSeq(rootNode.children, st);

  const root = found.workDir;
  const rel = (p: string): string => {
    if (!root) return p;
    if (p === root) return '.';
    if (p.startsWith(root + '/')) return p.slice(root.length + 1);
    const up = root.split('/');
    const pp = p.split('/');
    let k = 0;
    while (k < up.length && k < pp.length && up[k] === pp[k]) k++;
    return k >= 2 && up.length - k <= 2
      ? '../'.repeat(up.length - k) + pp.slice(k).join('/')
      : p;
  };

  const reads = read.filter((p) => !written.includes(p));
  return {
    workDir: root,
    changes: written.map(rel),
    reads: reads.map(rel),
    readAccess: reads.map((p) => ({
      path: rel(p),
      kind: readKind.get(p) ?? 'read',
      ...readMeta.get(p),
    })),
    runs,
    inline: scripts.map(
      (s) => `inline ${s.command} script, ${s.lines} lines — not analysed`,
    ),
    unresolved,
  };
}

/** Files of one directory: `dir` ends with `/` (`./` for bare names). */
export interface DirGroup {
  dir: string;
  names: string[];
}

/** Groups paths by their directory, in first-seen order. Used above `GROUP_BY_DIR_ABOVE` paths. */
export function groupByDir(paths: string[]): DirGroup[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const i = p.lastIndexOf('/');
    const dir = i < 0 ? './' : p.slice(0, i + 1);
    const names = groups.get(dir);
    if (names) names.push(p.slice(i + 1));
    else groups.set(dir, [p.slice(i + 1)]);
  }
  return [...groups].map(([dir, names]) => ({ dir, names }));
}

/** The lists of the FILES block. */
export type BashFileListKey = 'changes' | 'reads' | 'runs' | 'inline';

/**
 * How the FILES block shows one list: grouped by directory (the groups) when it is a path list
 * (`changes` / `reads`) with more than `GROUP_BY_DIR_ABOVE` entries, else flat (null). Run labels
 * and inline notes are not paths and are never grouped.
 */
export function displayGroups(
  key: BashFileListKey,
  items: string[],
): DirGroup[] | null {
  return (key === 'changes' || key === 'reads') &&
    items.length > GROUP_BY_DIR_ABOVE
    ? groupByDir(items)
    : null;
}
