// Prints the syntax tree of one command (argv[2]) or of a file with one command (argv[3] = --file).
import { readFileSync } from 'node:fs';
import { loadParser, dump } from './ps.mjs';

const { parser } = await loadParser();
const src = process.argv[2] === '--file' ? readFileSync(process.argv[3], 'utf8') : process.argv[2];
const tree = parser.parse(src);
console.log(dump(tree.rootNode));
console.log('hasError:', tree.rootNode.hasError);
