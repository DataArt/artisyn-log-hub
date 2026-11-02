#!/usr/bin/env node
// Extracts one Log Hub session tree (root + workflow runs + sub-agents + tool calls) from the
// local dev database into a sanitized data.json for the 3D "session galaxy" view.
//
// Usage (from this folder):
//   node extract.js --session <root session uuid> [--container log-hub-postgres] [--out data.js]
//
// Reads the database name and user from <repo>/server/.env (DATABASE_URL) and runs psql inside
// the Postgres container, so no npm dependency is needed.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = { container: 'log-hub-postgres', out: 'data.js' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
    i++;
  }
  return args;
}

function readDbTarget() {
  const envFile = path.resolve(__dirname, '../../../server/.env');
  const text = fs.readFileSync(envFile, 'utf8');
  const m = text.match(/^DATABASE_URL=postgres(?:ql)?:\/\/([^:@\s]+)(?::[^@\s]*)?@[^/\s]+\/([^?\s]+)/m);
  if (!m) throw new Error('DATABASE_URL not found in server/.env');
  return { user: m[1], db: m[2] };
}

function psqlJson(container, target, sql) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', target.user, '-d', target.db,
    '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('psql failed: ' + (r.stderr || r.error));
  return JSON.parse(r.stdout.trim() || 'null');
}

function treeSql(rootUuid) {
  if (!/^[0-9a-f-]{36}$/i.test(rootUuid)) throw new Error('--session must be a session uuid');
  return `
with recursive tree as (
  select s.id, s.session_id, s.parent_session_id, s.workflow_run_id, 0 as depth
  from sessions s where s.session_id = '${rootUuid}' and not s.deleted
  union all
  select c.id, c.session_id, c.parent_session_id, c.workflow_run_id, t.depth + 1
  from sessions c join tree t on c.parent_session_id = t.session_id
  where not c.deleted and t.depth < 20
)
select json_agg(json_build_object(
  'sid', t.session_id, 'parent', t.parent_session_id, 'wf', t.workflow_run_id,
  'cost', sc.cost, 'model', sc.model_id,
  'prompt', (select l.first_prompt from logs l where l.session_id = t.id and l.log_type = 'artisyn' limit 1),
  'body', (select l.body from logs l where l.session_id = t.id and l.log_type in ('claude', 'claude-subagent')
           order by l.log_type limit 1)
) order by t.depth, t.id)
from tree t left join session_costs sc on sc.session_id = t.id;`;
}

// ---- sanitizing: never ship absolute paths of the machine the session ran on ----

function makeSanitizer(rootBodies) {
  const roots = new Set();
  for (const body of rootBodies) {
    for (const line of body || []) {
      if (line && typeof line.cwd === 'string') roots.add(line.cwd);
    }
  }
  const variants = [];
  for (const r of roots) {
    const fwd = r.replace(/\\/g, '/');
    variants.push(r, fwd, fwd.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()));
  }
  variants.sort((a, b) => b.length - a.length);
  return function sanitize(s) {
    let out = String(s);
    for (const v of variants) out = out.split(v + '\\').join('').split(v + '/').join('').split(v).join('.');
    out = out.replace(/[A-Za-z]:[\\/][^\s"'`]*/g, (p) => '<abs>/' + path.basename(p.replace(/\\/g, '/')));
    out = out.replace(/\/(?:home|Users)\/[^\s"'`]*/g, (p) => '<abs>/' + path.basename(p));
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>');
    // Process ids of the machine the session ran on.
    out = out.replace(/(\$p(?:id)?\s*=\s*|-Id\s+|\/PID\s+|\bpid[=:\s]\s*|ProcessId\s*-eq\s*|kill\s+(?:-9\s+)?)\d{2,7}\b/gi, '$1<pid>');
    return out.replace(/\s+/g, ' ').trim();
  };
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function summarize(name, input, sanitize) {
  const i = input || {};
  const file = i.file_path || i.notebook_path || i.path;
  if (/^(Read|Edit|Write|NotebookEdit|MultiEdit)$/.test(name) && file) return path.basename(String(file).replace(/\\/g, '/'));
  if (name === 'Bash' || name === 'PowerShell') return cut(sanitize(String(i.command || '').split('\n')[0]), 48);
  if (name === 'Grep') return cut('/' + sanitize(i.pattern || '') + '/', 40);
  if (name === 'Glob') return cut(sanitize(i.pattern || ''), 40);
  if (name === 'Skill') return String(i.skill || '');
  if (name === 'Agent' || name === 'Task') return cut(sanitize(i.description || ''), 48);
  if (name === 'Workflow') return String(i.name || 'workflow script');
  if (name === 'WebFetch') { try { return new URL(i.url).hostname; } catch { return ''; } }
  if (name === 'WebSearch') return cut(sanitize(i.query || ''), 40);
  return '';
}

function shortToolName(name) {
  const m = name.match(/^mcp__.+?__(.+)$/);
  return m ? 'mcp:' + m[1] : name;
}

// Token weight used only to spread a session's stored cost over its calls for the replay.
function usageWeight(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) +
    0.1 * (u.cache_read_input_tokens || 0) + 5 * (u.output_tokens || 0);
}

function parseBody(body, sanitize) {
  const events = [];
  const byToolId = new Map();
  const seenMsg = new Set();
  const spawned = [];
  let ctxPeak = 0;
  let firstPrompt = null;
  let promptText = '';
  let userStrings = 0;
  for (const line of body || []) {
    if (!line || !line.timestamp) continue;
    const t = Date.parse(line.timestamp);
    const content = line.message && Array.isArray(line.message.content) ? line.message.content : [];
    if (line.type === 'user' && typeof (line.message || {}).content === 'string' && userStrings < 3) {
      userStrings++;
      if (firstPrompt === null) firstPrompt = line.message.content;
      promptText += '\n' + line.message.content;
    }
    if (line.type === 'assistant') {
      const msg = line.message || {};
      let w = 0;
      if (msg.id && !seenMsg.has(msg.id)) {
        seenMsg.add(msg.id);
        w = usageWeight(msg.usage);
        const u = msg.usage || {};
        ctxPeak = Math.max(ctxPeak, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
      }
      const tools = content.filter((c) => c.type === 'tool_use');
      if (tools.length === 0 && w > 0) events.push({ t, k: 'turn', w });
      tools.forEach((c, idx) => {
        const ev = { t, k: 'tool', n: shortToolName(c.name), x: summarize(c.name, c.input, sanitize), w: idx === 0 ? w : 0 };
        events.push(ev);
        byToolId.set(c.id, { ev, input: c.input, name: c.name });
      });
    }
    if (line.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const call = byToolId.get(c.tool_use_id);
        if (!call) continue;
        if (c.is_error) call.ev.err = 1;
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
        const tur = line.toolUseResult || {};
        if (call.name === 'Workflow') {
          const m = (text + JSON.stringify(tur)).match(/wf_[0-9a-f]{8}-[0-9a-f]{3}/);
          if (m) spawned.push({ kind: 'wf', runId: m[0], t: call.ev.t, label: summarize('Workflow', call.input, sanitize), args: (call.input || {}).args });
        }
        if ((call.name === 'Agent' || call.name === 'Task') && tur.agentId) {
          spawned.push({ kind: 'agent', agentId: 'agent-' + tur.agentId, label: summarize('Agent', call.input, sanitize) });
        }
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, spawned, ctxPeak, firstPrompt, promptText };
}

// Label of a workflow-spawned agent, read from the task text the workflow script computed for it.
function workflowAgentLabel(text) {
  const chunk = text.match(/Your chunk\s*[—-]\s*(Chunk[^\n]{0,60})/);
  if (chunk) return chunk[1].trim();
  const check = text.match(/###\s*Check\s*\n\s*-\s*Name:\s*([^\n]+)/);
  if (check) return 'check: ' + check[1].trim();
  return null;
}

function workflowKind(args) {
  if (args && Array.isArray(args.chunks)) return 'Implement plan';
  if (args && Array.isArray(args.checks)) return 'Health checks';
  return 'Workflow';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) throw new Error('--session <root session uuid> is required');
  const rows = psqlJson(args.container, readDbTarget(), treeSql(args.session));
  if (!rows || rows.length === 0) throw new Error('session not found');
  const sanitize = makeSanitizer([rows[0].body]);

  const nodes = [];
  const wfHubs = new Map();
  const agentLabels = new Map();
  const root = rows[0];
  const rootParsed = parseBody(root.body, sanitize);
  for (const s of rootParsed.spawned) {
    if (s.kind === 'wf' && !wfHubs.has(s.runId)) {
      wfHubs.set(s.runId, s);
    }
    if (s.kind === 'agent') agentLabels.set(s.agentId, s.label);
  }
  const prompt = cut(sanitize(String(root.prompt || rootParsed.firstPrompt || '').split('\n')[0]), 80);
  nodes.push({ id: root.sid.slice(0, 8), kind: 'root', label: prompt, cost: root.cost || 0, model: root.model,
    ctx: rootParsed.ctxPeak, ev: rootParsed.events });

  const idOf = (sid) => (sid === root.sid ? root.sid.slice(0, 8) : sid.replace(/^agent-/, '').slice(0, 10));
  let wfIndex = 0;
  for (const [runId, s] of wfHubs) {
    wfIndex++;
    nodes.push({ id: runId, kind: 'wf', parent: idOf(root.sid), label: `${workflowKind(s.args)} #${wfIndex}`, t0: s.t });
  }
  for (const r of rows.slice(1)) {
    const parsed = parseBody(r.body, sanitize);
    const parent = r.wf && wfHubs.has(r.wf) ? r.wf : idOf(r.parent || root.sid);
    if (r.wf && !wfHubs.has(r.wf)) {
      wfHubs.set(r.wf, { t: parsed.events.length ? parsed.events[0].t : 0 });
      nodes.push({ id: r.wf, kind: 'wf', parent: idOf(root.sid), label: 'Workflow', t0: wfHubs.get(r.wf).t });
    }
    let label = agentLabels.get(r.sid);
    if (!label) {
      const wl = workflowAgentLabel(parsed.promptText);
      if (wl) label = cut(sanitize(wl), 40);
    }
    nodes.push({ id: idOf(r.sid), kind: 'agent', parent, label: label || 'agent', cost: r.cost || 0, model: r.model,
      ctx: parsed.ctxPeak, ev: parsed.events });
  }
  // Workflow hub labels: name of the run + item count.
  for (const n of nodes) {
    if (n.kind !== 'wf') continue;
    const kids = nodes.filter((c) => c.parent === n.id).length;
    n.label = `${n.label} · ${kids} agents`;
  }
  const out = { generatedAt: new Date().toISOString().slice(0, 10), nodes };
  // A script file (not JSON) so index.html works from file:// without a web server.
  fs.writeFileSync(path.resolve(__dirname, args.out), 'window.SESSION_GALAXY = ' + JSON.stringify(out) + ';\n');
  const calls = nodes.reduce((a, n) => a + (n.ev || []).filter((e) => e.k === 'tool').length, 0);
  process.stderr.write(`nodes: ${nodes.length}, tool calls: ${calls}, cost: $${nodes.reduce((a, n) => a + (n.cost || 0), 0).toFixed(2)}\n`);
  process.exit(0);
}

try {
  main();
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e) + '\n');
  process.exit(1);
}
