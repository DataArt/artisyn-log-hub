// Builds blinded A/B packs for judge agents from out/*.json: out/judge/<id>.md + out/judge/key.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
const judgeDir = path.join(outDir, 'judge');
fs.mkdirSync(judgeDir, { recursive: true });

function render(v) {
  if (!v || v.error) return `(failed: ${v ? v.error : 'no output'})`;
  const list = (xs) => (xs && xs.length ? xs.map((x) => `- ${x}`).join('\n') : '(empty)');
  return `Summary: ${v.general}\n\nCost factors:\n${list(v.costFactors)}\n\nAdvice:\n${list(v.harnessAdvice)}`;
}

const key = {};
for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.json') && x !== 'ab-key.json')) {
  const rec = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
  const flip = Math.random() < 0.5;
  key[rec.id] = flip ? { A: 'v2', B: 'v1' } : { A: 'v1', B: 'v2' };
  const a = flip ? rec.v2 : rec.v1;
  const b = flip ? rec.v1 : rec.v2;
  fs.writeFileSync(
    path.join(judgeDir, `${rec.id}.md`),
    `# Session ${rec.id}\n\n## Variant A\n\n${render(a)}\n\n## Variant B\n\n${render(b)}\n`,
  );
}
fs.writeFileSync(path.join(outDir, 'ab-key.json'), JSON.stringify(key, null, 2));
console.log(Object.keys(key).length, 'packs');
