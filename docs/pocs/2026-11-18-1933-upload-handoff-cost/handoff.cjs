'use strict';
// Simulates the Stop/SessionEnd hand-off path: load the hook's module graph, read the heartbeat,
// write one job atomically (tmp + rename), optionally spawn a detached hidden child, exit.
// Prints one JSON line with in-process timings. Usage:
//   node handoff.cjs <queueDir> <heartbeatPath> [--spawn]
const t0 = process.hrtime.bigint();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const hookDir = path.resolve(__dirname, '../../../hook/.claude/telemetry_tool');
// The same requires send-logs-hook.js does at its top (the whole graph), so the cost is realistic.
require(path.join(hookDir, 'send-logs-hook.js').replace(/send-logs-hook\.js$/, 'env-context.js'));
for (const m of ['git-context', 'hook-log', 'recommendations', 'otel-register', 'otel-status',
  'managed-settings', 'otel-endpoint-check', 'throttle-state', 'write-telemetry', 'upload-logs',
  'session-files', 'ndjson-sanitize', 'process-marker', 'harness-state', 'harness-snapshot',
  'code-inventory', 'okf-snapshot', 'okf-state', 'claude-config-dir']) {
  require(path.join(hookDir, `${m}.js`));
}
const tRequire = process.hrtime.bigint();

const [queueDir, heartbeatPath] = process.argv.slice(2);
let hb = null;
try { hb = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')); } catch { /* missing = fallback */ }
const fresh = hb && Date.now() - hb.ts < 15000;
const tHeartbeat = process.hrtime.bigint();

fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
const name = `sess-1234_${new Date().toISOString().replace(/[-:.]/g, '')}_${process.pid}.json`;
const tmp = path.join(queueDir, `.${name}.tmp`);
fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessionId: 'sess-1234', trigger: 'stop', cwd: process.cwd() }), { mode: 0o600 });
fs.renameSync(tmp, path.join(queueDir, name));
const tJob = process.hrtime.bigint();

if (process.argv.includes('--spawn')) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},3000)'],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
const tSpawn = process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
process.stdout.write(JSON.stringify({
  fresh: !!fresh, requireMs: ms(t0, tRequire), heartbeatMs: ms(tRequire, tHeartbeat),
  jobWriteMs: ms(tHeartbeat, tJob), spawnMs: ms(tJob, tSpawn), totalInProcessMs: ms(t0, tSpawn),
}) + '\n');
