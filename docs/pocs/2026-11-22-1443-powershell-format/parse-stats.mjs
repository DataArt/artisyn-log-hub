// Parse rate of tree-sitter-powershell over a corpus + what the error nodes look like.
// Usage: node parse-stats.mjs corpus-a.json [corpus-b.json ...] [--show N]
import { loadParser, readCorpus } from './ps.mjs';

const args = process.argv.slice(2);
const showAt = args.indexOf('--show');
const show = showAt >= 0 ? Number(args.splice(showAt, 2)[1]) : 0;
const corpus = readCorpus(args);
const { parser } = await loadParser();

/** Features we suspect the grammar may miss — regex over the raw text, only for grouping. */
const FEATURES = {
  ternary: /\s\?\s[^\n]*\s:\s/,
  nullCoalesce: /\?\?/,
  nullCond: /\?\.|\?\[/,
  chainOps: /\s(&&|\|\|)\s/,
  hereString: /@['"]\r?\n/,
  backtickLine: /`\r?\n/,
  cmdDashDash: /\s--%\s/,
  bom: /^\uFEFF/,
  crlf: /\r\n/,
};

let errors = 0;
const byFeature = {};
const firstErr = [];
const t0 = performance.now();
let maxMs = 0;
for (const src of corpus) {
  const s = performance.now();
  const tree = parser.parse(src);
  maxMs = Math.max(maxMs, performance.now() - s);
  const root = tree.rootNode;
  if (root.hasError) {
    errors++;
    const feats = Object.entries(FEATURES).filter(([, re]) => re.test(src)).map(([k]) => k);
    const key = feats.join('+') || '(none)';
    byFeature[key] = (byFeature[key] || 0) + 1;
    // smallest error / missing node → a context snippet
    let err = null;
    const walk = (n) => {
      if (err) return;
      if (n.type === 'ERROR' || n.isMissing) { err = n; return; }
      for (const c of n.children) if (c.hasError || c.isMissing || c.type === 'ERROR') walk(c);
    };
    walk(root);
    const at = err ? err.startIndex : 0;
    firstErr.push({ key, snippet: src.slice(Math.max(0, at - 50), at + 60).replace(/\s+/g, ' '), len: src.length });
  }
  tree.delete();
}
const total = performance.now() - t0;
console.log(`commands: ${corpus.length}`);
console.log(`parse errors: ${errors} (${((errors / corpus.length) * 100).toFixed(2)} %)`);
console.log(`time: ${(total / corpus.length).toFixed(2)} ms avg, ${maxMs.toFixed(1)} ms max`);
console.log('errors by suspected feature:', byFeature);
for (const e of firstErr.slice(0, show)) console.log(`- [${e.key}] …${e.snippet}…`);
