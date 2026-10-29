#!/usr/bin/env node
// PoC: reconstruct the startup system-context anatomy of a Claude Code session.
// Reads the session transcript (only lengths and names, never prints content) plus the files on
// disk the sections come from (size + git status), and prints a partition table in Markdown.
//
// Usage: node anatomy.cjs [--project <repo root>] [--transcript <session.jsonl>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHARS_PER_TOKEN = 3.7; // estimate; only the total is exact (from API usage)

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '--transcript') args.transcript = argv[++i];
  }
  return args;
}

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

function norm(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function projectSlug(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
}

function newestTranscript(root) {
  const dir = path.join(CLAUDE_DIR, 'projects', projectSlug(root));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`no transcripts in ${dir}`);
  return files[0].f;
}

function makeDisplay(root) {
  const r = norm(root);
  const c = norm(CLAUDE_DIR);
  return (abs) => {
    const n = norm(abs);
    const real = path.resolve(abs).replace(/\\/g, '/');
    if (n.startsWith(r + '/')) return real.slice(r.length + 1);
    const cache = c + '/plugins/cache/';
    if (n.startsWith(cache)) {
      const parts = real.slice(cache.length).split('/'); // <marketplace>/<plugin>/<ver>/...
      return `${parts[1]}@${parts[2]}/${parts.slice(3).join('/')}`;
    }
    if (n.startsWith(c + '/')) {
      // hide account / machine ids: synced org folder and the project slug
      const rel = real.slice(c.length + 1)
        .replace(/^skills\/synced\/[^/]+/, 'skills/synced/<org>')
        .replace(/^projects\/[^/]+/, 'projects/<project-slug>');
      return `~/.claude/${rel}`;
    }
    return `<outside>/${path.basename(abs)}`;
  };
}

function makeGitStatus(root) {
  const r = norm(root);
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  return (abs) => {
    if (!abs || !fs.existsSync(abs)) return 'missing';
    if (!norm(abs).startsWith(r + '/')) return 'outside repo';
    const rel = path.relative(root, abs);
    if (git(['ls-files', '--error-unmatch', '--', rel]).status === 0) {
      const dirty = git(['status', '--porcelain', '--', rel]).stdout.trim();
      return dirty ? 'tracked, modified' : 'tracked';
    }
    if (git(['check-ignore', '-q', '--', rel]).status === 0) return 'ignored';
    return 'untracked';
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// enabled plugin id -> resolved install path (same precedence as the hook's skill catalog)
function resolvePlugins(root) {
  const enabled = {};
  for (const p of [path.join(CLAUDE_DIR, 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json')]) {
    Object.assign(enabled, (readJson(p) || {}).enabledPlugins || {});
  }
  const installed = (readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const out = {};
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const recs = installed[id] || [];
    const match = (scope) => recs.find((x) => x.scope === scope && x.projectPath && norm(x.projectPath) === norm(root));
    const rec = match('local') || match('project') || recs.find((x) => x.scope === 'user');
    if (!rec) continue;
    const manifest = readJson(path.join(rec.installPath, '.claude-plugin', 'plugin.json')) || {};
    out[manifest.name || id.split('@')[0]] = { id, installPath: rec.installPath, version: rec.version };
  }
  return out;
}

function findSyncedSkill(name) {
  const base = path.join(CLAUDE_DIR, 'skills', 'synced');
  if (!fs.existsSync(base)) return null;
  for (const org of fs.readdirSync(base)) {
    const f = path.join(base, org, name, 'SKILL.md');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function resolveSkill(name, root, plugins) {
  const colon = name.indexOf(':');
  if (colon > 0) {
    const plugin = name.slice(0, colon);
    const skill = name.slice(colon + 1);
    if (plugins[plugin]) {
      const base = plugins[plugin].installPath;
      const f = [path.join(base, 'skills', skill, 'SKILL.md'), path.join(base, 'workflows', `${skill}.js`)].find((x) => fs.existsSync(x));
      return { source: `plugin ${plugin}@${plugins[plugin].version}`, file: f || null };
    }
    const synced = findSyncedSkill(skill);
    if (synced) return { source: `org-synced (${plugin})`, file: synced };
    return { source: `plugin ${plugin} (not resolved)`, file: null };
  }
  const proj = path.join(root, '.claude', 'skills', name, 'SKILL.md');
  if (fs.existsSync(proj)) return { source: 'project', file: proj };
  const projWf = path.join(root, '.claude', 'workflows', `${name}.js`);
  if (fs.existsSync(projWf)) return { source: 'project workflow', file: projWf };
  const user = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
  if (fs.existsSync(user)) return { source: 'user', file: user };
  return { source: 'built-in (Claude Code)', file: null };
}

// split the rendered skill listing into per-skill chunks, keyed by the names array
function splitSkillListing(content, names) {
  const sizes = {};
  const starts = [];
  for (const n of names) {
    const i = content.indexOf(`- ${n}: `);
    if (i >= 0) starts.push({ n, i });
  }
  starts.sort((a, b) => a.i - b.i);
  starts.forEach((s, k) => { sizes[s.n] = (k + 1 < starts.length ? starts[k + 1].i : content.length) - s.i; });
  return sizes;
}

function heading(block, i) {
  const first = block.trim().split('\n')[0];
  if (first.startsWith('#')) return first.replace(/^#+\s*/, '').slice(0, 40);
  if (block.startsWith('__')) return 'dynamic boundary marker';
  return `untitled block #${i}`;
}

const tok = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const fileSize = (f) => (f && fs.existsSync(f) ? fs.statSync(f).size : null);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.project || process.cwd());
  const transcript = args.transcript || newestTranscript(root);
  const display = makeDisplay(root);
  const gitStatus = makeGitStatus(root);
  const plugins = resolvePlugins(root);

  const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const firstAssistant = lines.findIndex((o) => o.type === 'assistant' && !o.isSidechain);
  const head = lines.slice(0, firstAssistant);
  const att = (type) => head.filter((o) => o.attachment && o.attachment.type === type).map((o) => o.attachment);
  const one = (type) => att(type)[0];
  const usage = lines[firstAssistant].message.usage;
  const total = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;

  const parts = []; // { id, name, source, chars, measured, rows: [] }

  // P1 system prompt, per block
  const snap = one('prompt_snapshot') || lines.find((o) => o.attachment && o.attachment.type === 'prompt_snapshot').attachment;
  parts.push({
    id: 'P1', name: 'System prompt (harness core)', source: 'Claude Code binary', measured: 'exact text length',
    rows: snap.systemPrompt.map((b, i) => ({ item: heading(b, i), origin: 'Claude Code', chars: b.length })),
  });

  // P2 tool schemas: not in the transcript, only what was surfaced as loaded deferred tools
  const rec = one('deferred_tools_record');
  parts.push({
    id: 'P2', name: 'Tool definitions (JSON schemas)', source: 'Claude Code + MCP servers', measured: 'not in transcript → in Unallocated',
    rows: (rec ? rec.entries : []).map((e) => ({ item: e.name, origin: 'loaded deferred tool', chars: JSON.stringify(e).length })),
  });

  // P3 deferred tool names, grouped by MCP server
  const dtd = one('deferred_tools_delta');
  if (dtd) {
    const groups = {};
    dtd.addedLines.forEach((l, i) => {
      const n = dtd.addedNames[i];
      const m = /^mcp__(.+?)__/.exec(n);
      const g = m ? `MCP ${m[1]}` : 'Claude Code built-in';
      groups[g] = groups[g] || { n: 0, chars: 0 };
      groups[g].n++; groups[g].chars += l.length + 1;
    });
    parts.push({
      id: 'P3', name: `Deferred tool names (${dtd.addedNames.length})`, source: 'Claude Code + MCP servers', measured: 'exact list length',
      rows: Object.entries(groups).map(([g, v]) => ({ item: `${g} — ${v.n} names`, origin: g, chars: v.chars }))
        .concat((dtd.failedMcpServers || []).map((f) => ({ item: `MCP ${f.name} — FAILED (${f.errorCode})`, origin: 'MCP config', chars: 0 }))),
    });
  }

  // P4 MCP server instructions
  const mid = one('mcp_instructions_delta');
  if (mid) {
    parts.push({
      id: 'P4', name: 'MCP server instructions', source: 'MCP servers', measured: 'exact block length',
      rows: mid.addedNames.map((n, i) => ({ item: n, origin: 'MCP server', chars: mid.addedBlocks[i].length })),
    });
  }

  // P5 subagent types
  const ald = one('agent_listing_delta');
  if (ald) {
    parts.push({
      id: 'P5', name: `Subagent types (${ald.addedTypes.length})`, source: 'Claude Code + .claude/agents', measured: 'exact line length',
      rows: ald.addedTypes.map((t, i) => {
        const f = path.join(root, '.claude', 'agents', `${t}.md`);
        const file = fs.existsSync(f) ? f : null;
        return { item: t, origin: file ? 'project agent' : 'built-in', chars: ald.addedLines[i].length, file };
      }),
    });
  }

  // P6 skill listing
  const sl = one('skill_listing');
  if (sl) {
    const sizes = splitSkillListing(sl.content, sl.names);
    parts.push({
      id: 'P6', name: `Skill listing (${sl.skillCount})`, source: 'project / user / plugin / org / built-in', measured: 'exact per-skill listing length',
      rows: sl.names.map((n) => {
        const r = resolveSkill(n, root, plugins);
        return { item: n, origin: r.source, chars: sizes[n] || 0, file: r.file };
      }),
    });
  }

  // P7 instruction files
  const ins = one('instructions');
  const userClaude = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const insRows = ins ? ins.files.map((f) => ({ item: path.basename(f.path), origin: f.type, chars: f.content.length, file: f.path })) : [];
  if (!insRows.some((r) => r.origin === 'User')) insRows.push({ item: 'CLAUDE.md', origin: 'User — not present', chars: 0, file: userClaude });
  const rulesDir = path.join(root, '.claude', 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir).filter((x) => x.endsWith('.md'))) {
      insRows.push({ item: f, origin: 'rule — path-scoped, loaded on demand (not at start)', chars: 0, file: path.join(rulesDir, f) });
    }
  }
  parts.push({ id: 'P7', name: 'Instruction files', source: 'CLAUDE.md family + rules', measured: 'exact content length', rows: insRows });

  // P8 memory
  const memIndex = path.join(CLAUDE_DIR, 'projects', projectSlug(root), 'memory', 'MEMORY.md');
  parts.push({
    id: 'P8', name: 'Memory index', source: 'auto-memory dir', measured: 'file size',
    rows: [{ item: 'MEMORY.md', origin: fs.existsSync(memIndex) ? 'memory dir' : 'memory dir — not present', chars: 0, file: memIndex }],
  });

  // P9 session context reminders + small attachments
  const sc = one('session_context');
  const small = ['environment', 'model', 'language', 'date', 'auto_mode', 'remote_session_change'];
  const p9 = [];
  if (sc) for (const [k, v] of Object.entries(sc.context)) p9.push({ item: k, origin: k === 'gitStatus' ? 'git status at start' : 'account', chars: v.length });
  for (const t of small) {
    const a = one(t);
    if (a) p9.push({ item: t, origin: 'Claude Code (JSON size ≈ rendered)', chars: JSON.stringify(a).length });
  }
  parts.push({ id: 'P9', name: 'System reminders & environment', source: 'Claude Code runtime', measured: 'exact / ≈ for JSON-only attachments', rows: p9 });

  // P10 first user prompt
  const firstUser = head.filter((o) => o.type === 'user' && !o.isMeta && o.message && typeof o.message.content === 'string'
    && !o.message.content.startsWith('<'));
  const fu = firstUser[firstUser.length - 1];
  parts.push({ id: 'P10', name: 'First user prompt', source: 'user', measured: 'exact', rows: fu ? [{ item: 'prompt text', origin: 'user', chars: fu.message.content.length }] : [] });

  // enrich + totals
  for (const p of parts) {
    for (const r of p.rows) {
      if (r.file) { r.display = display(r.file); r.size = fileSize(r.file); r.git = gitStatus(r.file); }
      r.tokens = tok(r.chars);
    }
    p.chars = p.rows.reduce((s, r) => s + r.chars, 0);
    p.tokens = tok(p.chars);
  }
  const attributed = parts.reduce((s, p) => s + p.tokens, 0);
  const unallocated = total - attributed;

  print({ transcript, total, usage, parts, unallocated, display });
}

function pct(n, total) { return `${((100 * n) / total).toFixed(1)} %`; }

function print({ transcript, total, usage, parts, unallocated }) {
  const o = [];
  o.push(`Session: \`${path.basename(transcript, '.jsonl').slice(0, 4)}…\` (id shortened)`);
  o.push(`Total startup context (first API call): **${total} tokens** = input ${usage.input_tokens} + cache write ${usage.cache_creation_input_tokens} + cache read ${usage.cache_read_input_tokens}`);
  o.push(`Token estimate per part: chars / ${CHARS_PER_TOKEN}\n`);

  // partition bar, 100 cells
  const all = parts.concat([{ id: 'U', tokens: unallocated }]);
  let bar = '';
  for (const p of all) bar += (p.id === 'U' ? '░' : p.id.slice(1) % 2 ? '█' : '▓').repeat(Math.max(p.tokens > 0 ? 1 : 0, Math.round((100 * p.tokens) / total)));
  o.push('```');
  o.push(`|${bar}|`);
  o.push(all.filter((p) => p.tokens > 0).map((p) => `${p.id} ${pct(p.tokens, total)}`).join('  '));
  o.push('```\n');

  o.push('## Partition table\n');
  o.push('| # | Partition | Source | Chars | ≈ Tokens | Share | Measured |');
  o.push('|---|---|---|---:|---:|---:|---|');
  for (const p of parts) o.push(`| ${p.id} | ${p.name} | ${p.source} | ${p.chars} | ${p.tokens} | ${pct(p.tokens, total)} | ${p.measured} |`);
  o.push(`| U | **Unallocated** (tool schemas, wrappers, tags) | Claude Code | — | ${unallocated} | ${pct(unallocated, total)} | total − attributed |`);
  o.push(`| | **Total** | | | ${total} | 100 % | API usage (exact) |\n`);

  for (const p of parts) {
    if (!p.rows.length) continue;
    o.push(`### ${p.id} ${p.name}\n`);
    const withFiles = p.rows.some((r) => r.file);
    o.push(withFiles ? '| Item | Origin | Chars | ≈ Tokens | File | File size, B | Git |' : '| Item | Origin | Chars | ≈ Tokens |');
    o.push(withFiles ? '|---|---|---:|---:|---|---:|---|' : '|---|---|---:|---:|');
    for (const r of p.rows) {
      o.push(withFiles
        ? `| ${r.item} | ${r.origin} | ${r.chars} | ${r.tokens} | ${r.display ? `\`${r.display}\`` : '—'} | ${r.size === null || r.size === undefined ? '—' : r.size} | ${r.git || '—'} |`
        : `| ${r.item} | ${r.origin} | ${r.chars} | ${r.tokens} |`);
    }
    o.push('');
  }
  process.stdout.write(o.join('\n') + '\n');
}

try {
  main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`anatomy: ${err.message}\n`);
  process.exit(1);
}
