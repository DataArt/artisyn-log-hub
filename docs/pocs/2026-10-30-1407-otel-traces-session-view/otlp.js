// Shared OTLP/JSON helpers for the PoC scripts: attribute decoding and span loading from the
// capture file written by capture.js.
'use strict';

const fs = require('fs');

function attrValue(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  return JSON.stringify(v);
}

function attrsOf(list) {
  const out = {};
  for (const a of list || []) out[a.key] = attrValue(a.value);
  return out;
}

/** Flattens every span of every captured OTLP traces request into one plain object. */
function loadSpans(file) {
  const spans = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { receivedAt, body } = JSON.parse(line);
    for (const rs of body.resourceSpans || []) {
      const resource = attrsOf(rs.resource && rs.resource.attributes);
      for (const ss of rs.scopeSpans || []) {
        for (const s of ss.spans || []) {
          spans.push({
            receivedAt, resource, scope: ss.scope && ss.scope.name,
            traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || '',
            name: s.name, kind: s.kind,
            start: Number(BigInt(s.startTimeUnixNano) / 1000000n),
            end: Number(BigInt(s.endTimeUnixNano) / 1000000n),
            attrs: attrsOf(s.attributes), events: (s.events || []).map((e) => e.name),
            links: (s.links || []).length, status: s.status && s.status.code,
          });
        }
      }
    }
  }
  return spans;
}

/**
 * Cost of every API call in the captured logs, keyed by `request_id`: spans carry tokens and the
 * request id but no cost, the `claude_code.api_request` log event carries `cost_usd`.
 */
function loadCosts(file) {
  const costs = {};
  if (!fs.existsSync(file)) return costs;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { body } = JSON.parse(line);
    for (const rl of body.resourceLogs || []) {
      for (const sl of rl.scopeLogs || []) {
        for (const r of sl.logRecords || []) {
          if (!r.body || r.body.stringValue !== 'claude_code.api_request') continue;
          const a = attrsOf(r.attributes);
          if (a.request_id) costs[a.request_id] = { costUsd: Number(a.cost_usd || 0), querySource: a.query_source };
        }
      }
    }
  }
  return costs;
}

/** Spans of the newest trace with identity attributes removed and the call cost joined in. */
function newestTraceForPage(tracesFile, logsFile) {
  const spans = fs.existsSync(tracesFile) ? loadSpans(tracesFile) : [];
  const costs = loadCosts(logsFile);
  const last = spans.length ? spans.reduce((a, b) => (b.start > a.start ? b : a)).traceId : null;
  return spans.filter((s) => s.traceId === last).map((s) => {
    const attrs = {};
    for (const [k, v] of Object.entries(s.attrs)) if (!/^user\.|^organization\.id$|^user_prompt$/.test(k)) attrs[k] = v;
    const cost = s.attrs.request_id ? costs[s.attrs.request_id] : undefined;
    return { ...s, resource: undefined, attrs, costUsd: cost ? cost.costUsd : undefined, querySource: cost ? cost.querySource : undefined };
  });
}

module.exports = { attrValue, attrsOf, loadSpans, loadCosts, newestTraceForPage };
