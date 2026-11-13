'use strict';
// Runs the tap checks for Q1-Q4. Usage (from this folder): node run-tap-checks.cjs [q1|q2|q3|q4|all]
// Writes run artefacts only under ./work/ (gitignored) and deletes only inside it.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const WORK = path.join(HERE, 'work');
const TAP = path.join(HERE, 'tap', 'loghub-net-tap.cjs');
const TARGET = path.join(HERE, 'target', 'target.cjs');
const BENCH = path.join(HERE, 'target', 'bench.cjs');
const which = process.argv[2] || 'all';

function freshDir(name) {
  const d = path.join(WORK, name);
  if (!d.startsWith(WORK + path.sep)) throw new Error('refusing to touch ' + d);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function run(args, env, opts = {}) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  if (!('NODE_OPTIONS' in env)) delete e.NODE_OPTIONS;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { env: e, encoding: 'utf8', cwd: opts.cwd || HERE, timeout: opts.timeout || 120000 });
  return { ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
// NODE_OPTIONS treats a backslash inside double quotes as an escape, so Windows paths must use '/'.
const req = (p) => `--require "${p.split(path.sep).join('/')}"`;
function readRecords(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) out.push(JSON.parse(line));
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const head = (s) => console.log(`\n=== ${s} ===`);

function q1() {
  head('Q1 channels and fields (loopback recorded via LOGHUB_NET_TAP_LOOPBACK=1, plus external)');
  const d = freshDir('q1');
  const r = run([TARGET], { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1', TARGET_EXTERNAL: '1' });
  console.log(`exit=${r.status} stderr=${r.stderr.trim()}`);
  for (const rec of readRecords(d)) if (rec.t !== 'proc') console.log(JSON.stringify(rec));
  head('Q1 loopback filter on (default): records');
  const d2 = freshDir('q1-filtered');
  run([TARGET], { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: d2 });
  const recs = readRecords(d2);
  console.log(`files=${fs.readdirSync(d2).length} records=${recs.length} (0 = nothing recorded, no file created)`);
}

function q2() {
  head('Q2 fail-open: stdout + exit code tap off vs on');
  const base = run([TARGET], {});
  const cases = {
    'tap on (loopback filtered)': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: freshDir('q2-on') },
    'tap on (recording loopback)': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: freshDir('q2-on-lb'), LOGHUB_NET_TAP_LOOPBACK: '1' },
    'missing output dir': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: path.join(WORK, 'no-such-dir', 'x'), LOGHUB_NET_TAP_LOOPBACK: '1' },
    'output dir is a file': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: TAP, LOGHUB_NET_TAP_LOOPBACK: '1' },
    'tap bug, guarded handlers': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: freshDir('q2-throw'), LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_TEST_THROW: 'guarded' },
    'tap bug, UNguarded subscriber': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: freshDir('q2-raw'), LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_TEST_THROW: 'raw' },
  };
  console.log(`baseline: exit=${base.status} stdoutBytes=${Buffer.byteLength(base.stdout)}`);
  for (const [name, env] of Object.entries(cases)) {
    const r = run([TARGET], env);
    const same = r.stdout === base.stdout && r.status === base.status;
    const firstErr = (r.stderr || '').split('\n').find((l) => /Error/.test(l)) || '';
    console.log(`${same ? 'IDENTICAL' : 'DIFFERENT'}  ${name}: exit=${r.status}${same ? '' : ' stderr: ' + firstErr.trim()}`);
  }

  head('Q2 startup overhead: node -e 0, 21 runs each, median ms');
  const runs = 21;
  const sets = {
    'no tap': {},
    'tap, kill switch LOGHUB_NET_TAP=0': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP: '0', LOGHUB_NET_TAP_DIR: freshDir('q2-start-off') },
    'tap on': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: freshDir('q2-start') },
  };
  const med = {};
  for (let i = 0; i < 3; i++) run(['-e', '0'], {}); // warm the FS cache
  const samples = Object.fromEntries(Object.keys(sets).map((k) => [k, []]));
  for (let i = 0; i < runs; i++) for (const [k, env] of Object.entries(sets)) samples[k].push(run(['-e', '0'], env).ms);
  for (const k of Object.keys(sets)) { med[k] = median(samples[k]); console.log(`${k}: ${med[k].toFixed(1)} ms`); }
  console.log(`added by tap: ${(med['tap on'] - med['no tap']).toFixed(1)} ms; files created by 21x "node -e 0": ${fs.readdirSync(path.join(WORK, 'q2-start')).length}`);

  head('Q2 per-request overhead: 1000 sequential loopback requests, median of 5 runs');
  for (const mode of ['http', 'fetch']) {
    const m = {};
    const variants = {
      'no tap': {},
      'tap, loopback filtered (realistic)': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: freshDir('q2-bench') },
      'tap, recording every request': { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_LOOPBACK: '1', LOGHUB_NET_TAP_MAX_RECORDS: '100000', LOGHUB_NET_TAP_MAX_BYTES: '100000000' },
    };
    const s = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
    for (let i = 0; i < 5; i++) {
      for (const [k, env] of Object.entries(variants)) {
        const e = { ...env };
        if (k === 'tap, recording every request') e.LOGHUB_NET_TAP_DIR = freshDir('q2-bench-all');
        s[k].push(JSON.parse(run([BENCH, '1000', mode], e).stdout).ms);
      }
    }
    for (const k of Object.keys(variants)) { m[k] = median(s[k]); }
    const base = m['no tap'];
    console.log(`${mode}: ` + Object.entries(m).map(([k, v]) => `${k} ${v} ms (${((v - base) / 1000 * 1000).toFixed(0)} us/req)`).join(' | '));
  }
}

function q3() {
  head('Q3 NODE_OPTIONS coexistence');
  const probe = ['-e', 'console.log(JSON.stringify({heapMB: Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576)}))'];
  let d = freshDir('q3-existing');
  let r = run(probe, { NODE_OPTIONS: `--max-old-space-size=300 ${req(TAP)}`, LOGHUB_NET_TAP_DIR: d });
  const alone = run(probe, { NODE_OPTIONS: '--max-old-space-size=300' }).stdout.trim();
  const none = run(probe, {}).stdout.trim();
  console.log(`existing flag + appended --require: exit=${r.status} out=${r.stdout.trim()} records=${readRecords(d).length} | flag alone: ${alone} | no flag: ${none}`);

  const spaced = path.join(WORK, 'dir with spaces');
  fs.mkdirSync(spaced, { recursive: true });
  const spacedTap = path.join(spaced, 'loghub net tap.cjs');
  fs.copyFileSync(TAP, spacedTap);
  d = freshDir('q3-spaces');
  r = run([TARGET], { NODE_OPTIONS: `--require "${spacedTap}"`, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1' });
  console.log(`quoted absolute path with spaces, native separators: exit=${r.status} records=${readRecords(d).length - 1}`);
  r = run(probe, { NODE_OPTIONS: `--require ${spacedTap}` });
  console.log(`UNquoted path with spaces: exit=${r.status} err=${(r.stderr.split('\n').find((l) => /Error|Cannot/.test(l)) || '').trim().slice(0, 90)}`);
  const fwd = spacedTap.split(path.sep).join('/');
  d = freshDir('q3-fwd');
  r = run([TARGET], { NODE_OPTIONS: `--require "${fwd}"`, LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1' });
  console.log(`quoted forward-slash path: exit=${r.status} records=${readRecords(d).length - 1}`);

  const missing = path.join(WORK, 'gone', 'loghub-net-tap.cjs');
  r = run(probe, { NODE_OPTIONS: req(missing) });
  console.log(`MISSING tap file: exit=${r.status} err=${(r.stderr.split('\n').find((l) => /Error|Cannot/.test(l)) || '').trim().replace(/'.*'/, "'<path>'")}`);
  r = run(['--version'], { NODE_OPTIONS: req(missing) });
  console.log(`MISSING tap file, node --version: exit=${r.status}`);

  d = freshDir('q3-nocodegen');
  r = run(['--disallow-code-generation-from-strings', TARGET], { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1' });
  console.log(`--disallow-code-generation-from-strings: exit=${r.status} records=${readRecords(d).length - 1}`);

  d = freshDir('q3-permission');
  r = run(['--permission', `--allow-fs-read=*`, '-e', 'require("node:dns").lookup("localhost",()=>console.log("ran"))'], { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1' });
  console.log(`--permission without fs-write: exit=${r.status} out=${r.stdout.trim()} files=${fs.readdirSync(d).length} err=${(r.stderr.split('\n').find((l) => /Error/.test(l)) || '').trim().slice(0, 90)}`);

  // Child processes inherit NODE_OPTIONS: each node child loads the tap and writes its own file.
  d = freshDir('q3-children');
  const parent = `const {execFileSync}=require('node:child_process');for(let i=0;i<3;i++){try{execFileSync(process.execPath,[${JSON.stringify(TARGET)}])}catch(e){}}console.log('done')`;
  r = run(['-e', parent], { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1' });
  console.log(`parent spawning 3 node children: exit=${r.status} files=${fs.readdirSync(d).length} (one per process that made a request)`);
}

function q4() {
  head('Q4 flood: 100000 loopback requests, default caps (500 records / 256 KB per process)');
  const d = freshDir('q4');
  const r = run([BENCH, '100000', 'http', '20'], { NODE_OPTIONS: req(TAP), LOGHUB_NET_TAP_DIR: d, LOGHUB_NET_TAP_LOOPBACK: '1' }, { timeout: 600000 });
  console.log(`bench: ${r.stdout.trim()} exit=${r.status}`);
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const recs = lines.filter((l) => l.t === 'http' || l.t === 'fetch');
    const bytesPerRec = Math.round(recs.reduce((a, l) => a + Buffer.byteLength(JSON.stringify(l)) + 1, 0) / recs.length);
    console.log(`file bytes=${fs.statSync(p).size} lines=${lines.length} records=${recs.length} avgRecordBytes=${bytesPerRec}`);
    console.log('tail: ' + lines.slice(-2).map((l) => JSON.stringify(l)).join(' '));
  }
  const r2 = run([BENCH, '100000', 'http', '20'], {}, { timeout: 600000 });
  console.log(`same flood without tap: ${r2.stdout.trim()}`);
}

fs.mkdirSync(WORK, { recursive: true });
if (which === 'q1' || which === 'all') q1();
if (which === 'q2' || which === 'all') q2();
if (which === 'q3' || which === 'all') q3();
if (which === 'q4' || which === 'all') q4();
