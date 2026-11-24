'use strict';
// Reads a receiver raw.ndjson and writes a sanitised inventory markdown: every log event with its
// count, attribute keys and one sample value per key; every span name likewise; metric names; and
// a checklist of the items the task asks about. Identifiers, emails, paths and free text are
// redacted, so the output can be committed.
// Usage: node analyze.js --raw <raw.ndjson> --label <claude version> --out <inventory.md>
const fs = require('fs');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const SECRET_KEY_RE = /(email|account|organization|user\.id|session|uuid|prompt|path|cwd|file|terminal|host|_id$|\.id$|^id$|trace|span_id|parent|request_id|repo|content|input$|output$|body|text|command|arguments|parameters|result|error$|message$|server_name|server_scope|transport_type|plugin\.name|size_bytes|plan$|seat_type|timestamp|hash)/i;
// Events whose count would describe the account (e.g. how many connectors it has).
const HIDE_COUNT_RE = /mcp_server_connection|plugin_loaded/;

function valueOf(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return '[array]';
  if ('kvlistValue' in v) return '[kvlist]';
  return '[?]';
}

function sample(key, v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return String(v);
  if (v === '<REDACTED>') return JSON.stringify(v);
  if (/size_bytes/i.test(key)) return '<redacted>';
  if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') return JSON.stringify(v);
  if (SECRET_KEY_RE.test(key)) return '<redacted>';
  if (/[\\/]|@/.test(v) || v.length > 48) return '<redacted>';
  return JSON.stringify(v);
}

function attrs(list) {
  const o = {};
  for (const a of list || []) o[a.key] = valueOf(a.value);
  return o;
}

function bump(map, name, a) {
  const e = map.get(name) || { count: 0, keys: new Map() };
  e.count += 1;
  for (const [k, v] of Object.entries(a)) {
    if (!e.keys.has(k)) e.keys.set(k, new Set());
    const s = e.keys.get(k);
    if (s.size < 4) s.add(sample(k, v));
  }
  map.set(name, e);
}

function table(map, title) {
  const out = [`## ${title}`, '', '| name | count | attribute = samples |', '|---|---|---|'];
  for (const [name, e] of [...map.entries()].sort()) {
    const keys = [...e.keys.entries()].sort().map(([k, s]) => `\`${k}\` = ${[...s].join(' / ')}`).join('<br>');
    out.push(`| \`${name}\` | ${HIDE_COUNT_RE.test(name) ? '<redacted>' : e.count} | ${keys} |`);
  }
  return out.join('\n') + '\n';
}

try {
  const rawFile = arg('--raw');
  const label = arg('--label');
  const outFile = arg('--out');
  if (!rawFile || !label || !outFile) throw new Error('usage: node analyze.js --raw <file> --label <ver> --out <md>');
  const logs = new Map();
  const spans = new Map();
  const metrics = new Map();
  const resKeys = new Set();
  for (const line of fs.readFileSync(rawFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { path: p, body } = JSON.parse(line);
    if (p.includes('/v1/logs')) {
      for (const rl of body.resourceLogs || []) {
        for (const k of Object.keys(attrs(rl.resource && rl.resource.attributes))) resKeys.add(k);
        for (const sl of rl.scopeLogs || []) {
          for (const r of sl.logRecords || []) {
            const a = attrs(r.attributes);
            const name = a['event.name'] || valueOf(r.body) || '?';
            bump(logs, name, a);
          }
        }
      }
    } else if (p.includes('/v1/traces')) {
      for (const rs of body.resourceSpans || []) {
        for (const ss of rs.scopeSpans || []) {
          for (const s of ss.spans || []) bump(spans, s.name, attrs(s.attributes));
        }
      }
    } else if (p.includes('/v1/metrics')) {
      for (const rm of body.resourceMetrics || []) {
        for (const sm of rm.scopeMetrics || []) {
          for (const m of sm.metrics || []) {
            const pts = (m.sum || m.gauge || m.histogram || {}).dataPoints || [];
            for (const dp of pts) bump(metrics, m.name, attrs(dp.attributes));
          }
        }
      }
    }
  }

  const has = (n) => [...logs.keys()].some((k) => k === n || k === `claude_code.${n}` || k.endsWith(`.${n}`));
  const logAttr = (ev, key) => {
    for (const [k, e] of logs) if ((k === ev || k.endsWith(`.${ev}`)) && e.keys.has(key)) return [...e.keys.get(key)].join(' / ');
    return null;
  };
  const spanAttr = (key) => {
    const found = [];
    for (const [n, e] of spans) for (const k of e.keys.keys()) if (k === key || k.startsWith(key)) found.push(`${n}: \`${k}\``);
    return found.length ? found.join(', ') : null;
  };
  const events = ['compaction', 'api_retries_exhausted', 'api_refusal', 'skill_activated', 'subagent_completed',
    'hook_registered', 'hook_execution_start', 'hook_execution_complete', 'hook_plugin_metrics',
    'permission_mode_changed', 'plugin_installed', 'internal_error', 'at_mention', 'feedback_survey',
    'managed_settings_resolved', 'retention_sweep', 'tool_decision', 'user_prompt', 'api_error', 'tool_result', 'api_request'];
  const check = ['## Checklist', '', '| item | arrived |', '|---|---|'];
  for (const e of events) check.push(`| event \`${e}\` | ${has(e) ? 'yes' : 'no'} |`);
  for (const k of ['classifier_verdict', 'classifier_category', 'permission_mode']) {
    check.push(`| \`tool_decision\` attr \`${k}\` | ${logAttr('tool_decision', k) || 'no'} |`);
  }
  check.push(`| \`user_prompt\` attr \`delivery.mode\` | ${logAttr('user_prompt', 'delivery.mode') || 'no'} |`);
  for (const k of ['gen_ai.response.model', 'gen_ai.operation.name', 'gen_ai.usage']) {
    check.push(`| span attr \`${k}\` | ${spanAttr(k) || 'no'} |`);
  }

  const md = [`# OTEL inventory — Claude Code ${label}`, '',
    `Resource attribute keys: ${[...resKeys].sort().map((k) => `\`${k}\``).join(', ')}`, '',
    check.join('\n') + '\n', table(logs, 'Log events'), table(spans, 'Spans'), table(metrics, 'Metrics')].join('\n');
  fs.writeFileSync(outFile, md, 'utf8');
  process.stderr.write(`wrote ${outFile}: ${logs.size} log events, ${spans.size} span names, ${metrics.size} metrics\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`analyze error: ${err.message}\n`);
  process.exit(1);
}
