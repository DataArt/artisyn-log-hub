// Lists local sessions of this repo with KB-access counts and approximate cost, to pick a sample.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractSession } from './extract.mjs';

const projectDir = path.join(os.homedir(), '.claude/projects/D---work-Artisyn-LogHub--repo');
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const rows = [];
for (const f of fs.readdirSync(projectDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const id = f.slice(0, -6);
  const s = extractSession(projectDir, id, repoRoot);
  if (!s.prompts.length) continue;
  rows.push({
    id: id.slice(0, 8),
    date: (s.firstTs || '').slice(0, 16),
    prompts: s.prompts.length,
    kbCalls: s.accesses.length,
    kbFiles: new Set(s.accesses.map((a) => a.path)).size,
    kbKB: Math.round(s.accesses.reduce((n, a) => n + a.bytes, 0) / 1024),
    changed: s.changed.length,
    usd: Number(s.sessionCostUsd.toFixed(2)),
    first: s.prompts[0].replace(/\s+/g, ' ').slice(0, 60),
  });
}
rows.sort((a, b) => a.date.localeCompare(b.date));
console.table(rows);
