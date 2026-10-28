// POC: unified "tool invocation log" from Claude Code transcripts.
//   node extract.mjs <transcript.jsonl>... [--shim out/tool-calls.jsonl] [--json out/report.json]
//   node extract.mjs --prod [--json ...]   (reads claude/claude-subagent logs from a local docker-compose Log Hub DB)
// Covers MCP calls (mcp__<server>__<tool>) and CLI tools run through Bash/PowerShell that
// match the REGISTRY below. Joins wrapper (shim) records when given, and derives usefulness signals.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// What counts as a "tool" in a shell command. Capture group 1 = subcommand.
const REGISTRY = [
  { tool: 'ce', re: /(?:^|[;&|(]\s*)ce\s+([a-z][\w-]*)?/ },
];
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FOLLOW_WINDOW = 3; // tool calls after the invocation inspected for usefulness signals

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : null; };
const shimPath = opt('--shim');
const jsonOut = opt('--json');
const prod = argv.includes('--prod');
if (prod) argv.splice(argv.indexOf('--prod'), 1);

/** @returns {Array<{stream:string, events:object[]}>} */
function loadStreams() {
  if (prod) {
    const sql = `SELECT json_build_object('stream', l.log_type || ':' || l.session_id || ':' || l.id, 'events', l.body)
      FROM logs l WHERE l.log_type IN ('claude','claude-subagent')
      AND (l.body::text LIKE '%"name": "mcp\\_\\_%' OR l.body::text ~ '"command": "[^"]*\\mce ')`;
    const raw = execFileSync('docker', ['exec', '-i', 'artisyn-log-hub-db', 'psql', '-U', 'postgres', '-d', 'a-log', '-At', '-c', sql],
      { maxBuffer: 1 << 30, encoding: 'utf8' });
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return argv.map((f) => ({
    stream: f,
    events: readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }),
  }));
}

function classify(name, input) {
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return { source: 'mcp', tool: server, sub: rest.join('__') };
  }
  if (SHELL_TOOLS.has(name) && typeof input?.command === 'string') {
    for (const r of REGISTRY) {
      const m = input.command.match(r.re);
      if (m) return { source: name.toLowerCase(), tool: r.tool, sub: m[1] || '(none)' };
    }
  }
  return null;
}

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? `[${b.type}]`).join('\n') : '';

function extract({ stream, events }) {
  const calls = []; // every tool_use in order, interesting or not (needed for follow-up signals)
  const results = new Map();
  for (const ev of events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (ev.type === 'assistant' && b.type === 'tool_use') calls.push({ id: b.id, name: b.name, input: b.input, ts: ev.timestamp, session: ev.sessionId, agentId: ev.agentId });
      if (ev.type === 'user' && b.type === 'tool_result') results.set(b.tool_use_id, { b, ts: ev.timestamp, tur: ev.toolUseResult });
    }
  }
  const out = [];
  calls.forEach((c, i) => {
    const k = classify(c.name, c.input);
    if (!k) return;
    const r = results.get(c.id);
    const tur = r?.tur && typeof r.tur === 'object' ? r.tur : null;
    const seen = tur && 'stdout' in tur ? tur.stdout + (tur.stderr ? '\n' + tur.stderr : '') : textOf(r?.b?.content);
    const cmd = c.input?.command;
    const inv = {
      stream, session: c.session, agentId: c.agentId ?? null, callId: c.id, ...k,
      input: cmd ?? c.input, ts: c.ts,
      durationMs: r?.ts && c.ts ? Date.parse(r.ts) - Date.parse(c.ts) : null,
      isError: r?.b?.is_error === true, hasResult: !!r,
      seenChars: seen?.length ?? 0, seen,
      // what the agent saw may be less than what the tool produced:
      piped: !!cmd && /\bce\b[^|]*\|/.test(cmd),
      persisted: !!tur?.persistedOutputPath, interrupted: !!tur?.interrupted,
    };
    // usefulness signals from the next FOLLOW_WINDOW calls
    const next = calls.slice(i + 1, i + 1 + FOLLOW_WINDOW);
    const paths = new Set([...(seen || '').matchAll(/[\w./\\-]+\.(?:java|cs|ts|tsx|js|go|kt)\b/g)].map((m) => m[0].split(/[\\/]/).pop()));
    inv.signals = {
      retriedSameTool: next.some((n) => { const nk = classify(n.name, n.input); return nk?.tool === k.tool && nk.sub === k.sub; }),
      fellBackToSearch: next.some((n) => ['Grep', 'Glob'].includes(n.name) || /\b(grep|rg|findstr|Select-String)\b/.test(n.input?.command || '')),
      openedFileFromOutput: next.some((n) => ['Read', 'Edit'].includes(n.name) && paths.has(String(n.input?.file_path || '').split(/[\\/]/).pop())),
      emptyResult: /no (callers|identifiers|results)|not found|0 results/i.test(seen || '') || (seen || '').trim() === '',
    };
    out.push(inv);
  });
  return out;
}

function joinShim(invs) {
  if (!shimPath || !existsSync(shimPath)) return;
  const recs = readFileSync(shimPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const inv of invs.filter((x) => x.source !== 'mcp')) {
    const t = Date.parse(inv.ts);
    const rec = recs.find((r) => !r._used && r.session_id === inv.session && r.tool === inv.tool
      && (r.args[0] ?? '(none)') === inv.sub && Math.abs(Date.parse(r.ts) - t) < 60_000);
    if (!rec) continue;
    rec._used = true;
    inv.shim = { exitCode: rec.exit_code, toolMs: rec.duration_ms, producedChars: rec.stdout.length + rec.stderr.length };
    inv.visibility = inv.shim.producedChars ? +(Math.min(inv.seenChars, inv.shim.producedChars) / inv.shim.producedChars).toFixed(2) : 1;
  }
}

const invs = loadStreams().flatMap(extract);
joinShim(invs);

// ---- summary per tool/subcommand
const groups = new Map();
for (const v of invs) {
  const key = `${v.source}:${v.tool}:${v.sub}`;
  const g = groups.get(key) ?? { key, calls: 0, errors: 0, noResult: 0, empty: 0, retried: 0, fallback: 0, opened: 0, piped: 0, persisted: 0, chars: 0, ms: [] };
  g.calls++; g.errors += v.isError; g.noResult += !v.hasResult; g.empty += v.signals.emptyResult;
  g.retried += v.signals.retriedSameTool; g.fallback += v.signals.fellBackToSearch; g.opened += v.signals.openedFileFromOutput;
  g.piped += v.piped; g.persisted += v.persisted; g.chars += v.seenChars; if (v.durationMs != null) g.ms.push(v.durationMs);
  groups.set(key, g);
}
const median = (a) => a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null;
console.table([...groups.values()].sort((a, b) => b.calls - a.calls).slice(0, 25).map((g) => ({
  'tool:sub': g.key, calls: g.calls, err: g.errors, empty: g.empty, retry: g.retried, fallback: g.fallback,
  openedFile: g.opened, piped: g.piped, persisted: g.persisted, avgChars: Math.round(g.chars / g.calls), medMs: median(g.ms),
})));
if (!prod) for (const v of invs) {
  console.log(`\n# ${v.ts} ${v.source} ${v.tool} ${v.sub}  ${v.durationMs}ms  err=${v.isError}  seen=${v.seenChars}ch`
    + (v.shim ? `  exit=${v.shim.exitCode} produced=${v.shim.producedChars}ch visibility=${v.visibility}` : ''));
  console.log(`  input: ${typeof v.input === 'string' ? v.input : JSON.stringify(v.input)}`);
  console.log(`  signals: ${JSON.stringify(v.signals)}`);
  console.log(`  output: ${(v.seen || '').replace(/\s+/g, ' ').slice(0, 160)}…`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(invs, null, 2));
