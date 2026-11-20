// Race check for an exclusive-create claim: 8 processes each try to claim the same 50 jobs by
// creating `<job>.claim` with flag 'wx' (O_CREAT|O_EXCL). Repeated 5 rounds.
// Usage: node claim-wx.mjs   (writes only under ./work/claim/)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'work', 'claim');
const claimer = `
const fs=require('fs'),path=require('path');const d=process.argv[1];let won=[];
for(let i=0;i<50;i++){try{const fd=fs.openSync(path.join(d,'job-'+i+'.json.claim'),'wx');fs.writeSync(fd,String(process.pid));fs.closeSync(fd);won.push(i);}catch(e){if(e.code!=='EEXIST')throw e;}}
process.stdout.write(JSON.stringify(won));`;
for (let round = 0; round < 5; round++) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => {
    const c = spawn(process.execPath, ['-e', claimer, dir]);
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', () => res(JSON.parse(out || '[]')));
  })));
  const all = results.flat();
  console.log(`round ${round}`, JSON.stringify({ claimed: all.length, unique: new Set(all).size, duplicates: all.length - new Set(all).size }));
}
