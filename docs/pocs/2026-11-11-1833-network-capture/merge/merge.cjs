'use strict';
// Q8(d) + Q6: merge whatever sources exist for one session into FR-1 records, never failing on a
// missing or damaged source, with a coverage line. Also applies the FR-11 excerpt caps and reports
// the stored size per record.
//   mergeSession({ transcriptFile?, tapDirs?: string[], logHubOrigins?: string[] }) -> { records, coverage, hidden }
const fs = require('node:fs');
const path = require('node:path');
const { classifyCommand } = require('../classifier/classify-net.cjs');

const CAP = { url: 512, query: 256, command: 300, path: 256, host: 253 };
const MAX_RECORDS = 2000; // per session tree
function excerpt(s, max) {
  if (s == null) return undefined;
  const t = String(s);
  return t.length <= max ? t : `${t.slice(0, max)}… [truncated, ${Buffer.byteLength(t)} bytes total]`;
}
const unknown = (v) => (v === undefined || v === null || Number.isNaN(v) ? 'unknown' : v);

function* readJsonl(file, cov) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { cov.unreadable++; return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { cov.malformedLines++; }
  }
}

function fromTranscript(file, cov) {
  const out = [];
  for (const o of readJsonl(file, cov)) {
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of content) {
      if (!c || c.type !== 'tool_use' || !c.input) continue;
      const base = { source: 'transcript', toolUseId: c.id, ts: o.timestamp, durMs: 'unknown', bytesIn: 'unknown', bytesOut: 'unknown', status: 'unknown', group: 'agent' };
      if (c.name === 'WebSearch') out.push({ ...base, kind: 'search', host: 'unknown', query: excerpt(c.input.query, CAP.query) });
      else if (c.name === 'WebFetch') {
        let host = 'unknown';
        try { host = new URL(c.input.url).hostname; } catch { /* keep unknown */ }
        out.push({ ...base, kind: 'fetch', host, url: excerpt(c.input.url, CAP.url) });
      } else if (c.name === 'Bash' || c.name === 'PowerShell') {
        for (const r of classifyCommand(c.input.command, c.name === 'PowerShell' ? 'powershell' : 'bash')) {
          out.push({ ...base, kind: r.kind, host: unknown(r.host), port: r.port, url: excerpt(r.url, CAP.url), command: excerpt(c.input.command, CAP.command), inferred: r.inferred || undefined });
        }
      } else if (c.name.startsWith('mcp__')) {
        out.push({ ...base, kind: 'mcp', host: 'unknown', mcpServer: c.name.split('__')[1] });
      }
    }
  }
  return out;
}

function fromTap(dir, cov) {
  const out = [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { cov.missingTapDirs++; return out; }
  for (const f of files) {
    let proc = {};
    for (const r of readJsonl(path.join(dir, f), cov)) {
      if (r.t === 'proc') { proc = r; continue; }
      if (r.t === 'truncated' || r.t === 'summary') { cov.truncatedProcesses += r.t === 'truncated' ? 1 : 0; continue; }
      if (!r.host) continue;
      const lang = proc.lang === 'python' ? 'python-tap' : 'node-tap';
      out.push({
        source: lang, kind: r.t === 'socket' || r.t === 'connect' ? 'socket' : 'http', host: excerpt(r.host, CAP.host), port: unknown(r.port),
        method: r.method, path: excerpt(r.path, CAP.path), status: unknown(r.status), bytesIn: unknown(r.bytesIn), bytesOut: unknown(r.bytesOut),
        durMs: unknown(r.durMs), phases: r.phases, ts: r.ts ? new Date(r.ts).toISOString() : 'unknown',
        process: excerpt(proc.script, 128) || 'unknown', group: r.role === 'service' ? 'service' : 'agent',
      });
    }
    cov.tapFiles++;
  }
  return out;
}

function mergeSession({ transcriptFile, tapDirs = [], logHubOrigins = [] }) {
  const cov = { transcript: 'missing', nodeTap: 'missing', pythonTap: 'missing', wrapper: 'missing', malformedLines: 0, unreadable: 0, missingTapDirs: 0, tapFiles: 0, truncatedProcesses: 0 };
  let records = [];
  if (transcriptFile && fs.existsSync(transcriptFile)) { const t = fromTranscript(transcriptFile, cov); cov.transcript = t.length; records.push(...t); }
  for (const d of tapDirs) records.push(...fromTap(d, cov));
  const n = (s) => records.filter((r) => r.source === s).length;
  if (n('node-tap')) cov.nodeTap = n('node-tap');
  if (n('python-tap')) cov.pythonTap = n('python-tap');
  // Server-side Log Hub self-traffic filter (second line of defence after the taps' own exclusion).
  const lh = new Set(logHubOrigins.map((o) => { try { const u = new URL(o); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; } catch { return o; } }));
  const isLh = (r) => lh.has(`${r.host}:${r.port}`);
  const hidden = { logHub: records.filter(isLh).length, service: 0 };
  records = records.filter((r) => !isLh(r));
  hidden.service = records.filter((r) => r.group === 'service').length;
  if (records.length > MAX_RECORDS) { cov.droppedRecords = records.length - MAX_RECORDS; records = records.slice(0, MAX_RECORDS); }
  return { records, coverage: cov, hidden };
}

module.exports = { mergeSession, excerpt, CAP };
