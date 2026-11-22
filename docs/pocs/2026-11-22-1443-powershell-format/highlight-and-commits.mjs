// (1) highlights.scm + our two captures compile and tag a sample (FR-8);
// (2) commit / PR counting on PowerShell commands: today's shared regex vs. the syntax tree (FR-12).
// Usage: node highlight-and-commits.mjs corpus-a.json [corpus-b.json ...]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Query } from 'web-tree-sitter';
import { loadParser, readCorpus } from './ps.mjs';
import { parseSrc, txt } from './ps-format.mjs';

const require = createRequire(import.meta.url);
const { parser, lang } = await loadParser();

// (1)
const scm = readFileSync(require.resolve('tree-sitter-powershell/queries/highlights.scm'), 'utf8')
  + '\n(command_parameter) @flag\n(redirection) @redirect\n';
const q = new Query(lang, scm);
const sample = 'Set-Content -Path out.txt -Value "x $a" 2>$null; if ($?) { git status > s.txt } # done';
const tree = parseSrc(parser, sample);
const caps = q.captures(tree.rootNode).map((c) => `${c.name}:${txt(c.node)}`);
console.log('captures:', caps.join('  '));
tree.delete();

// (2) server tool-stats.ts countCommits / countPullRequests, copied
const GIT_GLOBAL_FLAGS = String.raw`(?:(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[\w])\s+)*`;
const INVOCATION_START = String.raw`(?:^|[\n;&|])\s*`;
const countRe = (s, start) => (s.match(new RegExp(`${start}git(?:\\.exe)?\\s+${GIT_GLOBAL_FLAGS}commit(?![-\\w])`, 'g')) ?? []).length;
// a PowerShell-aware anchor: also after `{` `(` and the call operator `&`, and `git.exe`
const PS_START = String.raw`(?:^|[\n;&|{(])\s*(?:&\s*)?['"]?`;

const corpus = readCorpus(process.argv.slice(2));
let today = 0, psRegex = 0, viaTree = 0;
const diff = [];
for (const src of corpus) {
  const a = countRe(src, INVOCATION_START), b = countRe(src, PS_START);
  const t = parseSrc(parser, src);
  let c = 0;
  for (const cmd of t.rootNode.descendantsOfType('command')) {
    const n = cmd.childForFieldName('command_name');
    if (!n || !/^(.*[\\/])?git(\.exe)?['"]?$/i.test(txt(n))) continue;
    const words = (cmd.childForFieldName('command_elements')?.namedChildren ?? [])
      .filter((e) => e.type !== 'command_argument_sep').map((e) => txt(e));
    let k = 0;
    while (k < words.length && /^-/.test(words[k])) k += /^-[Cc]$/.test(words[k]) ? 2 : 1;
    if (words[k] === 'commit') c++;
  }
  t.delete();
  today += a; psRegex += b; viaTree += c;
  if (a !== c || b !== c) diff.push({ today: a, psRegex: b, tree: c, src: src.slice(0, 160) });
}
console.log({ commitsTodayRegex: today, commitsPsAnchor: psRegex, commitsTree: viaTree });
for (const d of diff.slice(0, 10)) console.log(d);
