// Builds the FR-22 analysis prompt for each sample session and runs it through `claude -p`
// exactly like the hook worker does (sonnet, --print, --no-session-persistence, json envelope).
// Measures wall time, cost, tokens and prompt size; writes everything to out-runs/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { extractSession, taskContext, KB_BUNDLES } from './extract.mjs';

const SAMPLE = process.argv.slice(2).length ? process.argv.slice(2) : [
  'c77d1077', '5b0a1634', '4b15c275', 'e88adad0', '92f0ad24',
];
const MODEL = 'sonnet';
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROMPT = 60 * 1024;

const projectDir = path.join(os.homedir(), '.claude/projects/D---work-Artisyn-LogHub--repo');
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const outDir = path.join(import.meta.dirname, 'out-runs');
fs.mkdirSync(outDir, { recursive: true });

function fullId(prefix) {
  const f = fs.readdirSync(projectDir).find((x) => x.startsWith(prefix) && x.endsWith('.jsonl'));
  if (!f) throw new Error(`no transcript for ${prefix}`);
  return f.slice(0, -6);
}

// (3) KB map: only each bundle's index.md text (v2 — the KB itself can weigh megabytes).
// v1 (results in out-runs/v1-outline/) also sent the outline of every file and broke the 60 KB cap.
function kbMap() {
  const parts = [];
  for (const b of KB_BUNDLES) {
    const idx = path.join(repoRoot, b, 'index.md');
    if (fs.existsSync(idx)) parts.push(`### ${b}/index.md\n${fs.readFileSync(idx, 'utf8')}`);
  }
  return parts.join('\n\n');
}

// (4) accesses by file: ops, details, bytes, own-edit flag.
function accessTable(s) {
  if (!s.accesses.length) return '(no KB access in this session)';
  const by = new Map();
  for (const a of s.accesses) {
    const r = by.get(a.path) || { calls: 0, bytes: 0, ownEditBytes: 0, ops: new Set(), details: [] };
    r.calls += 1; r.bytes += a.bytes; if (a.afterOwnEdit) r.ownEditBytes += a.bytes;
    r.ops.add(a.op); if (a.detail && r.details.length < 4) r.details.push(a.detail);
    by.set(a.path, r);
  }
  return [...by].sort((x, y) => y[1].bytes - x[1].bytes).map(([p, r]) =>
    `- ${p}: ${r.calls} calls, ${r.bytes} bytes into context${r.ownEditBytes ? ` (${r.ownEditBytes} after own edit)` : ''}, ops ${[...r.ops].join('/')}${r.details.length ? `\n    e.g. ${r.details.join(' | ')}` : ''}`).join('\n');
}

function buildPrompt(s, prefix) {
  const ctx = taskContext(s, repoRoot);
  const fixed = [
    `## Changed files\n${s.changed.length ? s.changed.map((p) => `- ${p}`).join('\n') : '(none)'}`,
    `## Knowledge base map\n${kbMap()}`,
    `## KB accesses in this session (whole session tree, sub-agents included)\n${accessTable(s)}`,
  ].join('\n\n');
  const head = `You analyse how a coding agent used the project's knowledge base (KB) in one session.
The task is NOT always a requirements document: often it is a single question or one phrase. The user
prompts below are the task; documents are included only when the prompts point at them. Decide what kind
of task it was, then judge, per kind of task, which KB articles/sections would have helped answer the
question or make the change.
You get only the KB index files, not the KB itself. When a KB file listed there looks relevant to judging
this task, read it with the Read tool. Be moderately curious: read what you need to decide whether it was
a wrong read or a miss, not the whole KB. If the user refers to requirements you were not given, read them
yourself too. Reading a little code is fine when it helps you judge, but focus on the KB.
Answer with ONLY one JSON object, no prose, with this shape:
{"taskKind":"question|change|other","summary":"...","falseReads":[{"path":"","section":"","reason":""}],
"missed":[{"path":"","section":"","why":""}],"indexHints":[{"path":"","suggestion":""}],"missingContext":[""]}
falseReads = KB reads that were not useful for this task; missed = KB parts that would have helped but were
not read (only paths from the map); missingContext only when the prompts point at something whose text
is not available.`;

  // (1) task context — never cut (v3). Inline when it fits the 60 KB cap; otherwise written in full to
  // a local file the model must read completely (v2 truncated long sessions and lost their task).
  const docs = ctx.docs.map((d) => `### ${d.path}\n${d.text}`);
  const trk = ctx.trackers.map((x) => `### ${x.token}: ${x.call}\n${x.result}`);
  const prompts = s.prompts.map((p, i) => `### Prompt ${i + 1}\n${p}`);
  const task = [`## User prompts\n${prompts.join('\n\n')}`,
    docs.length ? `## Referenced documents\n${docs.join('\n\n')}` : '',
    trk.length ? `## Tracker results\n${trk.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
  const budget = MAX_PROMPT - Buffer.byteLength(head + fixed) - 500;
  let section;
  let ctxFileKB = 0;
  if (Buffer.byteLength(task) <= budget) {
    section = task;
  } else {
    const file = path.join(outDir, `${prefix}.context.md`);
    fs.writeFileSync(file, task);
    ctxFileKB = Math.round(Buffer.byteLength(task) / 1024);
    const lines = task.split('\n').length;
    section = `The task context is too large to inline: ${ctxFileKB} KB, ${lines} lines — all ${prompts.length} user prompts verbatim, ${docs.length} referenced documents and ${trk.length} tracker results, in that order.
It is in ${file.replace(/\\/g, '/')}.
Read that file COMPLETELY before judging — page through it with the Read tool (offset/limit) until its last line.
Nothing in it is optional: the task is often stated in the first prompts and refined in later ones.`;
  }
  return { prompt: `${head}\n\n## Task context\n${section}\n\n${fixed}`, ctx, ctxFileKB, fixedBytes: Buffer.byteLength(fixed) };
}

function callClaude(prompt) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // stream-json (not the worker's json) only so the PoC can list which files the model read;
    // the final `result` event carries the same fields as the json envelope.
    const child = spawn('claude', ['--model', MODEL, '--print', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'], {
      shell: process.platform === 'win32', windowsHide: true, cwd: repoRoot,
      env: { ...process.env, ARTISYN_HOOK_SERVICE: 'okf-analysis-poc' },
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err: err.slice(-2000), ms: Date.now() - t0 }); });
    child.stdin.end(prompt);
  });
}

const rows = [];
for (const prefix of SAMPLE) {
  const id = fullId(prefix);
  const s = extractSession(projectDir, id, repoRoot);
  const { prompt, ctx, ctxFileKB, fixedBytes } = buildPrompt(s, prefix);
  fs.writeFileSync(path.join(outDir, `${prefix}.prompt.md`), prompt);
  console.log(`[${prefix}] prompt ${Math.round(Buffer.byteLength(prompt) / 1024)} KB, running…`);
  const r = await callClaude(prompt);
  fs.writeFileSync(path.join(outDir, `${prefix}.out.json`), r.out || r.err);
  let env = {};
  const modelReads = [];
  for (const line of r.out.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') env = ev;
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'tool_use') modelReads.push(`${b.name} ${String(b.input?.file_path || b.input?.command || b.input?.pattern || '').replace(/\\/g, '/').replace(/^.*\/_repo\//, '')}`);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, `${prefix}.result.json`), String(env.result || ''));
  let parsed = null;
  try { parsed = JSON.parse(String(env.result || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* not json */ }
  const u = env.usage || {};
  rows.push({
    id: prefix,
    sessionUsd: Number(s.sessionCostUsd.toFixed(2)),
    kbCalls: s.accesses.length,
    promptKB: Math.round(Buffer.byteLength(prompt) / 1024),
    fixedKB: Math.round(fixedBytes / 1024),
    docs: ctx.docs.length, trackers: ctx.trackers.length, ctxFileKB,
    exit: r.code, sec: Math.round(r.ms / 1000), turns: env.num_turns ?? null,
    costUsd: env.total_cost_usd ?? null,
    inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    outTok: u.output_tokens || 0,
    json: Boolean(parsed), taskKind: parsed?.taskKind ?? null,
    falseReads: parsed?.falseReads?.length ?? null, missed: parsed?.missed?.length ?? null,
    toolCalls: modelReads.length,
  });
  fs.writeFileSync(path.join(outDir, `${prefix}.tools.txt`), modelReads.join('\n'));
  console.log(JSON.stringify(rows.at(-1)));
}
fs.writeFileSync(path.join(outDir, `summary-${SAMPLE[0]}.json`), JSON.stringify(rows, null, 2));
console.table(rows);
