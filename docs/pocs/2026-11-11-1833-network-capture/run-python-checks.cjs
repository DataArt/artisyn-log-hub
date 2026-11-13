'use strict';
// Q7: the Python tap (pytap/sitecustomize.py) driven from Node. Usage (from this folder):
//   node run-python-checks.cjs            uses `python` (or `py -3` on Windows)
//   node run-python-checks.cjs 3.12       uses `py -3.12` (Windows launcher)
// Skips with a message when no Python is found. Artefacts only under ./work/py (gitignored).
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const HERE = __dirname;
const WORK = path.join(HERE, 'work', 'py');
const PYTAP = path.join(HERE, 'pytap');
const ver = process.argv[2];

function findPython() {
  const cands = ver ? [['py', [`-${ver}`]]] : [['python', []], ['python3', []], ['py', ['-3']]];
  for (const [cmd, pre] of cands) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { encoding: 'utf8' });
    if (r.status === 0) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}
const PY = findPython();
if (!PY) { console.log('SKIP: no python found'); process.exit(0); }
const [maj, min] = PY.version.split('.').map(Number);
if (maj < 3 || (maj === 3 && min < 8)) { console.log(`SKIP: python ${PY.version} < 3.8 has no sys.addaudithook`); process.exit(0); }

function pyRun(args, env, cmd) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  if (!('PYTHONPATH' in env)) delete e.PYTHONPATH;
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(cmd || PY.cmd, cmd ? args : [...PY.pre, ...args], { env: e });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
  });
}
function freshDir(name) {
  const d = path.join(WORK, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function records(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) out.push(JSON.parse(l));
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pp = (...dirs) => dirs.join(path.delimiter);

// Target: urllib.request, requests (when installed), a raw socket and an optional external request,
// against a loopback server owned by the Node runner. Prints deterministic output, exits 3.
const TARGET = [
  'import os, socket, sys, urllib.request',
  'base = os.environ["T_BASE"]; port = int(base.rsplit(":", 1)[1].split("/")[0])',
  'out = []',
  'out.append("urllib %s" % len(urllib.request.urlopen(base + "/u?token=secret").read()))',
  'try:',
  '    import requests',
  '    out.append("requests %s" % requests.get(base + "/r").status_code)',
  'except ImportError:',
  '    out.append("requests n/a")',
  's = socket.create_connection(("127.0.0.1", port)); s.sendall(b"GET /raw HTTP/1.0\\r\\n\\r\\n"); out.append("raw %s" % s.recv(12)); s.close()',
  'if os.environ.get("T_EXTERNAL") == "1":',
  '    try:',
  '        sys.stderr.write("external %s\\n" % urllib.request.urlopen("https://example.com/?q=1", timeout=8).status)',
  '    except Exception as e:',
  '        sys.stderr.write("external failed %s\\n" % type(e).__name__)',
  'print("\\n".join(out))',
  'sys.exit(3)',
].join('\n');

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const server = http.createServer((q, a) => a.end('py-ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`python ${PY.version}`);

  console.log('\n=== Q7 events and fields (loopback recorded, + external) ===');
  let d = freshDir('fields');
  let r = await pyRun(['-c', TARGET], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', T_BASE: BASE, T_EXTERNAL: '1' });
  console.log(`exit=${r.code} stderr=${r.err.trim()}`);
  for (const x of records(d)) if (x.t !== 'proc') console.log(JSON.stringify(x).replace(/"port":\d{4,5}/g, '"port":<p>'));
  d = freshDir('filtered');
  await pyRun(['-c', TARGET], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, T_BASE: BASE });
  console.log(`loopback filter on (default): files=${fs.readdirSync(d).length}`);

  console.log('\n=== Q7 fail-open: stdout + exit code, tap off vs on ===');
  const base = await pyRun(['-c', TARGET], { T_BASE: BASE });
  const cases = {
    'tap on (filtered)': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: freshDir('fo1') },
    'tap on (recording loopback)': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: freshDir('fo2'), LOGHUB_NET_TAP_LOOPBACK: '1' },
    'missing output dir': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: path.join(WORK, 'nope', 'x'), LOGHUB_NET_TAP_LOOPBACK: '1' },
    'output dir is a file': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: path.join(PYTAP, 'sitecustomize.py'), LOGHUB_NET_TAP_LOOPBACK: '1' },
    'tap bug, guarded': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: freshDir('fo3'), LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_TEST_THROW: 'guarded' },
    'tap bug, UNguarded audit hook': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: freshDir('fo4'), LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_TEST_THROW: 'raw' },
  };
  console.log(`baseline exit=${base.code} stdout=${JSON.stringify(base.out)}`);
  for (const [name, env] of Object.entries(cases)) {
    const x = await pyRun(['-c', TARGET], { ...env, T_BASE: BASE });
    const same = x.out === base.out && x.code === base.code;
    console.log(`${same ? 'IDENTICAL' : 'DIFFERENT'}  ${name}: exit=${x.code}${same ? '' : ' err: ' + (x.err.trim().split('\n').pop() || '')}`);
  }

  console.log('\n=== Q7 existing user sitecustomize ===');
  const userSite = freshDir('user-site');
  fs.writeFileSync(path.join(userSite, 'sitecustomize.py'), 'import builtins\nbuiltins.USER_SITECUSTOMIZE = "ran"\nprint("user sitecustomize ran")\n');
  const probe = 'import builtins, sitecustomize; print(getattr(builtins, "USER_SITECUSTOMIZE", "missing"), sitecustomize.__name__)';
  d = freshDir('chain');
  const noTap = await pyRun(['-c', probe], { PYTHONPATH: userSite });
  const withTap = await pyRun(['-c', probe], { PYTHONPATH: pp(PYTAP, userSite), LOGHUB_NET_TAP_DIR: d });
  console.log(`without tap: ${JSON.stringify(noTap.out)} | with tap first on PYTHONPATH: ${JSON.stringify(withTap.out)} identical=${noTap.out === withTap.out}`);
  fs.writeFileSync(path.join(userSite, 'sitecustomize.py'), 'raise ValueError("broken user sitecustomize")\n');
  const bNo = await pyRun(['-c', 'print("main ran")'], { PYTHONPATH: userSite });
  const bTap = await pyRun(['-c', 'print("main ran")'], { PYTHONPATH: pp(PYTAP, userSite), LOGHUB_NET_TAP_DIR: d });
  const first = (s) => s.trim().split('\n')[0];
  console.log(`broken user sitecustomize: without tap exit=${bNo.code} out=${bNo.out.trim()} err="${first(bNo.err)}" | with tap exit=${bTap.code} out=${bTap.out.trim()} err="${first(bTap.err)}"`);

  console.log('\n=== Q7 -I / -S / -E / venv ===');
  for (const flag of ['-I', '-S', '-E']) {
    d = freshDir('flag' + flag);
    const x = await pyRun([flag, '-c', TARGET], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', T_BASE: BASE });
    console.log(`python ${flag}: exit=${x.code} records=${records(d).filter((y) => y.t !== 'proc').length} (tap bypassed when 0)`);
  }
  const venv = path.join(WORK, 'venv');
  fs.rmSync(venv, { recursive: true, force: true });
  const mk = spawnSync(PY.cmd, [...PY.pre, '-m', 'venv', '--without-pip', venv], { encoding: 'utf8' });
  if (mk.status === 0) {
    const vpy = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    const sp = spawnSync(vpy, ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(sp, 'sitecustomize.py'), 'print("venv sitecustomize ran")\n');
    d = freshDir('venv-out');
    const x = await pyRun(['-c', TARGET], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', T_BASE: BASE }, vpy);
    console.log(`venv + PYTHONPATH tap: exit=${x.code} records=${records(d).filter((y) => y.t !== 'proc').length} venvSitecustomize=${x.out.includes('venv sitecustomize ran')}`);
  } else console.log('venv: could not create (' + mk.stderr.trim().split('\n').pop() + ')');

  console.log('\n=== Q7 Log Hub self-traffic / service ===');
  d = freshDir('skip');
  await pyRun(['-c', TARGET], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_SKIP: '1', T_BASE: BASE });
  console.log(`LOGHUB_NET_TAP_SKIP=1: files=${fs.readdirSync(d).length}`);
  d = freshDir('exclude');
  await pyRun(['-c', TARGET], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_EXCLUDE: `127.0.0.1:${server.address().port},127.0.0.1`, T_BASE: BASE });
  console.log(`LOGHUB_NET_TAP_EXCLUDE=<Log Hub host:port>: records=${records(d).filter((y) => y.t !== 'proc' && y.t !== 'bytesOut').length}`);
  const freePort = await new Promise((res) => { const t = http.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => res(p)); }); });
  d = freshDir('service');
  const SERVICE = 'import socket, urllib.request, os\nsrv = socket.socket(); srv.bind(("127.0.0.1", int(os.environ["T_FREE_PORT"]))); srv.listen()\nurllib.request.urlopen(os.environ["T_BASE"] + "/s").read()\nprint("ok")';
  await pyRun(['-c', SERVICE], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', T_BASE: BASE, T_FREE_PORT: String(freePort) });
  const roles = (dir) => [...new Set(records(dir).filter((y) => y.role).map((y) => y.role))].join(',');
  console.log(`process that binds + listens on a fixed port: roles=${roles(d)}`);
  d = freshDir('script');
  await pyRun(['-c', 'import urllib.request, os\nurllib.request.urlopen(os.environ["T_BASE"] + "/s").read()'], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', T_BASE: BASE });
  console.log(`short script: roles=${roles(d)}`);

  console.log('\n=== Q7 overhead ===');
  const sets = { 'no tap': {}, 'tap on': { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: freshDir('start') } };
  const s = { 'no tap': [], 'tap on': [] };
  for (let i = 0; i < 3; i++) await pyRun(['-c', 'pass'], {});
  for (let i = 0; i < 21; i++) for (const [k, env] of Object.entries(sets)) s[k].push((await pyRun(['-c', 'pass'], env)).ms);
  console.log(`python -c pass, median of 21: no tap ${median(s['no tap']).toFixed(1)} ms | tap ${median(s['tap on']).toFixed(1)} ms | files created: ${fs.readdirSync(sets['tap on'].LOGHUB_NET_TAP_DIR).length}`);
  const HOT = 'import time, os\nt=time.perf_counter()\nfor i in range(50000):\n    open(os.devnull).close()\nprint(round((time.perf_counter()-t)*1000))';
  const LOOP = 'import time, urllib.request, os\nb=os.environ["T_BASE"]\nt=time.perf_counter()\nfor i in range(300):\n    urllib.request.urlopen(b + "/l?i=%d" % i).read()\nprint(round((time.perf_counter()-t)*1000))';
  for (const [name, code, n] of [['50000 open() calls (audit hot path, non-network events)', HOT, 50000], ['300 loopback urllib requests, loopback filtered', LOOP, 300]]) {
    const m = { off: [], on: [] };
    for (let i = 0; i < 5; i++) {
      m.off.push(Number((await pyRun(['-c', code], { T_BASE: BASE })).out));
      m.on.push(Number((await pyRun(['-c', code], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: freshDir('hot'), T_BASE: BASE })).out));
    }
    const off = median(m.off);
    const on = median(m.on);
    console.log(`${name}: off ${off} ms | on ${on} ms | ${(((on - off) / n) * 1000).toFixed(2)} us per call`);
  }

  // Synthetic events via sys.audit(): exercises the caps without opening real sockets (a real connect
  // flood exhausts Windows ephemeral ports - WinError 10048 - and breaks every other run for minutes).
  console.log('\n=== Q7 flood: 100000 synthetic getaddrinfo+connect events, default caps ===');
  d = freshDir('flood');
  const FLOOD = 'import sys\nfor i in range(100000):\n    sys.audit("socket.getaddrinfo", "h%d.example.com" % i, 443, 0, 0, 0)\n    sys.audit("socket.connect", None, ("203.0.113.%d" % (i % 250), 443))\nprint("done")';
  r = await pyRun(['-c', FLOOD], { PYTHONPATH: PYTAP, LOGHUB_NET_TAP_DIR: d, T_BASE: BASE });
  for (const f of fs.readdirSync(d)) {
    const lines = fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n');
    console.log(`exit=${r.code} file bytes=${fs.statSync(path.join(d, f)).size} lines=${lines.length} tail=${lines.slice(-1)}`);
  }
  server.close();
})();
