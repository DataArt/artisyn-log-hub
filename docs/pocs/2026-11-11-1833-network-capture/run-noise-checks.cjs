'use strict';
// Q8 (a) Log Hub self-traffic exclusion and (b) service vs script tagging for the Node tap.
// Usage (from this folder): node run-noise-checks.cjs
// Two in-process upstream servers stand in for "the Log Hub server" (LH) and "some API" (API).
const { execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const WORK = path.join(HERE, 'work', 'q8');
const TAP = path.join(HERE, 'tap', 'loghub-net-tap.cjs').split(path.sep).join('/');
const CLIENT = path.join(HERE, 'target', 'client.cjs');

function serve() { return new Promise((r) => { const s = http.createServer((q, a) => a.end('ok')).listen(0, '127.0.0.1', () => r(s)); }); }
function run(args, env) {
  return new Promise((resolve) => {
    const e = { ...process.env, NODE_OPTIONS: `--require "${TAP}"`, LOGHUB_NET_TAP_LOOPBACK: '1', ...env };
    execFile(process.execPath, args, { env: e, encoding: 'utf8' }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout: stdout.trim() }));
  });
}
function records(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) { const o = JSON.parse(l); if (o.t !== 'proc') out.push(o); }
  return out;
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const lh = await serve();
  const api = await serve();
  const LH = `http://127.0.0.1:${lh.address().port}/api/v2/logs`;
  const API = `http://127.0.0.1:${api.address().port}/v1/items`;
  const label = (r) => (r.port === lh.address().port ? 'LH' : r.port === api.address().port ? 'API' : String(r.port));
  let n = 0;
  async function check(name, args, env) {
    const dir = path.join(WORK, String(++n));
    fs.mkdirSync(dir);
    const r = await run(args, { LOGHUB_NET_TAP_DIR: dir, ...env });
    const recs = records(dir);
    console.log(`${name}: out="${r.stdout}" records=[${recs.map((x) => `${label(x)}:${x.role}`).join(', ')}]`);
  }

  console.log('--- (a) Log Hub self-traffic');
  await check('plain script calling LH and API', [CLIENT, `${LH},${API}`], {});
  await check('LOGHUB_NET_TAP_EXCLUDE=<LH host:port>', [CLIENT, `${LH},${API}`], { LOGHUB_NET_TAP_EXCLUDE: `127.0.0.1:${lh.address().port}` });
  await check('LOGHUB_NET_TAP_SKIP=1 (hook helper process)', [CLIENT, `${LH},${API}`], { LOGHUB_NET_TAP_SKIP: '1' });
  const hookDir = path.join(WORK, 'fake-hook-install', 'telemetry_tool');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookScript = path.join(hookDir, 'send-logs-hook.js');
  fs.copyFileSync(CLIENT, hookScript);
  await check('script under LOGHUB_NET_TAP_SKIP_DIR', [hookScript, `${LH},${API}`], { LOGHUB_NET_TAP_SKIP_DIR: path.dirname(hookDir) });

  console.log('--- (b) service vs script');
  await check('short script', [CLIENT, API], {});
  await check('dev-server-like process (listen, then outbound)', [CLIENT, API, '0', 'listen'], {});
  await check('script older than SERVICE_AFTER_S=1 (no listen)', [CLIENT, API, '1300'], { LOGHUB_NET_TAP_SERVICE_AFTER_S: '1' });
  lh.close();
  api.close();
})();
