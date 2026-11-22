// Writes out-fallbacks.json ({src, fmt: src} for every command the formatter leaves raw), so
// oracle.ps1 can tell whether real PowerShell parses them.
import { writeFileSync } from 'node:fs';
import { loadParser, readCorpus } from './ps.mjs';
import { makeFormatter } from './ps-format.mjs';

const { parser } = await loadParser();
const { format } = makeFormatter();
const fb = readCorpus(process.argv.slice(2)).filter((src) => !format(parser, src).ok);
writeFileSync('out-fallbacks.json', JSON.stringify(fb.map((src) => ({ src, fmt: src }))));
console.log(`fallbacks: ${fb.length} → out-fallbacks.json`);
for (const s of fb) console.log('-', s.slice(0, 160).replace(/\s+/g, ' '));
