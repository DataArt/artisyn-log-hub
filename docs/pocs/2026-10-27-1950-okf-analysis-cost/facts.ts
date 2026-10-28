// v4: preprocessed session facts for the analysis prompt — what was read, written and run — built
// with the session view's own analyser (`buildBashView` from client/src/viewer/lib/bash-view,
// algorithm docs/knowledgebase/algorithms/bash-command-view.md) instead of regexes over raw text.
// The transcript contributes only the user prompts (the task) and the tool calls' inputs.
// Run with bun (it resolves the client's TS sources and node_modules):
//   bun facts.ts <session-id-prefix>   → JSON on stdout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadBashParser } from '../../../client/src/viewer/lib/bash-view/bash-parser.ts';
import { buildBashView } from '../../../client/src/viewer/lib/bash-view/bash-view.ts';

const repoRoot = path.resolve(import.meta.dir, '../../..');
// Claude Code's project folder = the checkout path with every non-alphanumeric char turned into '-'.
const projectDir = path.join(os.homedir(), '.claude/projects', repoRoot.replace(/[^A-Za-z0-9]/g, '-'));
// Folder name of the checkout, to cut absolute paths down to repo paths (also in linked worktrees).
const repoDirRe = new RegExp(`/${path.basename(repoRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/\\.claude/worktrees/[^/]+)?/(.*)$`, 'i');
const clientRequire = createRequire(path.join(repoRoot, 'client/package.json'));

type FileFact = { calls: number; bytes: number; ranges: string[]; ownEditBytes: number; via: Set<string>; agents: Set<string> };

const isAbs = (s: string) => /^([a-zA-Z]:\/|\/)/.test(s);

// `base` is an absolute cwd, or the analyser's repo-relative `workDir` (it already strips the root).
function toRepoPath(p: string | undefined, base: string | null): string | null {
  if (!p) return null;
  let s = p.replace(/\\/g, '/');
  const b = base?.replace(/\\/g, '/') ?? null;
  if (!isAbs(s) && b) s = `${b}/${s}`;
  if (!isAbs(s)) return path.posix.normalize(s).replace(/\/+$/, '');
  const m = s.match(repoDirRe);
  if (!m) return null;
  return path.posix.normalize(m[1]).replace(/\/+$/, '');
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === 'text' ? x.text : '')).join('\n');
  return '';
}

// A slash command arrives as XML-ish wrappers; keep "/name args", drop CLI utilities like /clear.
function cleanPrompt(t: string): string | null {
  // System traffic in the user role is not the task: command output, background-task notifications.
  if (/<local-command-stdout>|<local-command-caveat>|^\s*<task-notification>/.test(t)) return null;
  const name = t.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  if (name) {
    const msg = t.includes('<command-message>');
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '';
    if (!msg || /^\/(clear|compact|login|logout|config|model|help|exit)$/.test(name)) return null;
    return `${name} ${args}`.trim();
  }
  const stripped = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return stripped || null;
}

const prefix = process.argv[2];
const id = fs.readdirSync(projectDir).find((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))!.slice(0, -6);
const files = [path.join(projectDir, `${id}.jsonl`)];
const sub = path.join(projectDir, id, 'subagents');
if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f));

const parser = await loadBashParser({
  runtimeWasm: clientRequire.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  languageWasm: clientRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm'),
});

const reads = new Map<string, FileFact>();
// v4c: per-agent view — a sub-agent is an independent task; its reads are judged against its own prompt.
type AgentFacts = { prompt: string; reads: Map<string, FileFact>; changes: Map<string, number>; kbSeq: string[] };
const perAgent = new Map<string, AgentFacts>();
const agentOf = (a: string) => { let x = perAgent.get(a); if (!x) { x = { prompt: '', reads: new Map(), changes: new Map(), kbSeq: [] }; perAgent.set(a, x); } return x; };
const changes = new Map<string, number>();
const runs = new Map<string, number>();
const prompts: string[] = [];
let firstTs: string | null = null;
let unparsedBash = 0;
let agent = 'main';

const bump = (p: string, bytes: number, via: string, range: string | null, own: boolean) => {
  const f = reads.get(p) ?? { calls: 0, bytes: 0, ranges: [], ownEditBytes: 0, via: new Set(), agents: new Set() };
  f.calls += 1; f.bytes += bytes; f.via.add(via); f.agents.add(agent);
  if (own) f.ownEditBytes += bytes;
  if (range && f.ranges.length < 6) f.ranges.push(range);
  reads.set(p, f);
  const af = agentOf(agent).reads;
  const g = af.get(p) ?? { calls: 0, bytes: 0, ranges: [], ownEditBytes: 0, via: new Set(), agents: new Set() };
  g.calls += 1; g.bytes += bytes; g.via.add(via); if (own) g.ownEditBytes += bytes; if (range && g.ranges.length < 6) g.ranges.push(range);
  af.set(p, g);
  // How the agent reached KB articles (findability): the order of its first KB accesses.
  const seq = agentOf(agent).kbSeq;
  if ((p.startsWith('docs/knowledgebase') || p.startsWith('docs/kb-local')) && seq.length < 15) seq.push(`${via.split(':')[0]} ${p}`);
};
const change = (p: string) => { changes.set(p, (changes.get(p) ?? 0) + 1); const c = agentOf(agent).changes; c.set(p, (c.get(p) ?? 0) + 1); };

for (const file of files) {
  const isMain = path.basename(file, '.jsonl') === id;
  agent = isMain ? 'main' : path.basename(file, '.jsonl');
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const edited = new Set<string>();
  let cwd: string | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let l: any;
    try { l = JSON.parse(line); } catch { continue; }
    if (l.timestamp) firstTs ??= l.timestamp;
    if (l.cwd) cwd = l.cwd;
    const msg = l.message;
    if (!msg) continue;
    if (!isMain && l.type === 'user' && !l.isMeta && !agentOf(agent).prompt) {
      const c0 = msg.content;
      agentOf(agent).prompt = typeof c0 === 'string' ? c0 : Array.isArray(c0) ? c0.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
    }
    if (isMain && l.type === 'user' && !l.isMeta) {
      const t = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
      const c = t && cleanPrompt(t);
      if (c) prompts.push(c);
    }
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use') { uses.set(b.id, { name: b.name, input: b.input ?? {} }); continue; }
      if (b.type !== 'tool_result') continue;
      const u = uses.get(b.tool_use_id);
      if (!u) continue;
      const bytes = Buffer.byteLength(resultText(b.content));
      const inp = u.input as Record<string, any>;
      if (u.name === 'Read') {
        const p = toRepoPath(inp.file_path, cwd);
        if (p) bump(p, bytes, 'Read', inp.offset || inp.limit ? `${inp.offset ?? 1}+${inp.limit ?? ''}` : null, edited.has(p));
      } else if (u.name === 'Edit' || u.name === 'MultiEdit' || u.name === 'Write' || u.name === 'NotebookEdit') {
        const p = toRepoPath(inp.file_path ?? inp.notebook_path, cwd);
        if (p) { change(p); edited.add(p); }
      } else if (u.name === 'Grep' || u.name === 'Glob') {
        const p = toRepoPath(inp.path ?? '.', cwd);
        if (p !== null) bump(p || '.', bytes, `${u.name}:${String(inp.pattern ?? '').slice(0, 40)}`, null, false);
      } else if (u.name === 'Bash') {
        const view = buildBashView(parser, String(inp.command ?? ''), repoRoot.replace(/\\/g, '/'));
        if (!view.ok) { unparsedBash += 1; continue; }
        const base = view.workDir ?? cwd;
        const rs = view.files.reads.map((r) => toRepoPath(r, base)).filter((x): x is string => Boolean(x));
        // One result for several files: split its bytes instead of charging each file in full.
        for (const p of rs) bump(p, Math.round(bytes / rs.length), 'Bash', null, edited.has(p));
        for (const c of view.files.changes) { const p = toRepoPath(c, base); if (p) { change(p); edited.add(p); } }
        for (const r of view.files.runs) runs.set(r, (runs.get(r) ?? 0) + 1);
      }
    }
  }
}

const kb = (p: string) => p.startsWith('docs/knowledgebase') || p.startsWith('docs/kb-local');
const readList = [...reads].sort((a, b) => b[1].bytes - a[1].bytes).map(([p, f]) => ({
  path: p, kb: kb(p), calls: f.calls, agents: f.agents.size, bytes: f.bytes, ownEditBytes: f.ownEditBytes,
  ranges: f.ranges, via: [...f.via].slice(0, 4),
}));
console.log(JSON.stringify({
  sessionId: id, startedAt: firstTs, prompts,
  reads: readList,
  changes: [...changes].map(([p, n]) => ({ path: p, kb: kb(p), edits: n })),
  runs: [...runs].map(([r, n]) => ({ run: r, times: n })).slice(0, 40),
  unparsedBash,
  agents: [...perAgent].filter(([a]) => a !== 'main').map(([a, x]) => ({
    id: a, prompt: x.prompt, kbSeq: x.kbSeq,
    kbReads: [...x.reads].filter(([p]) => kb(p)).map(([p, g]) => ({ path: p, calls: g.calls, bytes: g.bytes, ownEditBytes: g.ownEditBytes, ranges: g.ranges })),
    otherReadsTop: [...x.reads].filter(([p]) => !kb(p)).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([p, g]) => `${p} (${g.bytes} B)`),
    changes: [...x.changes].map(([p, n]) => `${p} (${n})`).slice(0, 15),
  })),
  mainKbSeq: perAgent.get('main')?.kbSeq ?? [],
  mainKbReads: [...(perAgent.get('main')?.reads ?? new Map())].filter(([p]) => kb(p)).map(([p, g]) => ({ path: p, calls: g.calls, bytes: g.bytes, ownEditBytes: g.ownEditBytes, ranges: g.ranges })),
}));
