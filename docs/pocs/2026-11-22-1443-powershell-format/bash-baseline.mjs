// Baseline for FR-6 ("not worse than Bash"): share of real Bash commands that tree-sitter-bash
// cannot parse (→ raw fallback in the shipped Bash view, rule 1 of bash-command-view.md).
// Usage: node bash-baseline.mjs <bash-corpus.json>   (JSON array of Bash command strings)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
// the repo client's pinned grammar (tree-sitter-bash 0.25.1), resolved relative to this PoC
const wasm = require.resolve('tree-sitter-bash/tree-sitter-bash.wasm', { paths: [new URL('../../../client/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] });
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(wasm));
const corpus = [...new Set(JSON.parse(readFileSync(process.argv[2], 'utf8')))].filter((c) => c && c.trim());
let err = 0;
for (const c of corpus) { const t = parser.parse(c); if (t.rootNode.hasError) err++; t.delete(); }
console.log(`bash commands: ${corpus.length}, parse errors (raw fallback): ${err} (${((err / corpus.length) * 100).toFixed(2)} %)`);
