// Usage (from this folder): node static-scan.mjs
// Greps hook + installer sources for Node APIs added after 18.19.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs = ['hook/.claude/telemetry_tool', 'artisyn-hooks-installer/src'];
// API -> first Node version where it is stable/unflagged
const apis = {
  'fs.globSync|fs.promises.glob|\\bglob\\(': '22',
  'process.getBuiltinModule': '22.3',
  'require\\(esm|import\\.meta\\.(dirname|filename)': '20.11/22',
  'Array\\.fromAsync': '22',
  'Promise\\.withResolvers': '22',
  'Object\\.groupBy|Map\\.groupBy': '21',
  '\\.toSorted\\(|\\.toReversed\\(|\\.toSpliced\\(|\\.with\\(': '20',
  'navigator\\.': '21',
  'WebSocket\\b': '22',
  'node:sqlite': '22.5',
  'util\\.styleText|styleText\\(': '20.12/21.7',
  'util\\.parseEnv|process\\.loadEnvFile': '20.12/21.7',
  'fs\\.openAsBlob': '19.8',
  'AbortSignal\\.any': '20.3',
  'isWellFormed|toWellFormed': '20',
  'Symbol\\.dispose|\\busing\\s+\\w+\\s*=': '20.4/22',
  'setDefaultAutoSelectFamily|--experimental-|stripTypeScriptTypes': 'check',
};
const files = dirs.flatMap(d => fs.readdirSync(path.join(repo, d)).filter(f => /\.(js|ts)$/.test(f)).map(f => path.join(d, f)));
let hits = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(repo, f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    for (const [re, ver] of Object.entries(apis)) {
      if (new RegExp(re).test(l) && !/^\s*(\/\/|\*)/.test(l)) { hits++; console.log(`${f}:${i + 1} [${ver}] ${l.trim().slice(0, 140)}`); }
    }
  });
}
console.log(`scanned ${files.length} files, ${hits} hit(s)`);
