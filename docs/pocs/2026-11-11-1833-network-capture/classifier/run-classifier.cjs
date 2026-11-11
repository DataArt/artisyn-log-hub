'use strict';
// Q5: classifier precision / recall on fixtures.json, then (optional) aggregate counts over local
// Claude Code transcripts. Usage (from the PoC folder):
//   node classifier/run-classifier.cjs                 fixtures only
//   node classifier/run-classifier.cjs --transcripts   also scan <home>/.claude/projects (aggregates only)
// Prints only aggregate numbers for the transcripts: never paths, hostnames or command texts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { classifyCommand } = require('./classify-net.cjs');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
let tp = 0;
let fp = 0;
let fn = 0;
const misses = [];
for (const [i, f] of fixtures.entries()) {
  const got = classifyCommand(f.command, f.shell).map((r) => `${r.kind}|${r.host}`);
  const exp = f.expected.map((r) => `${r.kind}|${r.host}`);
  const left = [...got];
  for (const e of exp) {
    const k = left.indexOf(e);
    if (k !== -1) { tp++; left.splice(k, 1); } else { fn++; misses.push(`#${i + 1} missed ${e}`); }
  }
  fp += left.length;
  for (const l of left) misses.push(`#${i + 1} extra  ${l}`);
}
console.log(`fixtures: ${fixtures.length} commands, ${tp + fn} expected accesses`);
console.log(`TP=${tp} FP=${fp} FN=${fn} precision=${(tp / (tp + fp)).toFixed(3)} recall=${(tp / (tp + fn)).toFixed(3)}`);
for (const m of misses) console.log('  ' + m);

if (process.argv.includes('--transcripts')) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  (function walk(d, depth) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { try { files.push({ p, m: fs.statSync(p).mtimeMs }); } catch { /* skip */ } }
    }
  })(root, 0);
  files.sort((a, b) => b.m - a.m);
  const sample = files.slice(0, 400);
  const byKind = {};
  const byTool = {};
  let cmds = 0;
  let netCmds = 0;
  let accesses = 0;
  let hostKnown = 0;
  let loopback = 0;
  let privateIp = 0;
  let maxCmdLen = 0;
  const cmdLens = [];
  const urlLens = [];
  const t0 = performance.now();
  for (const { p } of sample) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_use"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const c of content) {
        if (c.type !== 'tool_use' || (c.name !== 'Bash' && c.name !== 'PowerShell') || !c.input || typeof c.input.command !== 'string') continue;
        cmds++;
        cmdLens.push(c.input.command.length);
        maxCmdLen = Math.max(maxCmdLen, c.input.command.length);
        const recs = classifyCommand(c.input.command, c.name === 'PowerShell' ? 'powershell' : 'bash');
        if (recs.length) netCmds++;
        for (const r of recs) {
          accesses++;
          if (r.host) hostKnown++;
          if (r.host && /^(localhost|127.|::1$|0.0.0.0$)/.test(r.host)) loopback++;
          else if (r.host && /^(10.|192.168.|172.(1[6-9]|2d|3[01]).)/.test(r.host)) privateIp++;
          if (r.url) urlLens.push(r.url.length);
          byKind[r.kind] = (byKind[r.kind] || 0) + 1;
          byTool[r.tool] = (byTool[r.tool] || 0) + 1;
        }
      }
    }
  }
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; };
  console.log(`\ntranscripts: ${sample.length} most recent files of ${files.length}; scanned in ${Math.round(performance.now() - t0)} ms`);
  console.log(`shell commands=${cmds} with network access=${netCmds} (${(100 * netCmds / Math.max(1, cmds)).toFixed(1)}%) accesses=${accesses} hostKnown=${hostKnown} loopback=${loopback} privateLan=${privateIp}`);
  console.log('by kind: ' + JSON.stringify(byKind));
  console.log('by tool: ' + JSON.stringify(byTool));
  console.log(`command length p50=${pct(cmdLens, 0.5)} p95=${pct(cmdLens, 0.95)} p99=${pct(cmdLens, 0.99)} max=${maxCmdLen}`);
  console.log(`url length p50=${pct(urlLens, 0.5)} p95=${pct(urlLens, 0.95)} max=${pct(urlLens, 1)}`);
}
