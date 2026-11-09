// Usage (from this folder): node run.mjs [18.19 20 22 ...]
// Runs in-container.mjs in node:<ver>-slim with the repo mounted read-only.
// Writes per-version logs to ./out/ (gitignored). Containers use --rm.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['18.19', '20', '22'];
fs.mkdirSync(path.join(here, 'out'), { recursive: true });

const summary = [];
for (const v of versions) {
  const image = `node:${v}-slim`;
  const inner = 'apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null 2>&1; '
    + 'git config --global user.email poc@example.invalid; git config --global user.name poc; '
    + 'node /poc/in-container.mjs';
  const r = spawnSync('docker', ['run', '--rm', '-v', `${repo}:/repo:ro`, '-v', `${here}:/poc:ro`, image, 'sh', '-c', inner],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, timeout: 600000 });
  const out = `${r.stdout}\n${r.stderr}`;
  fs.writeFileSync(path.join(here, 'out', `node-${v}.log`), out);
  const line = out.split('\n').find(l => l.startsWith('SUMMARY')) || `SUMMARY ${v}: no summary (exit ${r.status})`;
  summary.push(`${line}  [exit ${r.status}]`);
  console.log(out.split('\n').filter(l => /^(PASS|FAIL|node v)/.test(l)).join('\n'));
}
console.log('\n' + summary.join('\n'));
process.exit(summary.every(s => s.endsWith('[exit 0]')) ? 0 : 1);
