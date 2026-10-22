// Runs bash-view.mjs over a corpus of real Bash commands and checks it never breaks anything.
//   node verify.mjs [corpus.json]      corpus = JSON array of command strings (default corpus.json)
// Nothing is executed — commands are only parsed.
//
// Checks per command:
//   1. no exception in format() / analyze()
//   2. unparseable input → ok=false and the output is the input unchanged
//   3. the formatted script parses without errors
//   4. same token sequence as the input (tree-sitter leaves; `;` and newlines ignored)
//   5. independent oracle: shfmt --minify of input and output are identical (when shfmt parses it)
//   6. idempotent: format(format(x)) === format(x)
//   7. every reported file path's last segment occurs in the input text
import { readFileSync, writeFileSync } from 'node:fs'
import { format as shfmt } from '@wasm-fmt/shfmt'
import { init, parse, format, analyze } from './bash-view.mjs'

await init()
const corpus = JSON.parse(readFileSync(process.argv[2] ?? 'corpus.json', 'utf8'))

const leaves = (src) => {
  const out = []
  const walk = (n) => {
    if (n.childCount === 0 || n.type === 'heredoc_body' || n.type === 'string_content' || n.type === 'raw_string') {
      if (n.type !== ';' && n.type !== '\n' && n.text.trim() !== '') out.push(n.text)
      return
    }
    for (const c of n.children) walk(c)
  }
  walk(parse(src).rootNode)
  return out
}
// shfmt --minify keeps some layout (newline vs `;`, `\`-newline, newline after && | do then);
// normalize those the same way on both sides so only real token differences remain.
const minify = (s) => {
  let m
  try { m = shfmt(s, 'x.bash', { minify: true }) } catch { return null }
  return m
    .replace(/\\\n/g, ' ')
    .replace(/(&&|\|\||\||\bdo|\bthen|\belse|[{(])\n/g, '$1 ')
    .replace(/;?\n/g, ';')
    .replace(/ +/g, ' ')
    .replace(/ ?([;&|]) ?/g, '$1')
    .replace(/([^&])&;/g, '$1&')
}

const stats = { total: corpus.length, formatted: 0, fallback: 0, changed: 0, oracleChecked: 0, maxMs: 0, totalMs: 0 }
const failures = []
const fail = (i, check, detail) => failures.push({ i, check, detail, command: corpus[i].slice(0, 300) })
let linesBefore = 0
let linesAfter = 0
let longLines = 0
let withFiles = 0

for (let i = 0; i < corpus.length; i++) {
  const src = corpus[i]
  let f, a
  const t0 = performance.now()
  try {
    f = format(src)
    a = analyze(src)
  } catch (e) {
    fail(i, 'exception', String(e?.stack ?? e).slice(0, 300))
    continue
  }
  const ms = performance.now() - t0
  stats.totalMs += ms
  stats.maxMs = Math.max(stats.maxMs, ms)
  if (!f.ok) {
    stats.fallback++
    if (f.script !== src) fail(i, 'fallback-not-raw', '')
    continue
  }
  stats.formatted++
  if (f.script !== src) stats.changed++
  linesBefore += src.split('\n').length
  linesAfter += f.script.split('\n').length
  longLines += f.script.split('\n').filter((l) => l.length > 120).length
  if (parse(f.script).rootNode.hasError) { fail(i, 'output-unparseable', f.script.slice(0, 300)); continue }
  const la = leaves(src)
  const lb = leaves(f.script)
  if (la.join('\u0000') !== lb.join('\u0000')) {
    const k = la.findIndex((x, j) => x !== lb[j])
    fail(i, 'token-sequence', `first diff at token ${k}: ${JSON.stringify(la[k])} vs ${JSON.stringify(lb[k])}`)
  }
  const ma = minify(src)
  if (ma !== null) {
    stats.oracleChecked++
    const mb = minify(f.script)
    if (ma !== mb) fail(i, 'shfmt-oracle', `${JSON.stringify(ma?.slice(0, 150))}\n vs ${JSON.stringify(mb?.slice(0, 150))}`)
  }
  const f2 = format(f.script)
  if (f2.script !== f.script) {
    // tree-sitter-bash sometimes mis-parses our own multi-line output (grammar quirk); the
    // second pass must still be the same bash program
    const same = ma === null || minify(f2.script) === ma
    fail(i, same ? 'not-idempotent (same program)' : 'not-idempotent (PROGRAM CHANGED)', '')
  }
  const files = [...a.written, ...a.read]
  if (files.length) withFiles++
  for (const p of files) {
    const seg = p.split('/').filter(Boolean).at(-1) ?? p
    // loop / variable expansion builds names from pieces: every piece must occur in the input
    const pieces = seg.split(/[-_.]/).filter(Boolean)
    if (seg !== '.' && seg !== '..' && !src.includes(seg) && !pieces.every((x) => src.includes(x))) fail(i, 'file-not-in-input', p)
  }
}

const byCheck = {}
for (const f of failures) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1
const report = {
  ...stats,
  avgMs: +(stats.totalMs / stats.total).toFixed(2),
  maxMs: +stats.maxMs.toFixed(1),
  totalMs: Math.round(stats.totalMs),
  linesBefore,
  linesAfter,
  outputLinesOver120: longLines,
  commandsWithFiles: withFiles,
  failures: failures.length,
  byCheck,
}
console.log(JSON.stringify(report, null, 2))
writeFileSync('verify-failures.json', JSON.stringify(failures, null, 2))
process.exitCode = failures.length ? 1 : 0
