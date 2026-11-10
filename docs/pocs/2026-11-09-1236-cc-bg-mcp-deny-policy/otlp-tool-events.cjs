#!/usr/bin/env node
// Prints the claude_code.tool_decision / tool_result / permission-related OTEL log records
// captured by otlp-receiver.cjs, keeping only non-identity attributes (no user/org/account ids).
// Usage: node otlp-tool-events.cjs <otlp.jsonl>
'use strict';

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node otlp-tool-events.cjs <otlp.jsonl>\n');
  process.exit(1);
}
const DROP = /^(user\.|organization\.|session\.id$|anthropic\.|terminal\.|os\.|host\.)/;
for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  for (const rl of o.body.resourceLogs || []) {
    for (const sl of rl.scopeLogs || []) {
      for (const r of sl.logRecords || []) {
        const name = r.body && r.body.stringValue;
        if (!/tool|permission|safety/.test(name || '')) continue;
        const a = {};
        for (const kv of r.attributes || []) {
          if (DROP.test(kv.key)) continue;
          const v = kv.value;
          a[kv.key] = v.stringValue !== undefined ? v.stringValue : v.intValue !== undefined ? v.intValue
            : v.boolValue !== undefined ? v.boolValue : v.doubleValue !== undefined ? v.doubleValue : v;
        }
        process.stdout.write(`${name} ${JSON.stringify(a)}\n`);
      }
    }
  }
}
process.exit(0);
