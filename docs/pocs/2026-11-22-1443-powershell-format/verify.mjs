// Robustness run of ps-format.mjs over a corpus.
// Usage: node verify.mjs corpus-a.json [corpus-b.json ...] [--no-chain-break]
// Writes out-pairs.json ([{src, fmt}] for the PowerShell-parser oracle) and out-examples.md.
import { writeFileSync } from 'node:fs';
import { loadParser, readCorpus } from './ps.mjs';
import { makeFormatter, liftCd, foldHereStrings, parseSrc, txt, setMasking } from './ps-format.mjs';

const args = process.argv.slice(2);
const noChain = args.includes('--no-chain-break');
if (args.includes('--no-mask')) setMasking(false);
const corpus = readCorpus(args.filter((a) => !a.startsWith('--')));
const { parser } = await loadParser();
const { format } = makeFormatter({ breakChainOps: !noChain });

/** Leaf token texts, without whitespace and without statement-separating `;`. */
function tokens(src) {
  const tree = parseSrc(parser, src);
  const out = [];
  const walk = (n) => {
    if (n.type === 'empty_statement') return;
    if (!n.childCount) { const t = txt(n); if (t.trim()) out.push(n.type === 'ERROR' ? `ERR:${t.trim()}` : t); return; }
    for (const c of n.children) walk(c);
  };
  walk(tree.rootNode);
  const err = tree.rootNode.hasError;
  tree.delete();
  return { out, err };
}

const r = { total: corpus.length, exceptions: 0, ok: 0, partial: 0, fallback: 0, changed: 0, reparseErr: 0, sameTokens: 0, idem: 0, lift: 0, folded: 0, linesIn: 0, linesOut: 0, ms: 0, maxMs: 0 };
const bad = [];
const pairs = [];
const examples = [];
for (const src of corpus) {
  try {
    const t0 = performance.now();
    const f = format(parser, src);
    const lifted = f.ok ? liftCd(parser, src, f.script) : { workDir: null, script: f.script };
    const fold = f.ok ? foldHereStrings(parser, src, lifted.script) : { folded: [] };
    const dt = performance.now() - t0;
    r.ms += dt; r.maxMs = Math.max(r.maxMs, dt);
    if (!f.ok) { r.fallback++; continue; }
    if (f.partial) r.partial++; else r.ok++;
    if (lifted.workDir) r.lift++;
    if (fold.folded.length) r.folded++;
    r.linesIn += src.split('\n').length;
    r.linesOut += f.script.split('\n').length;
    if (f.script !== src) r.changed++;
    const a = tokens(src), b = tokens(f.script);
    if (b.err && !a.err) r.reparseErr++;
    const same = a.out.length === b.out.length && a.out.every((x, i) => x === b.out[i]);
    if (same) r.sameTokens++; else bad.push({ src, fmt: f.script });
    if (format(parser, f.script).script === f.script) r.idem++;
    pairs.push({ src, fmt: f.script });
    if (f.script !== src && examples.length < 400) examples.push({ src, f, lifted });
  } catch (e) {
    r.exceptions++;
    bad.push({ src, error: String(e && e.stack || e) });
  }
}
r.ms = +(r.ms / corpus.length).toFixed(2);
r.maxMs = +r.maxMs.toFixed(1);
console.log(r);
import('./ps-format.mjs').then((m) => console.log('masks used (commands):', m.maskStats));
writeFileSync('out-pairs.json', JSON.stringify(pairs));
writeFileSync('out-bad.json', JSON.stringify(bad, null, 1));
writeFileSync('out-examples.md', examples.map(({ src, f, lifted }) =>
  `---\n${f.partial ? '(partial)\n' : ''}\`\`\`powershell\n${src}\n\`\`\`\n${lifted.workDir ? `WORKING DIR: ${lifted.workDir}\n` : ''}\`\`\`powershell\n${lifted.script}\n\`\`\`\n`).join('\n'));
console.log(`bad: ${bad.length} → out-bad.json; examples → out-examples.md; oracle pairs → out-pairs.json`);
