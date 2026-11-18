// Driver: measures (1) hand-off wall time per run, with and without a detached spawn,
// (2) rename-claim exclusivity under a race of N processes, (3) fs.watch pickup latency.
// Usage: node run.mjs   (writes only under ./work/, which it creates)
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.join(here, 'work');
fs.mkdirSync(work, { recursive: true });
const queue = path.join(work, 'queue');
const running = path.join(work, 'running');
const hbPath = path.join(work, 'heartbeat.json');
fs.mkdirSync(queue, { recursive: true });
fs.mkdirSync(running, { recursive: true });
fs.writeFileSync(hbPath, JSON.stringify({ pid: 1, ts: Date.now(), capabilities: ['upload-queue-v1'] }));

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0].toFixed(1), p50: q(0.5).toFixed(1), p95: q(0.95).toFixed(1), max: s[s.length - 1].toFixed(1) };
};

// 1. hand-off wall time
for (const spawnFlag of [false, true]) {
  const wall = []; const inproc = []; const spawnMs = [];
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(hbPath, JSON.stringify({ pid: 1, ts: Date.now(), capabilities: ['upload-queue-v1'] }));
    const t = performance.now();
    const r = spawnSync(process.execPath, [path.join(here, 'handoff.cjs'), queue, hbPath, ...(spawnFlag ? ['--spawn'] : [])], { encoding: 'utf8' });
    wall.push(performance.now() - t);
    const j = JSON.parse(r.stdout.trim());
    inproc.push(j.totalInProcessMs); spawnMs.push(j.spawnMs);
  }
  console.log(`handoff spawn=${spawnFlag}`, JSON.stringify({ wall: stats(wall), inProcess: stats(inproc), spawnCall: stats(spawnMs) }));
}

// 2. rename-claim race: 8 processes each try to claim the same 50 jobs
for (const f of fs.readdirSync(queue)) fs.unlinkSync(path.join(queue, f));
for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(queue, `job-${i}.json`), '{}');
const claimer = `
const fs=require('fs'),path=require('path');const [q,r]=process.argv.slice(1);let won=[];
for(let i=0;i<50;i++){const n='job-'+i+'.json';try{fs.renameSync(path.join(q,n),path.join(r,n+'.'+process.pid));won.push(i);}catch(e){if(e.code!=='ENOENT'&&e.code!=='EPERM'&&e.code!=='EBUSY')throw e;}}
process.stdout.write(JSON.stringify(won));`;
const procs = Array.from({ length: 8 }, () => new Promise((res) => {
  const c = spawn(process.execPath, ['-e', claimer, queue, running]);
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', () => res(JSON.parse(out || '[]')));
}));
const results = await Promise.all(procs);
const all = results.flat();
const dup = all.length - new Set(all).size;
console.log('claim race', JSON.stringify({ claimed: all.length, unique: new Set(all).size, duplicates: dup, runningFiles: fs.readdirSync(running).length }));

// 3. fs.watch pickup latency
const lat = [];
const w = fs.watch(queue);
for (let i = 0; i < 20; i++) {
  const name = `w-${i}.json`;
  const p = new Promise((res) => {
    const on = (_e, f) => { if (f === name) { w.off('change', on); res(); } };
    w.on('change', on);
  });
  const t = performance.now();
  fs.writeFileSync(path.join(queue, `.${name}.tmp`), '{}');
  fs.renameSync(path.join(queue, `.${name}.tmp`), path.join(queue, name));
  await Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
  lat.push(performance.now() - t);
}
w.close();
console.log('fs.watch latency', JSON.stringify(stats(lat)));
