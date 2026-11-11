'use strict';
// Q8(d) degradation and Q6 sizing. Usage (from the PoC folder): node merge/run-merge.cjs
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { mergeSession, excerpt, CAP } = require('./merge.cjs');

const HERE = path.join(__dirname, '..');
const WORK = path.join(HERE, 'work', 'merge');
fs.rmSync(WORK, { recursive: true, force: true });
const tapDir = path.join(WORK, 'tap');
fs.mkdirSync(tapDir, { recursive: true });
const TAP = path.join(HERE, 'tap', 'loghub-net-tap.cjs').split(path.sep).join('/');
const env = { ...process.env, NODE_OPTIONS: `--require "${TAP}"`, LOGHUB_NET_TAP_DIR: tapDir, LOGHUB_NET_TAP_LOOPBACK: '1', TARGET_EXTERNAL: '1' };
spawnSync(process.execPath, [path.join(HERE, 'target', 'target.cjs')], { env, encoding: 'utf8' });
const corruptDir = path.join(WORK, 'tap-corrupt');
fs.mkdirSync(corruptDir);
fs.writeFileSync(path.join(corruptDir, 'net-1-1-ab.jsonl'), '{"t":"proc","v":1}\n{"t":"http","host":"api.example.com","port":443,"status":200}\n{"t":"http","host":"api.exa');
fs.writeFileSync(path.join(corruptDir, 'net-2-2-cd.jsonl'), '\u0000\u0000binary garbage');
const transcript = path.join(__dirname, 'fixture-session.jsonl');

const cases = {
  'transcript + node tap': { transcriptFile: transcript, tapDirs: [tapDir] },
  'transcript only (old hook)': { transcriptFile: transcript },
  'node tap only (transcript missing)': { tapDirs: [tapDir] },
  'nothing at all': {},
  'tap dir missing': { transcriptFile: transcript, tapDirs: [path.join(WORK, 'no-such-dir')] },
  'corrupt / half-written tap files': { transcriptFile: transcript, tapDirs: [corruptDir] },
  'Log Hub origin excluded server-side': { transcriptFile: transcript, tapDirs: [tapDir], logHubOrigins: ['https://example.com'] },
};
for (const [name, opts] of Object.entries(cases)) {
  try {
    const r = mergeSession(opts);
    const kinds = {};
    for (const x of r.records) kinds[`${x.source}/${x.kind}`] = (kinds[`${x.source}/${x.kind}`] || 0) + 1;
    console.log(`OK  ${name}: records=${r.records.length} hidden=${JSON.stringify(r.hidden)} coverage=${JSON.stringify(r.coverage)}`);
    console.log(`      ${JSON.stringify(kinds)}`);
  } catch (e) { console.log(`FAIL ${name}: ${e.message}`); }
}

// ---- Q6 sizing ----
const all = mergeSession({ transcriptFile: transcript, tapDirs: [tapDir] }).records;
const sizes = all.map((r) => Buffer.byteLength(JSON.stringify(r)));
console.log(`\nQ6 stored JSON per record (this fixture): avg=${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} max=${Math.max(...sizes)} bytes`);
const worst = {
  source: 'transcript', toolUseId: 'toolu_' + 'x'.repeat(24), ts: new Date().toISOString(), kind: 'http', host: 'h'.repeat(CAP.host), port: 443,
  url: excerpt('https://x/' + 'q'.repeat(5000), CAP.url), command: excerpt('c'.repeat(10000), CAP.command), query: excerpt('s'.repeat(2000), CAP.query),
  method: 'GET', path: excerpt('/p'.repeat(1000), CAP.path), status: 200, bytesIn: 123456789, bytesOut: 123456, durMs: 12345.6,
  phases: { dns: 1.1, connect: 2.2, tls: 3.3, ttfb: 4.4, transfer: 5.5 }, process: 'p'.repeat(128), group: 'agent',
};
const w = Buffer.byteLength(JSON.stringify(worst));
console.log(`Q6 worst-case record with every excerpt at its cap: ${w} bytes`);
console.log(`Q6 per session cap 2000 records: typical ${(2000 * 300 / 1024).toFixed(0)} KB, worst ${(2000 * w / 1024 / 1024).toFixed(2)} MB (before TOAST compression)`);
