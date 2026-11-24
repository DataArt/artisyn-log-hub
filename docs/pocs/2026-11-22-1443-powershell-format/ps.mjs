// Shared loader: web-tree-sitter + tree-sitter-powershell, plus corpus reading.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export async function loadParser() {
  await Parser.init();
  const lang = await Language.load(require.resolve('tree-sitter-powershell/tree-sitter-powershell.wasm'));
  const parser = new Parser();
  parser.setLanguage(lang);
  return { parser, lang };
}

/** Reads one or more JSON arrays of command strings, dedupes, drops empties. */
export function readCorpus(files) {
  const all = new Set();
  for (const f of files) for (const c of JSON.parse(readFileSync(f, 'utf8'))) if (c && c.trim()) all.add(c);
  return [...all];
}

/** S-expression-like dump with field names, for exploring the grammar. */
export function dump(node, ind = '') {
  const kids = node.children;
  const head = `${ind}${node.isNamed ? node.type : JSON.stringify(node.type)}${node.isMissing ? ' MISSING' : ''}`;
  if (!kids.length) return `${head} ${JSON.stringify(node.text.slice(0, 60))}`;
  return [head, ...kids.map((k, i) => {
    const f = node.fieldNameForChild(i);
    return dump(k, ind + '  ' + (f ? f + ': ' : ''));
  })].join('\n');
}
