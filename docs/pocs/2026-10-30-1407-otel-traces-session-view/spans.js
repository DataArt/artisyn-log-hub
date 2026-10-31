// Prints the spans captured in out/traces.jsonl as an indented tree per trace (start offset,
// duration, name, selected attributes), then the set of attribute keys seen per span name.
//
// Usage: node spans.js [--keys]
'use strict';

const path = require('path');
const { loadSpans } = require('./otlp');

const SHOW = ['session.id', 'prompt.id', 'query_source', 'model', 'tool_name', 'agent_id', 'agent.name',
  'span.type', 'decision', 'success', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'hook_event', 'llm_request.context', 'parent.source'];

try {
  const spans = loadSpans(path.join(__dirname, 'out', 'traces.jsonl'));
  if (process.argv.includes('--keys')) {
    const keys = {};
    for (const s of spans) {
      keys[s.name] = keys[s.name] || new Set();
      for (const k of Object.keys(s.attrs)) keys[s.name].add(k);
    }
    for (const [name, set] of Object.entries(keys)) process.stdout.write(`${name}: ${[...set].sort().join(', ')}\n`);
    process.stdout.write(`resource: ${JSON.stringify(spans[0] && spans[0].resource)}\n`);
    process.exit(0);
  }
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const traces = new Map();
  for (const s of spans) {
    if (!traces.has(s.traceId)) traces.set(s.traceId, []);
    traces.get(s.traceId).push(s);
  }
  for (const [traceId, list] of traces) {
    const t0 = Math.min(...list.map((s) => s.start));
    process.stdout.write(`\ntrace ${traceId} (${list.length} spans)\n`);
    const children = new Map();
    for (const s of list) {
      const p = byId.has(s.parentSpanId) ? s.parentSpanId : '';
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(s);
    }
    const walk = (parent, depth) => {
      for (const s of (children.get(parent) || []).sort((a, b) => a.start - b.start)) {
        const shown = SHOW.filter((k) => k in s.attrs).map((k) => `${k}=${s.attrs[k]}`).join(' ');
        const orphan = s.parentSpanId && !byId.has(s.parentSpanId) ? ' [parent not captured]' : '';
        process.stdout.write(`${'  '.repeat(depth)}+${s.start - t0}ms ${s.end - s.start}ms ${s.name}${orphan} ${shown}\n`);
        walk(s.spanId, depth + 1);
      }
    };
    walk('', 0);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`spans error: ${err.message}\n`);
  process.exit(1);
}
