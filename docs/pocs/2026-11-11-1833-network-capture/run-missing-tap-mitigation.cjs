'use strict';
// Q3 follow-up: a missing --require file kills every node process (exit 1, MODULE_NOT_FOUND).
// Candidate mitigations, measured here (from this folder): node run-missing-tap-mitigation.cjs
//  A) guard in $CLAUDE_ENV_FILE (bash, sourced before each Bash command): export only if the file exists
//  B) --import of a data: URL whose top-level `await import(tap).catch(() => {})` tolerates a missing tap
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HERE = __dirname;
const WORK = path.join(HERE, 'work', 'q3-mitigation');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const TAP = path.join(HERE, 'tap', 'loghub-net-tap.cjs');
const MISSING = path.join(WORK, 'gone.cjs');
const TARGET = path.join(HERE, 'target', 'target.cjs');

function loaderOption(tapPath) {
  const code = `await import(${JSON.stringify(pathToFileURL(tapPath).href)}).catch(() => {})`;
  return `--import "data:text/javascript,${encodeURIComponent(code)}"`;
}
function run(args, nodeOptions, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions; else delete env.NODE_OPTIONS;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  return { ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// B: data-URL loader
let r = run(['-e', 'console.log("ran")'], loaderOption(MISSING));
console.log(`B data: loader, tap MISSING: exit=${r.status} out=${r.stdout.trim()} stderr=${JSON.stringify(r.stderr.trim().slice(0, 80))}`);
const BROKEN = path.join(WORK, 'broken.cjs');
fs.writeFileSync(BROKEN, 'const x = (; // half-written / corrupted tap file\n');
r = run(['-e', 'console.log("ran")'], `--require "${BROKEN.split(path.sep).join('/')}"`);
console.log(`--require of a tap with a SyntaxError: exit=${r.status} out=${r.stdout.trim() || '(none)'}`);
r = run(['-e', 'console.log("ran")'], loaderOption(BROKEN));
console.log(`B data: loader, tap with a SyntaxError: exit=${r.status} out=${r.stdout.trim()} stderr=${JSON.stringify(r.stderr.trim().slice(0, 80))}`);
const outDir = path.join(WORK, 'b-out');
fs.mkdirSync(outDir);
r = run([TARGET], loaderOption(TAP), { LOGHUB_NET_TAP_DIR: outDir, LOGHUB_NET_TAP_LOOPBACK: '1' });
const recs = fs.readdirSync(outDir).map((f) => fs.readFileSync(path.join(outDir, f), 'utf8').trim().split('\n').length - 1);
console.log(`B data: loader, tap present: exit=${r.status} records=${recs.join(',')} (tap loaded before main, channels subscribed in time)`);

const samples = { none: [], require: [], dataImport: [] };
for (let i = 0; i < 3; i++) run(['-e', '0']);
for (let i = 0; i < 21; i++) {
  samples.none.push(run(['-e', '0']).ms);
  samples.require.push(run(['-e', '0'], `--require "${TAP.split(path.sep).join('/')}"`, { LOGHUB_NET_TAP_DIR: outDir }).ms);
  samples.dataImport.push(run(['-e', '0'], loaderOption(TAP), { LOGHUB_NET_TAP_DIR: outDir }).ms);
}
console.log(`startup median ms: none ${median(samples.none).toFixed(1)} | --require ${median(samples.require).toFixed(1)} | --import data: ${median(samples.dataImport).toFixed(1)}`);

// A: bash guard, as the hook would write it into $CLAUDE_ENV_FILE
const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const guard = (p) => `tap='${p.split(path.sep).join('/')}'; if [ -f "$tap" ]; then export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--require \\"$tap\\""; fi; node -e 'console.log("ran", JSON.stringify(process.env.NODE_OPTIONS||"").length>2)'`;
for (const [name, p] of [['present', TAP], ['MISSING', MISSING]]) {
  const b = spawnSync(bash, ['-c', guard(p)], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  console.log(`A bash guard, tap ${name}: exit=${b.status} out=${(b.stdout || '').trim()} err=${(b.stderr || '').trim().slice(0, 80)}`);
}
