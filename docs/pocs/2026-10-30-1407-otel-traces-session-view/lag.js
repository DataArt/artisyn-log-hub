// Measures export latency per signal: for every captured OTLP request, how long after a record
// ended (span end / log record time) it reached the receiver. Prints one line per request and a
// per-signal summary (median / max of the per-record lag).
//
// Usage: node lag.js [traceId-or-session-prefix]
'use strict';

const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
const filter = process.argv[2] || '';

function nanosToMs(n) { return Number(BigInt(n) / 1000000n); }

function recordsOf(signal, body) {
  const out = [];
  if (signal === 'traces') {
    for (const rs of body.resourceSpans || []) for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) {
      const sid = (s.attributes || []).find((a) => a.key === 'session.id');
      out.push({ t: nanosToMs(s.endTimeUnixNano), key: `${s.traceId} ${sid ? sid.value.stringValue : ''}`, name: s.name });
    }
  } else if (signal === 'logs') {
    for (const rl of body.resourceLogs || []) for (const sl of rl.scopeLogs || []) for (const r of sl.logRecords || []) {
      const sid = (r.attributes || []).find((a) => a.key === 'session.id');
      out.push({ t: nanosToMs(r.timeUnixNano || r.observedTimeUnixNano), key: sid ? sid.value.stringValue : '', name: r.body && r.body.stringValue });
    }
  } else {
    for (const rm of body.resourceMetrics || []) for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
      const points = (m.sum || m.gauge || m.histogram || {}).dataPoints || [];
      for (const p of points) {
        const sid = (p.attributes || []).find((a) => a.key === 'session.id');
        out.push({ t: nanosToMs(p.timeUnixNano), key: sid ? sid.value.stringValue : '', name: m.name });
      }
    }
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

try {
  for (const signal of ['traces', 'logs', 'metrics']) {
    const file = path.join(outDir, `${signal}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const lags = [];
    process.stdout.write(`\n## ${signal}\n`);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const { receivedAt, body } = JSON.parse(line);
      const recv = Date.parse(receivedAt);
      const recs = recordsOf(signal, body).filter((r) => !filter || r.key.includes(filter));
      if (!recs.length) continue;
      const l = recs.map((r) => recv - r.t);
      lags.push(...l);
      process.stdout.write(`${receivedAt} ${String(recs.length).padStart(3)} records  lag min ${Math.min(...l)}ms max ${Math.max(...l)}ms\n`);
    }
    if (lags.length) process.stdout.write(`summary: ${lags.length} records, median lag ${median(lags)}ms, max ${Math.max(...lags)}ms\n`);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`lag error: ${err.message}\n`);
  process.exit(1);
}
