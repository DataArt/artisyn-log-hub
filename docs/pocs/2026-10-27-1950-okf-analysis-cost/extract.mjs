// Reads one local Claude session tree (root transcript + subagents/*.jsonl) and extracts what the
// OKF usage analysis needs: user prompts, KB accesses, changed files, referenced docs, tracker
// results, and the session's own model usage (for an approximate session cost).
import fs from 'node:fs';
import path from 'node:path';

export const KB_BUNDLES = ['docs/knowledgebase', 'docs/kb-local'];
const DOC_EXT = /\.(md|txt|rst|adoc)$/i;

// USD per million tokens: input, output, cache read, cache write (5m). Approximate list prices.
const PRICES = {
  opus: [5, 25, 0.5, 6.25],
  sonnet: [3, 15, 0.3, 3.75],
  haiku: [1, 5, 0.1, 1.25],
};

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return PRICES.haiku;
  if (m.includes('sonnet')) return PRICES.sonnet;
  return PRICES.opus;
}

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
  }
  return out;
}

export function sessionFiles(projectDir, sessionId) {
  const files = [path.join(projectDir, `${sessionId}.jsonl`)];
  const subDir = path.join(projectDir, sessionId, 'subagents');
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
  }
  return files;
}

// Repo-relative, forward-slash path, or null when outside the repo.
export function toRepoPath(p, repoRoot) {
  if (!p) return null;
  let s = String(p).replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (s.toLowerCase().startsWith(root.toLowerCase() + '/')) s = s.slice(root.length + 1);
  else if (/^[a-zA-Z]:\//.test(s) || s.startsWith('/')) {
    // Another checkout of the same repo (e.g. a linked worktree): cut at the checkout folder name.
    const dir = path.posix.basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = s.match(new RegExp(`/${dir}(?:/\\.claude/worktrees/[^/]+)?/(.*)$`));
    if (!m) return null;
    s = m[1];
  }
  return s.replace(/^\.\//, '');
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : '')).join('\n');
  return '';
}

export const inKb = (p) => Boolean(p) && KB_BUNDLES.some((b) => p === b || p.startsWith(b + '/'));

function kbPathsInCommand(cmd, repoRoot) {
  const found = new Set();
  const re = /[^\s'"`|;&<>()]*(?:docs\/knowledgebase|docs\/kb-local)[^\s'"`|;&<>()]*/g;
  for (const m of cmd.replace(/\\/g, '/').matchAll(re)) {
    const rp = toRepoPath(m[0], repoRoot);
    if (rp && inKb(rp)) found.add(rp.replace(/\/+$/, ''));
  }
  return [...found];
}

function bashOp(cmd) {
  if (/\bsed\s+-n\b/.test(cmd) || /\b(head|tail)\b/.test(cmd)) return 'read-range';
  if (/\bgrep\b|\brg\b/.test(cmd)) return 'grep';
  if (/\bcat\b/.test(cmd)) return 'read';
  if (/\b(ls|find)\b/.test(cmd)) return 'list';
  return 'other';
}

export function extractSession(projectDir, sessionId, repoRoot) {
  const prompts = [];
  const accesses = []; // {agent, path, op, bytes, detail, afterOwnEdit}
  const changed = new Set();
  const calls = []; // {name, inputStr, result}
  let firstTs = null;
  let lastTs = null;
  let sessionCostUsd = 0;
  const seenMsgIds = new Set();

  for (const file of sessionFiles(projectDir, sessionId)) {
    const base = path.basename(file, '.jsonl');
    const agent = base === sessionId ? 'main' : base;
    const uses = new Map();
    const edited = new Set();
    for (const l of readJsonl(file)) {
      if (l.timestamp) { firstTs ??= l.timestamp; lastTs = l.timestamp; }
      const msg = l.message;
      if (!msg) continue;
      if (l.type === 'assistant' && msg.usage && msg.id && !seenMsgIds.has(msg.id)) {
        seenMsgIds.add(msg.id);
        const [pi, po, pr, pw] = priceFor(msg.model);
        const u = msg.usage;
        sessionCostUsd += ((u.input_tokens || 0) * pi + (u.output_tokens || 0) * po
          + (u.cache_read_input_tokens || 0) * pr + (u.cache_creation_input_tokens || 0) * pw) / 1e6;
      }
      if (l.type === 'user' && agent === 'main' && !l.isMeta) {
        if (typeof msg.content === 'string') prompts.push(msg.content);
        else if (Array.isArray(msg.content)) {
          const t = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (t.trim()) prompts.push(t);
        }
      }
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === 'tool_use') uses.set(b.id, b);
        if (b.type !== 'tool_result') continue;
        const u = uses.get(b.tool_use_id);
        if (!u) continue;
        const text = resultText(b);
        const bytes = Buffer.byteLength(text);
        const inp = u.input || {};
        calls.push({ name: u.name, inputStr: JSON.stringify(inp), result: text });
        const mark = (p, op, detail) => {
          accesses.push({ agent, path: p, op, bytes, detail, afterOwnEdit: edited.has(p) });
        };
        if (u.name === 'Read') {
          const p = toRepoPath(inp.file_path, repoRoot);
          if (inKb(p)) mark(p, inp.offset || inp.limit ? 'read-range' : 'read', inp.offset ? `offset ${inp.offset} limit ${inp.limit ?? ''}` : '');
        } else if (u.name === 'Edit' || u.name === 'MultiEdit' || u.name === 'Write') {
          const p = toRepoPath(inp.file_path, repoRoot);
          if (p) { changed.add(p); edited.add(p); }
          if (inKb(p)) mark(p, 'write', u.name);
        } else if (u.name === 'Grep' || u.name === 'Glob') {
          const p = toRepoPath(inp.path, repoRoot);
          if (inKb(p)) mark(p, u.name === 'Grep' ? 'grep' : 'list', inp.pattern || '');
        } else if (u.name === 'Bash' || u.name === 'PowerShell') {
          const cmd = String(inp.command || '');
          const op = bashOp(cmd);
          for (const p of kbPathsInCommand(cmd, repoRoot)) mark(p, op, cmd.slice(0, 160));
        }
      }
    }
  }
  return { sessionId, prompts, accesses, changed: [...changed], calls, firstTs, lastTs, sessionCostUsd };
}

// FR-22 (1)–(3): prompts, referenced documents, tracker results — all from the transcript.
export function taskContext(s, repoRoot) {
  const all = s.prompts.join('\n');
  const docs = new Map();
  for (const c of s.calls) {
    if (c.name !== 'Read') continue;
    let p = null;
    try { p = toRepoPath(JSON.parse(c.inputStr).file_path, repoRoot); } catch { /* none */ }
    if (!p || !DOC_EXT.test(p) || inKb(p) || docs.has(p)) continue;
    const hit = all.includes(p) || p.split('/').some((seg) => seg.length >= 12 && all.includes(seg));
    if (hit) docs.set(p, c.result);
  }
  const tokens = new Set([...all.matchAll(/\b(?:GH-\d+|[A-Z][A-Z0-9]+-\d+)\b|#\d+/g)].map((m) => m[0]));
  const trackers = [];
  for (const t of tokens) {
    const num = t.replace(/^(GH-|#)/, '');
    const ghView = new RegExp(`gh issue view ${num}\\b`);
    for (const c of s.calls) {
      // Only calls that reach a tracker: an MCP tool, or a shell call to gh / curl / an http URL.
      // A local `grep "FR-1" requirements.md` must not count as a tracker lookup.
      const trackerCall = c.name.startsWith('mcp__')
        || (c.name === 'Bash' && /\b(gh\s+(issue|pr|api)|curl|https?:\/\/)/.test(c.inputStr));
      if (!trackerCall) continue;
      if (c.inputStr.includes(t) || (/^(GH-|#)/.test(t) && ghView.test(c.inputStr))) {
        trackers.push({ token: t, call: c.inputStr.slice(0, 200), result: c.result });
      }
    }
  }
  return { docs: [...docs].map(([p, text]) => ({ path: p, text })), trackers };
}
