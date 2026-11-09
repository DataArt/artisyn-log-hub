#!/usr/bin/env node
// Feeds fixtures/bg-mcp.transcript.jsonl through a minimal re-implementation of Log Hub's
// current tool_use -> tool_result pairing (first tool_result per tool_use_id wins; status from
// is_error; duration = toolUseResult.durationMs | totalDurationMs | timestamp delta — see
// server/src/logs/tool-stats.ts resolveToolDuration and tool-monitoring/mcp-call-extractor.ts),
// then applies the proposed background-MCP join and prints both views side by side.
// Also shows that the async-agent join in workflow-extractor.ts (keyed on <tool-use-id>) finds
// nothing, because an MCP task notification carries only <task-id>.
// Usage: node pairing-demo.cjs [transcript.jsonl]
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, 'fixtures', 'bg-mcp.transcript.jsonl');
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
}
function text(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

const calls = [];
const results = new Map();
const notifications = [];
for (const e of lines) {
  const content = e.message && e.message.content;
  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, ts: Date.parse(e.timestamp) });
  }
  if (e.type === 'user' && Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'tool_result' && !results.has(b.tool_use_id)) {
        results.set(b.tool_use_id, { isError: b.is_error === true, text: text(b.content), ts: Date.parse(e.timestamp), tur: e.toolUseResult });
      }
    }
  }
  if (e.type === 'user' && typeof content === 'string' && content.trimStart().startsWith('<task-notification>')) {
    notifications.push({ ts: Date.parse(e.timestamp), xml: content, origin: e.origin });
  }
}

// 1) Current Log Hub view
process.stdout.write('== current pairing (as Log Hub does it today)\n');
for (const c of calls.filter((x) => x.name.startsWith('mcp__'))) {
  const r = results.get(c.id);
  const tur = r && r.tur && !Array.isArray(r.tur) ? r.tur : null;
  const dur = tur && typeof tur.durationMs === 'number' ? tur.durationMs : r ? r.ts - c.ts : null;
  process.stdout.write(`${c.name} ${c.id}\n  status=${r ? (r.isError ? 'error' : 'ok') : 'no_result'} duration=${dur} ms (timestampDelta)\n  agent-saw="${r ? r.text.slice(0, 90) : ''}..."\n`);
}

// 2) Async-agent join of workflow-extractor.ts: keyed on <tool-use-id>
const withToolUseId = notifications.filter((n) => tag(n.xml, 'tool-use-id') !== null);
process.stdout.write(`\n== workflow-extractor join: notifications with <tool-use-id>: ${withToolUseId.length} of ${notifications.length}\n`);

// 3) Proposed join: task id from the ack text <-> <task-id> of the notification
const ACK = /moved to the background as task ([A-Za-z0-9_-]+)/;
const byTaskId = new Map(notifications.map((n) => [tag(n.xml, 'task-id'), n]));
process.stdout.write('\n== proposed join (ack text task id -> <task-id>)\n');
for (const c of calls.filter((x) => x.name.startsWith('mcp__'))) {
  const r = results.get(c.id);
  const m = r && ACK.exec(r.text);
  if (!m) { process.stdout.write(`${c.id}: not backgrounded\n`); continue; }
  const n = byTaskId.get(m[1]);
  if (!n) { process.stdout.write(`${c.id}: backgrounded as ${m[1]}, no notification -> status running/lost\n`); continue; }
  const status = tag(n.xml, 'status');
  process.stdout.write(`${c.id}: task=${m[1]} status=${status} -> ${status === 'completed' ? 'ok' : 'error'}\n`
    + `  duration=${n.ts - c.ts} ms (tool_use -> notification; ack after ${r.ts - c.ts} ms)\n`
    + `  real result="${tag(n.xml, 'result')}"\n  notification origin=${JSON.stringify(n.origin)}\n`);
}
process.exit(0);
