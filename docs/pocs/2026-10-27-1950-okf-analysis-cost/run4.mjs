// v4: the analysis input is the preprocessed session facts (facts.ts — the session view's own
// read/write/Bash analyser), the user prompts and the KB indexes; no transcript text otherwise.
// Runs `claude -p` like the hook worker, then checks the result against the README criteria.
//   node run4.mjs <tag> <id-prefix> [...]   → out-runs/<tag>/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const [tag, ...SAMPLE] = process.argv.slice(2);
if (!tag || !SAMPLE.length) throw new Error('usage: node run4.mjs <tag> <id-prefix> [...]');
const MODEL = 'sonnet';
const TIMEOUT_MS = 10 * 60 * 1000;
const here = import.meta.dirname;
const repoRoot = path.resolve(here, '../../..');
const outDir = path.join(here, 'out-runs', tag);
fs.mkdirSync(outDir, { recursive: true });
const BUNDLES = ['docs/knowledgebase', 'docs/kb-local'];
const PROMPT_FILE = path.join(here, process.env.PROMPT || 'prompt-v4.md');
// v4b: KB_AT_SESSION=1 → judge against the KB as it was when the session started. `docs/` of the
// last commit before the session is unpacked (read-only `git archive`) into the OS temp dir —
// outside the repo, so Claude Code finds no CLAUDE.md, rules or hook settings walking up — and
// `claude -p` runs there.
// docs/kb-local is gitignored, so it is copied from the working tree.
const KB_AT_SESSION = process.env.KB_AT_SESSION === '1';

function kbRootFor(startedAt) {
  if (!KB_AT_SESSION) return repoRoot;
  const commit = execFileSync('git', ['rev-list', '-1', `--before=${startedAt}`, 'main'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const dir = path.join(os.tmpdir(), 'okf-poc-kb-snapshots', commit.slice(0, 10));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    const tarball = execFileSync('git', ['archive', '--format=tar', commit, 'docs'], { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir.replace(/\\/g, '/')], { input: tarball, shell: process.platform === 'win32' });
    fs.cpSync(path.join(repoRoot, 'docs/kb-local'), path.join(dir, 'docs/kb-local'), { recursive: true });
    // v4f: the harness files that steer agents to the KB, as of session start, under harness/ —
    // NOT at the root, where Claude Code would load CLAUDE.md as the analysis model's own memory.
    const harness = path.join(dir, 'harness');
    fs.mkdirSync(harness, { recursive: true });
    for (const p of ['CLAUDE.md', '.claude/rules', '.claude/skills', '.artisyn/marketplace/plugins/adlc-lh/skills']) {
      let tar;
      try { tar = execFileSync('git', ['archive', '--format=tar', commit, p], { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
      execFileSync('tar', ['-x', '-C', harness.replace(/\\/g, '/')], { input: tar, shell: process.platform === 'win32' });
    }
  }
  return dir;
}

const kbIndexes = (root) => BUNDLES.map((b) => {
  const p = path.join(root, b, 'index.md');
  return fs.existsSync(p) ? `### ${b}/index.md\n${fs.readFileSync(p, 'utf8')}` : '';
}).filter(Boolean).join('\n\n');

const kb = (p) => BUNDLES.some((b) => p === b || p.startsWith(b + '/'));

function factsSection(f) {
  const kbReads = f.reads.filter((r) => r.kb);
  const other = f.reads.filter((r) => !r.kb).slice(0, 40);
  const row = (r) => `- ${r.path}: ${r.bytes} bytes into context, ${r.calls} calls by ${r.agents} agent(s)`
    + `${r.ownEditBytes ? `, ${r.ownEditBytes} bytes after the same agent's own edit` : ''}`
    + `${r.ranges.length ? `, ranges ${r.ranges.join(' ')}` : ''}, via ${r.via.join(', ')}`;
  return [
    `Session started at ${f.startedAt}; it has ${f.prompts.length} user prompts.`,
    `### KB reads (whole session tree, sub-agents included)\n${kbReads.length ? kbReads.map(row).join('\n') : '(none — the session read no KB file)'}`,
    `### KB files written\n${f.changes.filter((c) => c.kb).map((c) => `- ${c.path}: ${c.edits} edits`).join('\n') || '(none)'}`,
    `### Other files changed (${f.changes.filter((c) => !c.kb).length})\n${f.changes.filter((c) => !c.kb).slice(0, 80).map((c) => `- ${c.path} (${c.edits})`).join('\n') || '(none)'}`,
    `### Other files read, top ${other.length} by bytes (code the session had to explore)\n${other.map((r) => `- ${r.path}: ${r.bytes} bytes, ${r.calls} calls`).join('\n') || '(none)'}`,
    `### Commands run\n${f.runs.slice(0, 15).map((r) => `- ${r.run} ×${r.times}`).join('\n') || '(none)'}`,
  ].join('\n\n');
}

// v4c (PER_AGENT=1): a sub-agent is an independent task with its own prompt and an empty context —
// its reads are listed under its own prompt, to be judged against that prompt, never summed over
// the tree.
const short = (id) => id.replace(/^agent-/, '').slice(0, 8);
function factsSectionPerAgent(f, kbRoot) {
  const size = (p) => {
    try {
      const s = fs.statSync(path.join(kbRoot, p));
      return s.isFile() ? ` of a ${Math.round(s.size / 1024)} KB file` : ' (folder)';
    } catch { return ' (not in the KB at session start)'; }
  };
  const row = (r) => `- ${r.path}: ${r.bytes} bytes${size(r.path)}, ${r.calls} calls`
    + `${r.ownEditBytes ? `, ${r.ownEditBytes} bytes after this agent's own edit` : ''}`
    + `${r.ranges.length ? `, ranges ${r.ranges.join(' ')}` : ''}`;
  const main = [
    `### Agent main — its task is the user prompts above`,
    `KB reads:\n${f.mainKbReads.map(row).join('\n') || '(none)'}`,
    `Order of first KB accesses: ${f.mainKbSeq.join(' → ') || '(none)'}`,
  ].join('\n');
  const subs = f.agents.map((a) => [
    `### Agent ${short(a.id)} — sub-agent`,
    `Its prompt (its whole task):\n\`\`\`\n${a.prompt}\n\`\`\``,
    `KB reads:\n${a.kbReads.map(row).join('\n') || '(none)'}`,
    `Order of first KB accesses: ${a.kbSeq.join(' → ') || '(none)'}`,
    `Other files read (top): ${a.otherReadsTop.join(', ') || '(none)'}`,
    `Files changed: ${a.changes.join(', ') || '(none)'}`,
  ].join('\n'));
  const tree = factsSection(f).split('\n\n').filter((s) => /^### (Other files changed|Other files read|Commands run)/.test(s));
  return [`Session started at ${f.startedAt}; ${f.prompts.length} user prompts; ${f.agents.length} sub-agents.`,
    main, ...subs, '### Whole session tree', ...tree].join('\n\n');
}

function callClaude(prompt, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('claude', ['--model', MODEL, '--print', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'], {
      shell: process.platform === 'win32', windowsHide: true, cwd,
      env: { ...process.env, ARTISYN_HOOK_SERVICE: 'okf-analysis-poc' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err: err.slice(-2000), ms: Date.now() - t0 }); });
    child.stdin.end(prompt);
  });
}

function parseStream(out) {
  let env = {};
  const tools = [];
  for (const line of out.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') env = ev;
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'tool_use') tools.push(`${b.name} ${String(b.input?.file_path || b.input?.command || b.input?.pattern || '').replace(/\\/g, '/').replace(new RegExp(`^.*/${path.basename(repoRoot)}/`), '')}`);
      }
    }
  }
  let result = null;
  const text = String(env.result || '');
  const m = text.match(/\{[\s\S]*\}/);
  try { result = m ? JSON.parse(m[0]) : null; } catch { /* not json */ }
  return { env, tools, result, text };
}

// v4e: deterministic filter the server applies to `kbFixes` (no LLM) — drops fixes the facts refute:
// "split" of an article under 20 KB, and an index-line fix whose keywords the line already has.
const SPLIT_MIN_BYTES = 20 * 1024;
function filterFixes(r, kbRoot) {
  if (!r?.kbFixes) return [];
  const indexText = BUNDLES.map((b) => { try { return fs.readFileSync(path.join(kbRoot, b, 'index.md'), 'utf8'); } catch { return ''; } }).join('\n');
  const lineFor = (p) => indexText.split('\n').find((l) => l.includes(`(${path.posix.basename(p)})`) || l.includes(p.replace(/^docs\/(knowledgebase|kb-local)\//, ''))) || '';
  const dropped = [];
  r.kbFixes = r.kbFixes.filter((x) => {
    if (x.kind === 'split') {
      let size = Infinity;
      try { size = fs.statSync(path.join(kbRoot, x.path)).size; } catch { /* unknown → keep */ }
      if (size < SPLIT_MIN_BYTES) { dropped.push(`split of a ${Math.round(size / 1024)} KB article: ${x.path}`); return false; }
    }
    if (x.kind === 'index_line' && Array.isArray(x.keywords) && x.keywords.filter(Boolean).length) {
      const line = lineFor(x.path).toLowerCase();
      if (line && x.keywords.filter(Boolean).every((k) => line.includes(String(k).toLowerCase()))) {
        dropped.push(`index line of ${x.path} already has: ${x.keywords.join(', ')}`);
        return false;
      }
    }
    return true;
  });
  return dropped;
}

// Automatic part of the README criteria (2, 3); 4 and 5 are judged by reading the result.
function check(f, r, kbRoot) {
  const kbReadPaths = f.reads.filter((x) => x.kb).map((x) => x.path);
  const judged = new Set((r?.reads || []).map((x) => x.path));
  const missed = r?.missed || [];
  if (process.env.PER_AGENT === '1') {
    const pairs = [...f.mainKbReads.map((x) => `main|${x.path}`), ...f.agents.flatMap((a) => a.kbReads.map((x) => `${short(a.id)}|${x.path}`))];
    const got = new Set((r?.reads || []).map((x) => `${String(x.agent).replace(/^agent-/, '').slice(0, x.agent === 'main' ? 4 : 8)}|${x.path}`));
    judged.clear();
    judged.add('__pairs__');
    return {
      kbReadsJudged: `${pairs.filter((p) => got.has(p)).length}/${pairs.length} agent+file`,
      missedExist: `${missed.filter((x) => fs.existsSync(path.join(kbRoot, x.path))).length}/${missed.length}`,
      missedNotKb: missed.filter((x) => !kb(x.path)).map((x) => x.path),
      notNeeded: (r?.reads || []).filter((x) => x.verdict === 'not_needed').length,
    };
  }
  return {
    kbReadsJudged: `${kbReadPaths.filter((p) => judged.has(p)).length}/${kbReadPaths.length}`,
    missedExist: `${missed.filter((x) => fs.existsSync(path.join(kbRoot, x.path))).length}/${missed.length}`,
    missedButRead: missed.filter((x) => kbReadPaths.includes(x.path)).map((x) => x.path),
    missedNotKb: missed.filter((x) => !kb(x.path)).map((x) => x.path),
    notNeeded: (r?.reads || []).filter((x) => x.verdict === 'not_needed').length,
  };
}

const template = fs.readFileSync(PROMPT_FILE, 'utf8');
const rows = [];
for (const prefix of SAMPLE) {
  const f = JSON.parse(execFileSync('bun', ['facts.ts', prefix], { cwd: here, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' }));
  fs.writeFileSync(path.join(outDir, `${prefix}.facts.json`), JSON.stringify(f, null, 2));
  const kbRoot = kbRootFor(f.startedAt);
  const prompt = template
    .replace('{{PROMPTS}}', f.prompts.map((p, i) => `### Prompt ${i + 1}\n${p}`).join('\n\n') || '(none)')
    .replace('{{FACTS}}', process.env.PER_AGENT === '1' ? factsSectionPerAgent(f, kbRoot) : factsSection(f))
    .replace('{{KB_INDEXES}}', kbIndexes(kbRoot));
  fs.writeFileSync(path.join(outDir, `${prefix}.prompt.md`), prompt);
  console.log(`[${prefix}] prompt ${Math.round(Buffer.byteLength(prompt) / 1024)} KB, running…`);
  const r = await callClaude(prompt, kbRoot);
  fs.writeFileSync(path.join(outDir, `${prefix}.out.jsonl`), r.out || r.err);
  const { env, tools, result, text } = parseStream(r.out);
  const droppedFixes = filterFixes(result, kbRoot);
  fs.writeFileSync(path.join(outDir, `${prefix}.result.json`), result ? JSON.stringify(result, null, 2) : text);
  fs.writeFileSync(path.join(outDir, `${prefix}.tools.txt`), tools.join('\n'));
  const row = {
    id: prefix, promptKB: Math.round(Buffer.byteLength(prompt) / 1024), kbReads: f.reads.filter((x) => x.kb).length,
    exit: r.code, sec: Math.round(r.ms / 1000), turns: env.num_turns ?? null, costUsd: env.total_cost_usd ?? null,
    toolCalls: tools.length, json: Boolean(result), taskKind: result?.taskKind ?? null,
    missed: result?.missed?.length ?? null, gaps: result?.gaps?.length ?? null, ...check(f, result, kbRoot),
    excessive: (result?.reads || []).filter((x) => x.cost === 'excessive').length,
    tooCoarse: (result?.reads || []).filter((x) => x.granularity === 'too_coarse').length,
    viaSearch: (result?.reads || []).filter((x) => x.findability === 'search').length,
    kbFixes: result?.kbFixes?.length ?? null,
    entryFixes: result?.entryFixes?.length ?? null,
    causes: [...(result?.missed || []), ...(result?.reads || []).filter((x) => x.cause && x.cause !== 'none')]
      .reduce((m, x) => ({ ...m, [x.cause]: (m[x.cause] || 0) + 1 }), {}),
    droppedFixes,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
