'use strict';
// For every claude_code.llm_request span with gen_ai.usage.input_tokens, checks whether it equals
// input_tokens + cache_read_tokens + cache_creation_tokens, and whether gen_ai.response.model
// equals the native model attribute. Usage: node check-genai.js --raw <raw.ndjson>
const fs = require('fs');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function val(v) {
  if (!v) return undefined;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  return undefined;
}

try {
  const raw = arg('--raw');
  if (!raw) throw new Error('usage: node check-genai.js --raw <file>');
  let total = 0;
  let sumMatches = 0;
  let modelMatches = 0;
  const mismatches = [];
  for (const line of fs.readFileSync(raw, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { path: p, body } = JSON.parse(line);
    if (!p.includes('/v1/traces')) continue;
    for (const rs of body.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) {
        for (const s of ss.spans || []) {
          if (s.name !== 'claude_code.llm_request') continue;
          const a = {};
          for (const kv of s.attributes || []) a[kv.key] = val(kv.value);
          if (a['gen_ai.usage.input_tokens'] === undefined) continue;
          total += 1;
          const native = (a.input_tokens || 0) + (a.cache_read_tokens || 0) + (a.cache_creation_tokens || 0);
          if (native === a['gen_ai.usage.input_tokens']) sumMatches += 1;
          else mismatches.push({ gen_ai: a['gen_ai.usage.input_tokens'], input: a.input_tokens, read: a.cache_read_tokens, write: a.cache_creation_tokens });
          if (a['gen_ai.response.model'] === a.model) modelMatches += 1;
        }
      }
    }
  }
  process.stdout.write(JSON.stringify({ spansWithGenAiUsage: total, inputEqualsNativePlusCache: sumMatches, responseModelEqualsModel: modelMatches, mismatches }, null, 2) + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`check-genai error: ${err.message}\n`);
  process.exit(1);
}
