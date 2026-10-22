// PoC: readable view of a Claude Code Bash tool command, driven ONLY by the bash syntax tree
// (tree-sitter-bash). Nothing is ever executed — commands are parsed as text.
//
// format(src)  → { ok, script }          indented script; ok=false → unparseable, script = src
// analyze(src) → { root, written, read, runs, scripts, unresolved }   best-effort file summary
//
// Formatting rule: the output is the original token sequence; only whitespace changes, and only at
// places the grammar allows a newline (between statements, after && || | |&, inside do…done,
// then…fi, { … }, ( … )). Every other node is copied verbatim from the source.
import { createRequire } from 'node:module'
import { Parser, Language } from 'web-tree-sitter'

const require = createRequire(import.meta.url)
const WIDTH = 80
const IND = '  '

let parser = null

export async function init() {
  if (parser) return
  await Parser.init()
  const lang = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
  parser = new Parser()
  parser.setLanguage(lang)
}

export function parse(src) {
  return parser.parse(src)
}

// ---------------------------------------------------------------- format

const hasDesc = (n, type) => n.type === type || n.descendantsOfType(type).length > 0

/** Verbatim source of a node: indent only the first line, never touch the rest (heredocs, strings). */
function verbatim(src, start, end, ind) {
  const [first, ...rest] = src.slice(start, end).split('\n')
  return [ind + first, ...rest]
}

/** Statement nodes of a block plus whether each one is followed by `&`. */
function statements(nodes) {
  const out = []
  for (const c of nodes) {
    if (c.isNamed) out.push({ node: c, bg: false })
    else if (c.type === '&' && out.length) out[out.length - 1].bg = true
  }
  return out
}

/** Prints a block of statements; overlapping ranges (heredoc + `;` on its start line) stay verbatim. */
function printSeq(src, nodes, ind) {
  const stmts = statements(nodes)
  const lines = []
  for (let i = 0; i < stmts.length; i++) {
    let { node, bg } = stmts[i]
    let end = node.endIndex
    let j = i
    while (j + 1 < stmts.length && stmts[j + 1].node.startIndex < end) {
      j++
      end = Math.max(end, stmts[j].node.endIndex)
    }
    const out =
      j > i || hasDesc(node, 'heredoc_redirect')
        ? verbatim(src, node.startIndex, end, ind)
        : printStmt(src, node, ind)
    if (j > i) bg = stmts[j].bg
    if (bg) out[out.length - 1] += ' &'
    lines.push(...out)
    i = j
  }
  return lines
}

const oneLine = (n) => (n.text.includes('\n') ? null : n.text)

/** Operands and operators of a left-nested `list` / `pipeline`. */
function chain(node, type) {
  const parts = []
  for (const c of node.children) {
    if (c.type === type && c.isNamed) parts.push(...chain(c, type))
    else parts.push(c)
  }
  return parts
}

const CHAIN_OPS = new Set(['&&', '||', '|', '|&'])

function printChain(src, node, ind) {
  const flat = oneLine(node)
  if (flat !== null && ind.length + flat.length <= WIDTH) return [ind + flat]
  const parts = chain(node, node.type)
  if (parts.some((p) => !p.isNamed && !CHAIN_OPS.has(p.type)) || parts.some((p) => p.type === 'comment')) {
    return verbatim(src, node.startIndex, node.endIndex, ind)
  }
  const lines = []
  let first = true
  for (const p of parts) {
    if (!p.isNamed) {
      lines[lines.length - 1] += ' ' + p.type
      continue
    }
    lines.push(...printStmt(src, p, first ? ind : ind + IND))
    first = false
  }
  return lines
}

function printStmt(src, node, ind) {
  switch (node.type) {
    case 'list':
    case 'pipeline':
      return printChain(src, node, ind)
    case 'redirected_statement': {
      const flat = oneLine(node)
      if (flat !== null && ind.length + flat.length <= WIDTH) return [ind + flat]
      const body = node.childForFieldName('body')
      if (!body) return verbatim(src, node.startIndex, node.endIndex, ind)
      const lines = printStmt(src, body, ind)
      const redirects = src.slice(body.endIndex, node.endIndex)
      if (redirects.includes('\n')) return verbatim(src, node.startIndex, node.endIndex, ind)
      lines[lines.length - 1] += redirects
      return lines
    }
    case 'for_statement':
    case 'while_statement':
      return printLoop(src, node, ind)
    case 'if_statement':
      return printIf(src, node, ind)
    case 'compound_statement':
    case 'subshell': {
      const flat = oneLine(node)
      if (flat !== null && ind.length + flat.length <= WIDTH) return [ind + flat]
      const open = node.type === 'subshell' ? '(' : '{'
      const close = node.type === 'subshell' ? ')' : '}'
      const inner = node.children.filter((c) => c.type !== open && c.type !== close)
      return [ind + open, ...printSeq(src, inner, ind + IND), ind + close]
    }
    default:
      return verbatim(src, node.startIndex, node.endIndex, ind)
  }
}

/** for x in a b c; do … done / for ((…)) / while|until cond; do … done */
function printLoop(src, node, ind) {
  const body = node.childForFieldName('body')
  if (!body || body.type !== 'do_group') return verbatim(src, node.startIndex, node.endIndex, ind)
  const headerNodes = node.children.filter((c) => c.endIndex <= body.startIndex && c.type !== ';')
  let header
  if (node.type === 'for_statement' && node.children[0].type === 'for' && headerNodes.some((c) => c.type === 'in')) {
    const variable = node.childForFieldName('variable')
    const values = node.childrenForFieldName('value')
    const words = values.map((v) => v.text)
    if (words.some((w) => w.includes('\n'))) return verbatim(src, node.startIndex, node.endIndex, ind)
    header = [`${ind}for ${variable.text} in ${words.join(' ')}; do`]
    if (header[0].length > WIDTH && words.length > 2) {
      header = [`${ind}for ${variable.text} in \\`, ...words.map((w, k) => `${ind}${IND}${IND}${w}${k < words.length - 1 ? ' \\' : '; do'}`)]
    }
  } else {
    const h = src.slice(node.startIndex, headerNodes.at(-1).endIndex)
    if (h.includes('\n')) return verbatim(src, node.startIndex, node.endIndex, ind)
    header = [`${ind}${h}; do`]
  }
  const inner = body.children.filter((c) => c.type !== 'do' && c.type !== 'done')
  return [...header, ...printSeq(src, inner, ind + IND), `${ind}done`]
}

/** if cond; then … [elif cond; then …] [else …] fi */
function printIf(src, node, ind) {
  const lines = []
  const clause = (kw, cond, stmts) => {
    if (cond) {
      const c = src.slice(cond[0].startIndex, cond.at(-1).endIndex)
      if (c.includes('\n')) return false
      lines.push(`${ind}${kw} ${c}; then`)
    } else lines.push(`${ind}${kw}`)
    lines.push(...printSeq(src, stmts, ind + IND))
    return true
  }
  const split = (children) => {
    const t = children.findIndex((c) => c.type === 'then')
    const cond = children.slice(1, t).filter((c) => c.isNamed)
    return { cond, rest: children.slice(t + 1) }
  }
  const kids = node.children
  const firstClauseEnd = kids.findIndex((c) => c.type === 'elif_clause' || c.type === 'else_clause' || c.type === 'fi')
  const { cond, rest } = split(kids.slice(0, firstClauseEnd))
  if (!cond.length || !clause('if', cond, rest)) return verbatim(src, node.startIndex, node.endIndex, ind)
  for (const c of kids.slice(firstClauseEnd)) {
    if (c.type === 'elif_clause') {
      const e = split(c.children)
      if (!e.cond.length || !clause('elif', e.cond, e.rest)) return verbatim(src, node.startIndex, node.endIndex, ind)
    } else if (c.type === 'else_clause') {
      clause('else', null, c.children.slice(1))
    }
  }
  lines.push(`${ind}fi`)
  return lines
}

export function format(src) {
  const tree = parse(src)
  if (tree.rootNode.hasError) return { ok: false, script: src }
  const lines = printSeq(src, tree.rootNode.children, '')
  return { ok: true, script: lines.join('\n') }
}

// ---------------------------------------------------------------- analyze (touched files)

const W_CMDS = new Set(['rm', 'mkdir', 'touch', 'tee', 'chmod', 'rmdir', 'truncate'])
const R_CMDS = new Set(['cat', 'head', 'tail', 'less', 'wc', 'cut', 'ls', 'stat', 'diff', 'sort', 'uniq', 'file', 'nl', 'tac', 'md5sum', 'sha256sum'])
const SCRIPT_CMDS = /^(python3?|node|bun|deno|bash|sh|zsh|pwsh|powershell|ruby|perl|psql|sqlite3|tsx|ts-node)$/
const NOT_RUNS = new Set(['echo', 'printf', 'true', 'false', 'sleep', 'break', 'continue', 'exit', 'export', 'set', 'test', '[', 'seq', 'read', 'local', 'return', 'shift', 'wait', ':'])

/** Literal value of a word-like node, or null when it depends on anything non-literal. */
function literal(n, env) {
  switch (n.type) {
    case 'word':
    case 'number':
      return n.text.replace(/\\(.)/g, '$1')
    case 'raw_string':
      return n.text.slice(1, -1)
    case 'string': {
      let s = ''
      for (const c of n.namedChildren) {
        const v = c.type === 'string_content' ? c.text : literal(c, env)
        if (v === null) return null
        s += v
      }
      return s
    }
    case 'simple_expansion':
    case 'expansion': {
      const name = n.namedChildren.length === 1 && n.namedChildren[0].type === 'variable_name' ? n.namedChildren[0].text : null
      return name !== null && name in env ? env[name] : null
    }
    case 'concatenation': {
      let s = ''
      for (const c of n.namedChildren) {
        const v = literal(c, env)
        if (v === null) return null
        s += v
      }
      return s
    }
    default:
      return null
  }
}

const isAbs = (p) => /^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith('~')

function joinPath(cwd, p) {
  const norm = p.replace(/\\/g, '/')
  if (isAbs(norm) || !cwd) return norm
  const parts = cwd.split('/')
  for (const seg of norm.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

export function analyze(src) {
  const tree = parse(src)
  const res = { root: null, written: [], read: [], runs: [], scripts: [], unresolved: 0 }
  const add = (list, st, p) => {
    if (p === null) { res.unresolved++; return }
    if (p === '' || p === '-' || p.startsWith('/dev/') || /^&?\d+$/.test(p)) return
    const full = joinPath(st.cwd, p)
    if (!list.includes(full)) list.push(full)
  }
  const run = (label) => { if (!res.runs.includes(label)) res.runs.push(label) }

  const redirect = (r, st) => {
    const op = r.children.find((c) => !c.isNamed && c.type !== 'file_descriptor')?.type ?? ''
    const dest = r.childForFieldName('destination') ?? r.namedChildren.at(-1)
    if (!dest || dest.type === 'file_descriptor') return
    if (op === '<') add(res.read, st, literal(dest, st.env))
    else if (/^(>|>>|&>|&>>|>\|)$/.test(op)) add(res.written, st, literal(dest, st.env))
  }

  const command = (n, st, heredocs) => {
    const nameNode = n.childForFieldName('name')
    for (const c of n.namedChildren) if (c.type === 'file_redirect') redirect(c, st)
    if (!nameNode) return
    const name = literal(nameNode.namedChildren[0] ?? nameNode, st.env)
    if (name === null) { res.unresolved++; return }
    const argNodes = n.childrenForFieldName('argument')
    const args = argNodes.map((a) => literal(a, st.env))
    const flags = args.filter((a) => a !== null && a.startsWith('-'))
    const pos = args.filter((a) => a === null || !a.startsWith('-'))
    const base = name.replace(/^.*[\\/]/, '')
    if (base === 'cd') {
      if (st.inPipe) return
      const target = pos[0]
      if (target === null || target === undefined) { st.cwd = null; return }
      st.cwd = joinPath(st.cwd, target)
      if (res.root === null) res.root = st.cwd
      return
    }
    if (W_CMDS.has(base)) pos.forEach((p) => add(res.written, st, p))
    else if (R_CMDS.has(base)) pos.forEach((p) => add(res.read, st, p))
    else if (base === 'grep' || base === 'rg') pos.slice(1).forEach((p) => add(res.read, st, p))
    else if (base === 'sed') {
      const inPlace = flags.some((f) => /^-i/.test(f) || f === '--in-place')
      const hasScriptFlag = flags.some((f) => f === '-e' || f === '-f')
      pos.slice(hasScriptFlag ? 0 : 1).forEach((p) => add(inPlace ? res.written : res.read, st, p))
    } else if (base === 'mv') { pos.forEach((p) => add(res.written, st, p)) }
    else if (base === 'cp') { pos.slice(0, -1).forEach((p) => add(res.read, st, p)); add(res.written, st, pos.at(-1) ?? '') }
    else if (!NOT_RUNS.has(base)) {
      const sub = args[0] ?? ''
      const label = /^(npm|pnpm|yarn|bun)$/.test(base) && sub === 'run' ? `${base} run ${args[1] ?? '?'}`
        : /^(npm|npx|pnpm|yarn|git|docker|bunx|gh|dotnet|mvn|gradle|cargo|go)$/.test(base) && sub && !sub.startsWith('-') ? `${base} ${sub}`
        : base
      run(label)
    }
    if (SCRIPT_CMDS.test(base)) {
      for (const h of heredocs) res.scripts.push({ command: base, lines: h.split('\n').length - 1 })
      const inline = flags.findIndex((f) => f === '-e' || f === '-c' || f === '--eval')
      if (inline >= 0) res.scripts.push({ command: base, lines: (args.find((a, k) => k > args.indexOf(flags[inline]) && a !== null) ?? '').split('\n').length })
    }
  }

  const walk = (n, st, heredocs = []) => {
    switch (n.type) {
      case 'command':
        return command(n, st, heredocs)
      case 'variable_assignment': {
        const name = n.childForFieldName('name')?.text
        const val = n.childForFieldName('value')
        if (name) st.env[name] = val ? literal(val, st.env) ?? undefined : ''
        if (st.env[name] === undefined) delete st.env[name]
        return
      }
      case 'redirected_statement': {
        const bodies = n.descendantsOfType('heredoc_body').map((b) => b.text)
        const body = n.childForFieldName('body')
        if (body) walk(body, st, bodies)
        for (const c of n.namedChildren) {
          if (c.type === 'file_redirect') redirect(c, st)
          if (c.type === 'heredoc_redirect') for (const r of c.namedChildren) if (r.type === 'file_redirect') redirect(r, st)
        }
        return
      }
      case 'pipeline':
        for (const c of n.namedChildren) walk(c, { ...st, env: { ...st.env }, inPipe: true }, heredocs)
        return
      case 'subshell': {
        const inner = { ...st, env: { ...st.env } }
        for (const c of n.namedChildren) walk(c, inner)
        return
      }
      case 'for_statement': {
        const v = n.childForFieldName('variable')?.text
        const values = n.childrenForFieldName('value').map((x) => literal(x, st.env))
        const body = n.childForFieldName('body')
        if (!body) return
        const known = v && values.length && values.every((x) => x !== null && !/\s/.test(x)) ? values.slice(0, 30) : [null]
        for (const val of known) {
          if (val !== null) st.env[v] = val
          else if (v) delete st.env[v]
          for (const c of body.namedChildren) walk(c, st)
        }
        if (v) delete st.env[v]
        return
      }
      case 'command_substitution':
      case 'process_substitution':
        return
      default:
        for (const c of n.namedChildren) walk(c, st, heredocs)
    }
  }

  const st = { cwd: null, env: {}, inPipe: false }
  if (!tree.rootNode.hasError) for (const c of tree.rootNode.namedChildren) walk(c, st)
  const root = res.root
  const rel = (p) => {
    if (!root) return p
    if (p === root) return '.'
    if (p.startsWith(root + '/')) return p.slice(root.length + 1)
    const up = root.split('/')
    const pp = p.split('/')
    let k = 0
    while (k < up.length && k < pp.length && up[k] === pp[k]) k++
    return k >= 2 && up.length - k <= 2 ? '../'.repeat(up.length - k) + pp.slice(k).join('/') : p
  }
  res.read = res.read.filter((p) => !res.written.includes(p)).map(rel)
  res.written = res.written.map(rel)
  return res
}

/** Leading `cd <literal>` lifted into a working-dir header (presentation only). */
export function liftCd(src, script) {
  const tree = parse(src)
  const first = tree.rootNode.namedChildren[0]
  if (!first || first.type !== 'command') return { dir: null, script }
  const name = first.childForFieldName('name')
  const args = first.childrenForFieldName('argument')
  if (name?.text !== 'cd' || args.length !== 1) return { dir: null, script }
  const dir = literal(args[0], {})
  const firstLine = script.split('\n')[0]
  if (dir === null || firstLine !== first.text) return { dir: null, script }
  return { dir, script: script.split('\n').slice(1).join('\n') }
}
