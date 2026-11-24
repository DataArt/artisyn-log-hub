/**
 * Best-effort "which files did this command touch" summary of a PowerShell tool command — the
 * same `BashAnalysis` shape as `analyzeBash`. The structure (commands, parameters, arrays,
 * redirects, pipelines, script blocks) comes from the `tree-sitter-powershell` tree; text patterns
 * are used only on literal values. Nothing is executed.
 * Algorithm doc: `docs/knowledgebase/algorithms/powershell-command-view.md` (ported from the PoC
 * `docs/pocs/2026-11-22-1443-powershell-format/ps-analyze.mjs`).
 *
 * - a closed table of file cmdlets (`PS_CMDLETS`, aliases in `PS_ALIASES`) with their positional
 *   order and path parameters; names and parameters are case-insensitive, a parameter may be
 *   abbreviated to a unique prefix;
 * - `>` / `>>` redirects (also unspaced, `>out.txt`) write their target; `$null` and provider
 *   drives (`Env:`, `HKLM:`, …) are never a file;
 * - `$name = <literal>` assignments are substituted, `Set-Location` and its aliases outside a
 *   pipeline set the working dir; commands inside script blocks are analysed;
 * - any other command name goes through the Bash rules for native commands (`analyzeWords`);
 *   `PS_NOT_RUNS` names produce nothing.
 * A command whose tree has an error even after masking is cut at its top-level `;` and the pieces
 * that parse are analysed in order with one shared state; every other piece counts as unresolved.
 */
import {
  type BashAnalysis,
  type BashReadKind,
  type BashReadRange,
  type WordReadMeta,
  analyzeWords,
  joinPath,
  relativeToWorkDir,
} from './bash-analyze.ts';
import { textOf, withPsTree } from './ps-parse.ts';
import { topLevelPieces } from './ps-split.ts';
import type { BashParser, BashSyntaxNode as Node } from './syntax.ts';

/** How one file cmdlet takes its paths. Parameter names are canonical (as documented). */
export interface PsCmdletSpec {
  /** Positional parameters, in binding order. */
  pos: readonly string[];
  /** Parameters whose values are read paths. */
  read?: readonly string[];
  /** Parameters whose values are written paths. */
  write?: readonly string[];
  /** Parameters whose values are removed paths (also changes). */
  del?: readonly string[];
  /** `readAccess` kind of the read paths. */
  kind?: BashReadKind;
  /** Other parameters that take a value. */
  values: readonly string[];
  /** Parameters that take no value (the next element is positional). */
  switches: readonly string[];
  /** The cmdlet is also a run label (`Invoke-WebRequest`). */
  run?: boolean;
}

/** File cmdlets by canonical name. */
export const PS_CMDLETS: Readonly<Record<string, PsCmdletSpec>> = {
  'Get-Content': {
    pos: ['Path'],
    read: ['Path', 'LiteralPath'],
    kind: 'read',
    values: [
      'TotalCount',
      'Tail',
      'Head',
      'First',
      'Last',
      'Encoding',
      'Delimiter',
      'ReadCount',
      'Stream',
      'Filter',
      'Include',
      'Exclude',
    ],
    switches: ['Raw', 'Wait', 'AsByteStream', 'Force'],
  },
  'Select-String': {
    pos: ['Pattern', 'Path'],
    read: ['Path', 'LiteralPath'],
    kind: 'grep',
    values: ['Pattern', 'Context', 'Encoding', 'Include', 'Exclude', 'Culture'],
    switches: [
      'SimpleMatch',
      'CaseSensitive',
      'NotMatch',
      'List',
      'AllMatches',
      'Quiet',
      'Raw',
      'NoEmphasis',
    ],
  },
  'Get-ChildItem': {
    pos: ['Path', 'Filter'],
    read: ['Path', 'LiteralPath'],
    kind: 'list',
    values: ['Filter', 'Include', 'Exclude', 'Depth', 'Attributes'],
    switches: [
      'Recurse',
      'Force',
      'Name',
      'File',
      'Directory',
      'Hidden',
      'ReadOnly',
      'System',
      'FollowSymlink',
    ],
  },
  'Get-Item': {
    pos: ['Path'],
    read: ['Path', 'LiteralPath'],
    kind: 'list',
    values: ['Filter', 'Include', 'Exclude', 'Stream'],
    switches: ['Force'],
  },
  'Test-Path': {
    pos: ['Path'],
    read: ['Path', 'LiteralPath'],
    kind: 'list',
    values: ['Filter', 'Include', 'Exclude', 'PathType', 'OlderThan', 'NewerThan'],
    switches: ['IsValid'],
  },
  'Get-FileHash': {
    pos: ['Path'],
    read: ['Path', 'LiteralPath'],
    kind: 'read',
    values: ['Algorithm'],
    switches: [],
  },
  'Set-Content': {
    pos: ['Path', 'Value'],
    write: ['Path', 'LiteralPath'],
    values: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream'],
    switches: ['NoNewline', 'PassThru', 'Force', 'AsByteStream'],
  },
  'Add-Content': {
    pos: ['Path', 'Value'],
    write: ['Path', 'LiteralPath'],
    values: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream'],
    switches: ['NoNewline', 'PassThru', 'Force', 'AsByteStream'],
  },
  'Clear-Content': {
    pos: ['Path'],
    write: ['Path', 'LiteralPath'],
    values: ['Filter', 'Include', 'Exclude', 'Stream'],
    switches: ['Force'],
  },
  'Out-File': {
    pos: ['FilePath', 'Encoding'],
    write: ['FilePath', 'LiteralPath'],
    values: ['Encoding', 'Width', 'InputObject'],
    switches: ['Append', 'Force', 'NoClobber', 'NoNewline'],
  },
  'Tee-Object': {
    pos: ['FilePath'],
    write: ['FilePath', 'LiteralPath'],
    values: ['Variable', 'InputObject', 'Encoding'],
    switches: ['Append'],
  },
  'New-Item': {
    pos: ['Path'],
    write: ['Path'],
    values: ['ItemType', 'Name', 'Value', 'Target'],
    switches: ['Force'],
  },
  'Remove-Item': {
    pos: ['Path'],
    del: ['Path', 'LiteralPath'],
    values: ['Filter', 'Include', 'Exclude', 'Stream'],
    switches: ['Recurse', 'Force'],
  },
  'Copy-Item': {
    pos: ['Path', 'Destination'],
    read: ['Path', 'LiteralPath'],
    write: ['Destination'],
    kind: 'read',
    values: ['Filter', 'Include', 'Exclude', 'ToSession', 'FromSession'],
    switches: ['Recurse', 'Force', 'PassThru', 'Container'],
  },
  'Move-Item': {
    pos: ['Path', 'Destination'],
    write: ['Path', 'LiteralPath', 'Destination'],
    values: ['Filter', 'Include', 'Exclude'],
    switches: ['Force', 'PassThru'],
  },
  'Rename-Item': {
    pos: ['Path', 'NewName'],
    write: ['Path', 'LiteralPath', 'NewName'],
    values: [],
    switches: ['Force', 'PassThru'],
  },
  'Expand-Archive': {
    pos: ['Path', 'DestinationPath'],
    read: ['Path', 'LiteralPath'],
    write: ['DestinationPath'],
    kind: 'read',
    values: [],
    switches: ['Force', 'PassThru'],
  },
  'Invoke-WebRequest': {
    pos: ['Uri'],
    write: ['OutFile'],
    values: [
      'Uri',
      'Method',
      'Body',
      'Headers',
      'ContentType',
      'TimeoutSec',
      'OutFile',
      'InFile',
      'UserAgent',
      'Proxy',
      'MaximumRedirection',
    ],
    switches: ['UseBasicParsing', 'PassThru', 'SkipCertificateCheck'],
    run: true,
  },
};

/** Alias (lower case) → canonical cmdlet name of `PS_CMDLETS`. */
export const PS_ALIASES: Readonly<Record<string, string>> = {
  gc: 'Get-Content',
  cat: 'Get-Content',
  type: 'Get-Content',
  sls: 'Select-String',
  gci: 'Get-ChildItem',
  ls: 'Get-ChildItem',
  dir: 'Get-ChildItem',
  gi: 'Get-Item',
  sc: 'Set-Content',
  ac: 'Add-Content',
  clc: 'Clear-Content',
  tee: 'Tee-Object',
  ni: 'New-Item',
  mkdir: 'New-Item',
  md: 'New-Item',
  ri: 'Remove-Item',
  rm: 'Remove-Item',
  del: 'Remove-Item',
  erase: 'Remove-Item',
  rd: 'Remove-Item',
  rmdir: 'Remove-Item',
  cpi: 'Copy-Item',
  cp: 'Copy-Item',
  copy: 'Copy-Item',
  mi: 'Move-Item',
  mv: 'Move-Item',
  move: 'Move-Item',
  rni: 'Rename-Item',
  ren: 'Rename-Item',
  iwr: 'Invoke-WebRequest',
  'invoke-restmethod': 'Invoke-WebRequest',
  irm: 'Invoke-WebRequest',
  curl: 'Invoke-WebRequest',
  wget: 'Invoke-WebRequest',
};

/** Command names (lower case) that touch no file and are no run label. */
export const PS_NOT_RUNS: ReadonlySet<string> = new Set([
  'write-host',
  'write-output',
  'echo',
  'write-verbose',
  'write-warning',
  'write-error',
  'start-sleep',
  'sleep',
  'get-date',
  'out-null',
  'out-string',
  'out-host',
  'select-object',
  'select',
  'where-object',
  'where',
  '?',
  'foreach-object',
  'foreach',
  '%',
  'sort-object',
  'sort',
  'group-object',
  'measure-object',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'format-wide',
  'convertto-json',
  'convertfrom-json',
  'join-path',
  'split-path',
  'resolve-path',
  'get-location',
  'pwd',
  'pop-location',
  'popd',
  'new-object',
  'get-command',
  'gcm',
  'exit',
  'return',
  'throw',
]);

/** Value parameters every cmdlet has. */
const COMMON_VALUE = [
  'ErrorAction',
  'WarningAction',
  'InformationAction',
  'ErrorVariable',
  'WarningVariable',
  'InformationVariable',
  'OutVariable',
  'OutBuffer',
  'PipelineVariable',
  'Credential',
];
/** Switches every cmdlet has (`-Confirm:$false` consumes its `:value`). */
const COMMON_SWITCH = ['WhatIf', 'Confirm', 'Verbose', 'Debug'];
const ALWAYS_SWITCH = new Set([...COMMON_SWITCH, 'Force']);
const CD_NAMES = new Set([
  'set-location',
  'cd',
  'sl',
  'chdir',
  'push-location',
  'pushd',
]);
/** `$null` and non-file provider drives — never a file (the counterpart of Bash's `/dev/*`). */
const NOT_A_FILE =
  /^(\$null$|(env|hklm|hkcu|variable|function|alias|cert|wsman):)/i;
/** An unspaced redirect token: operator, optional stream merge, target. */
const REDIRECT_TOKEN = /^([0-9*]?>>?)(&[12])?(.*)$/;
/** `Get-Content` parameters that limit a read to its first / last N lines. */
const HEAD_PARAMS = ['TotalCount', 'Head', 'First'];
const TAIL_PARAMS = ['Tail', 'Last'];

/** Unwraps single-child expression chains down to the argument's own node. */
function unwrap(n0: Node): Node {
  let n = n0;
  while (
    n.namedChildren.length === 1 &&
    /_expression$|^pipeline(_chain)?$/.test(n.type)
  )
    n = n.namedChildren[0];
  return n;
}

type Env = Record<string, string>;

/**
 * Literal value of an argument node with `$name` / `${name}` substituted from `env`, or null when
 * it depends on anything non-literal. `$null` stays `$null` (never a file).
 */
function literalArg(src: string, n0: Node, env: Env): string | null {
  const n = unwrap(n0);
  const t = textOf(src, n);
  const subst = (s: string): string | null => {
    let ok = true;
    const v = s.replace(
      /\$\{([^}]+)\}|\$([A-Za-z_]\w*)(?![:\w(])/g,
      (m, braced: string | undefined, bare: string | undefined) => {
        const k = (braced ?? bare ?? '').toLowerCase();
        if (Object.hasOwn(env, k)) return env[k];
        ok = false;
        return m;
      },
    );
    return ok && !/[$`]/.test(v.replace(/`([^\n])/g, ''))
      ? v.replace(/`(.)/g, '$1')
      : null;
  };
  switch (n.type) {
    case 'generic_token':
      return t.startsWith('@') ? null : subst(t);
    case 'string_literal': {
      const inner = n.namedChildren[0];
      return inner ? literalArg(src, inner, env) : null;
    }
    case 'verbatim_string_characters':
      return t.slice(1, -1).replace(/''/g, "'");
    case 'expandable_string_literal':
      return subst(t.slice(1, -1));
    case 'variable':
      return /^\$null$/i.test(t) ? '$null' : subst(t);
    case 'integer_literal':
    case 'decimal_integer_literal':
      return t;
    default:
      return null;
  }
}

/** One command element after joining: a node, or an array of nodes joined by `,`. */
interface Arg {
  node: Node;
  /** The elements of `a, b, c` (null for a single element). */
  items: Node[] | null;
  /** Attached to the previous element by `:` (`-Confirm:$false`, `-Path:x`). */
  colon: boolean;
}

/** Resolves a (possibly abbreviated) parameter against a cmdlet's names; null when unknown or ambiguous. */
function resolveParam(spec: PsCmdletSpec, raw: string): string | null {
  const p = raw.replace(/^-/, '').replace(/:$/, '').toLowerCase();
  const all = [
    ...new Set([
      ...spec.pos,
      ...(spec.read ?? []),
      ...(spec.write ?? []),
      ...(spec.del ?? []),
      ...spec.values,
      ...spec.switches,
      ...COMMON_VALUE,
      ...COMMON_SWITCH,
    ]),
  ];
  const exact = all.find((x) => x.toLowerCase() === p);
  if (exact) return exact;
  const pref = all.filter((x) => x.toLowerCase().startsWith(p));
  return pref.length === 1 ? pref[0] : null;
}

/** The canonical cmdlet a command base name (lower case) stands for, or null. */
function cmdletOf(base: string): string | null {
  const alias = PS_ALIASES[base];
  if (alias !== undefined) return alias;
  return Object.keys(PS_CMDLETS).find((k) => k.toLowerCase() === base) ?? null;
}

/** Script blocks inside `n` that are not nested in another script block below `n`. */
function outerScriptBlocks(n: Node): Node[] {
  const out: Node[] = [];
  const visit = (x: Node): void => {
    for (const c of x.namedChildren) {
      if (c.type === 'script_block') out.push(c);
      else visit(c);
    }
  };
  visit(n);
  return out;
}

/** Positive integer of a literal, or null. */
const posInt = (s: string | null): number | null =>
  s !== null && /^\d+$/.test(s) ? Number(s) : null;

/** The analysis state shared by every tree (piece) of one command. */
class PsAnalyzer {
  private src = '';
  private cwd: string | null = null;
  private workDir: string | null = null;
  private readonly env: Env = {};
  private readonly written: string[] = [];
  private readonly read: string[] = [];
  private readonly readKind = new Map<string, BashReadKind>();
  private readonly readMeta = new Map<string, WordReadMeta>();
  private readonly removed = new Set<string>();
  private readonly runs: string[] = [];
  private readonly scripts: { command: string; lines: number }[] = [];
  unresolved = 0;

  /** Analyses one parsed tree of `src` (whole command, or one piece of it). */
  walkRoot(root: Node, src: string): void {
    this.src = src;
    this.walk(root, false);
  }

  private txt(n: Node): string {
    return textOf(this.src, n);
  }

  private lit(n: Node): string | null {
    return literalArg(this.src, n, this.env);
  }

  private add(
    list: 'read' | 'write' | 'del',
    p: string | null,
    kind: BashReadKind = 'read',
    meta: WordReadMeta = {},
  ): void {
    if (p === null) {
      this.unresolved++;
      return;
    }
    if (p === '' || p === '-' || NOT_A_FILE.test(p) || /^&?\d+$/.test(p))
      return;
    const full = joinPath(this.cwd, p);
    if (list === 'read') {
      if (!this.read.includes(full)) this.read.push(full);
      if (!this.readKind.has(full)) {
        this.readKind.set(full, kind);
        this.readMeta.set(full, meta);
      }
      return;
    }
    if (!this.written.includes(full)) this.written.push(full);
    if (list === 'del') this.removed.add(full);
  }

  private run(label: string): void {
    if (!this.runs.includes(label)) this.runs.push(label);
  }

  private walk(n: Node, inPipe: boolean): void {
    if (n.type === 'ERROR') return;
    if (n.type === 'command') {
      this.command(n, inPipe);
      for (const b of outerScriptBlocks(n)) this.walk(b, true);
      return;
    }
    if (n.type === 'assignment_expression') {
      const val = n.childForFieldName('value');
      if (val) {
        const left = n.namedChildren[0];
        const m = left
          ? /^\$([A-Za-z_]\w*)$/.exec(this.txt(left).trim())
          : null;
        if (m) {
          const key = m[1].toLowerCase();
          const v = this.lit(val);
          if (v === null) delete this.env[key];
          else this.env[key] = v;
        }
        this.walk(val, inPipe);
        return;
      }
    }
    const pipe =
      n.type === 'pipeline_chain' &&
      n.namedChildren.filter((x) => x.type === 'command').length > 1;
    for (const c of n.namedChildren) this.walk(c, inPipe || pipe);
  }

  /** Command elements: `,`-joined arrays merged, `:`-attached values marked, separators dropped. */
  private elements(c: Node): Arg[] {
    const els: Arg[] = [];
    let joinNext = false;
    let colonNext = false;
    for (const e of c.childForFieldName('command_elements')?.children ?? []) {
      if (e.type === 'command_argument_sep') {
        if (this.txt(e).trim() === ':') colonNext = true;
        continue;
      }
      if (e.type === ',') {
        joinNext = true;
        continue;
      }
      const last = els.at(-1);
      if (joinNext && last) last.items = [...(last.items ?? [last.node]), e];
      else els.push({ node: e, items: null, colon: colonNext });
      joinNext = false;
      colonNext = false;
    }
    return els;
  }

  /** The literal values of one argument (each element of an array). */
  private values(a: Arg | null | undefined): (string | null)[] {
    if (!a) return [];
    if (a.items) return a.items.map((x) => this.lit(x));
    const u = unwrap(a.node);
    if (u.type === 'array_literal_expression' && u.namedChildren.length > 1)
      return u.namedChildren.map((x) => this.lit(x));
    return [this.lit(a.node)];
  }

  private command(c: Node, inPipe: boolean): void {
    const nameNode = c.childForFieldName('command_name');
    if (!nameNode) return;
    // `& node x.js` gives `command_name_expr > command_name`, `& "C:\x\rg.exe"` a string inside it.
    const inner = nameNode.namedChildren[0] ?? nameNode;
    const rawName =
      nameNode.type === 'command_name'
        ? this.txt(nameNode)
        : inner.type === 'command_name'
          ? this.txt(inner)
          : this.lit(inner);
    if (rawName === null) {
      this.unresolved++;
      return;
    }
    const file = rawName.replace(/^.*[\\/]/, '').toLowerCase();
    const base = file.replace(/\.(exe|cmd|bat|ps1)$/, '');
    // An explicit extension names a program file, never an alias (`curl.exe` is curl).
    const native = base !== file;

    // Redirects: `redirection` nodes and unspaced `2>$null` / `>out.txt` tokens.
    const args: Arg[] = [];
    for (const a of this.elements(c)) {
      const e = a.node;
      if (e.type === 'redirection') {
        const op = this.txt(e.namedChildren[0] ?? e);
        const dest = e.namedChildren.find(
          (x) => x.type === 'redirected_file_name',
        );
        if (op.includes('>') && !/&[12]$/.test(op) && dest)
          this.add('write', this.lit(dest.namedChildren.at(-1) ?? dest));
        continue;
      }
      const m =
        e.type === 'generic_token' && !a.items
          ? REDIRECT_TOKEN.exec(this.txt(e))
          : null;
      if (m) {
        const target = m[3];
        if (!m[2] && target)
          this.add(
            'write',
            NOT_A_FILE.test(target)
              ? '$null'
              : /[$`(]/.test(target)
                ? null
                : target,
          );
        continue;
      }
      args.push(a);
    }

    if (!native && CD_NAMES.has(base)) {
      if (inPipe) return;
      const a = args.find((x) => x.node.type !== 'command_parameter');
      const v = a ? this.lit(a.node) : null;
      this.cwd =
        v === null || v === '' || v === '-' || v === '+'
          ? null
          : joinPath(this.cwd, v);
      if (this.workDir === null && this.cwd !== null) this.workDir = this.cwd;
      return;
    }

    const cmdlet = native ? null : cmdletOf(base);
    if (cmdlet !== null) {
      this.cmdlet(cmdlet, args);
      return;
    }
    if (!native && PS_NOT_RUNS.has(base)) return;

    // A native command: its words through the Bash rules.
    const words: (string | null)[] = [];
    for (const a of args) {
      const vals =
        a.node.type === 'command_parameter' && !a.items
          ? [this.txt(a.node)]
          : this.values(a);
      const prev = words.at(-1);
      if (a.colon && typeof prev === 'string' && vals.length === 1) {
        const v = vals[0];
        words[words.length - 1] = v === null ? null : `${prev}:${v}`;
      } else words.push(...vals);
    }
    analyzeWords(base, words, {
      read: (p, kind, meta) => this.add('read', p, kind, meta),
      write: (p) => this.add('write', p),
      del: (p) => this.add('del', p),
      run: (label) => this.run(label),
      script: (command, lines) => this.scripts.push({ command, lines }),
    });
  }

  private cmdlet(name: string, args: Arg[]): void {
    const spec = PS_CMDLETS[name];
    const bound = new Map<string, Arg | null>();
    const pos: Arg[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.node.type !== 'command_parameter' || a.items) {
        pos.push(a);
        continue;
      }
      const raw = this.txt(a.node);
      const p = resolveParam(spec, raw);
      if (p === null) continue;
      if (spec.switches.includes(p) || ALWAYS_SWITCH.has(p)) {
        if (raw.endsWith(':') || args[i + 1]?.colon) i++;
        continue;
      }
      bound.set(p, args[++i] ?? null);
    }
    // Positionals fill the positional parameters not bound by name, in order.
    let k = 0;
    for (const p of spec.pos) {
      if (bound.has(p)) continue;
      if (k < pos.length) bound.set(p, pos[k++]);
    }
    const vals = (p: string): (string | null)[] => this.values(bound.get(p));

    if (name === 'Rename-Item') {
      // Both names change; NewName is a name in Path's folder.
      const from = [...vals('Path'), ...vals('LiteralPath')][0] ?? null;
      const to = vals('NewName')[0] ?? null;
      this.add('write', from);
      this.add(
        'write',
        from === null || to === null ? null : from.replace(/[^\\/]*$/, '') + to,
      );
      return;
    }

    let meta: WordReadMeta = {};
    if (name === 'Get-Content') {
      const range = this.contentRange(vals);
      if (range) meta = { range };
    } else if (name === 'Select-String') {
      const pattern = vals('Pattern')[0] ?? null;
      if (pattern !== null) meta = { pattern };
    }
    for (const p of spec.read ?? [])
      for (const v of vals(p)) this.add('read', v, spec.kind ?? 'read', meta);
    for (const p of spec.write ?? []) for (const v of vals(p)) this.add('write', v);
    for (const p of spec.del ?? []) for (const v of vals(p)) this.add('del', v);
    if (spec.run) this.run(name);
  }

  /** `Get-Content -TotalCount|-Head|-First N` → lines 1..N; `-Tail|-Last N` → the last N. */
  private contentRange(
    vals: (p: string) => (string | null)[],
  ): BashReadRange | null {
    for (const p of HEAD_PARAMS) {
      const n = posInt(vals(p)[0] ?? null);
      if (n !== null) return { from: 1, to: n };
    }
    for (const p of TAIL_PARAMS) {
      const n = posInt(vals(p)[0] ?? null);
      if (n !== null) return { from: -n, to: null };
    }
    return null;
  }

  result(): BashAnalysis {
    const root = this.workDir;
    const rel = (p: string): string => relativeToWorkDir(root, p);
    const reads = this.read.filter((p) => !this.written.includes(p));
    return {
      workDir: root,
      changes: this.written.map(rel),
      reads: reads.map(rel),
      readAccess: reads.map((p) => ({
        path: rel(p),
        kind: this.readKind.get(p) ?? 'read',
        ...this.readMeta.get(p),
      })),
      runs: this.runs,
      inline: this.scripts.map(
        (s) => `inline ${s.command} script, ${s.lines} lines — not analysed`,
      ),
      unresolved: this.unresolved,
      deleted: this.written.filter((p) => this.removed.has(p)).map(rel),
    };
  }
}

/** Analyses `src` if its (masked) tree has no error; false when it has one. */
function analyzeClean(parser: BashParser, src: string, a: PsAnalyzer): boolean {
  return withPsTree(parser, src, (root, s) => {
    if (root.hasError) return false;
    a.walkRoot(root, s);
    return true;
  });
}

/**
 * Files a PowerShell command changes / reads / runs (see the module comment). When the whole
 * tree has an error even after masking, the top-level `;` pieces are analysed in source order
 * with one shared state (working dir, variables); each piece that still has an error — or the
 * whole command when it has no `;` — adds 1 to `unresolved`.
 */
export function analyzePowerShell(
  parser: BashParser,
  src: string,
): BashAnalysis {
  const a = new PsAnalyzer();
  if (!analyzeClean(parser, src, a)) {
    const pieces = topLevelPieces(src);
    if (!pieces.length) a.unresolved++;
    for (const piece of pieces)
      if (!analyzeClean(parser, piece, a)) a.unresolved++;
  }
  return a.result();
}
