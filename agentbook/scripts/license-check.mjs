// Licence check for AgentBook's own dependencies. Part of `npm run lint`.
// Reads every Rust package from `cargo metadata --format-version 1 --locked` and fails, naming each
// package, when its licence is not on the permissive allowlist. The allowlist is Work Hub's
// (work-hub/scripts/license-check.mjs), with NO reviewed exceptions: in particular no font
// exception, so egui's bundled fonts (OFL, Ubuntu-font) must stay disabled and the UI uses OS fonts.
// AgentBook has no npm dependencies, so only Cargo is read.
// SPDX expressions are evaluated: `A OR B` passes when one side passes, `A AND B` when both do;
// `X WITH LLVM-exception` counts as X. The old cargo form `A/B` means `A OR B`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  '0BSD',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'CDLA-Permissive-2.0',
  'CC0-1.0',
]);

// Exceptions only add permissions to the licence they modify.
const ALLOWED_EXCEPTIONS = new Set(['LLVM-exception']);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tokenize(expr) {
  return expr
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter((t) => t !== '');
}

// Recursive-descent SPDX evaluator: or := and ('OR' and)*; and := atom ('AND' atom)*;
// atom := '(' or ')' | id ['WITH' exception]. Returns true when the expression is permitted.
function isAllowedExpression(expr) {
  const tokens = tokenize(expr.replace(/\//g, ' OR '));
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let ok = parseAnd();
    while (peek() !== undefined && peek().toUpperCase() === 'OR') {
      next();
      const right = parseAnd();
      ok = ok || right;
    }
    return ok;
  }
  function parseAnd() {
    let ok = parseAtom();
    while (peek() !== undefined && peek().toUpperCase() === 'AND') {
      next();
      const right = parseAtom();
      ok = ok && right;
    }
    return ok;
  }
  function parseAtom() {
    const t = next();
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const ok = parseOr();
      if (next() !== ')') throw new Error('missing )');
      return ok;
    }
    let ok = ALLOWED.has(t.replace(/\+$/, ''));
    if (peek() !== undefined && peek().toUpperCase() === 'WITH') {
      next();
      const exception = next();
      ok = ok && exception !== undefined && ALLOWED_EXCEPTIONS.has(exception);
    }
    return ok;
  }

  try {
    const ok = parseOr();
    return pos === tokens.length && ok;
  } catch {
    return false;
  }
}

try {
  const raw = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300000,
  });
  const meta = JSON.parse(raw);
  const bad = [];
  const packages = [...meta.packages].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  for (const p of packages) {
    const name = `crate ${p.name}@${p.version}`;
    if (!p.license) bad.push(`${name}: no licence declared`);
    else if (!isAllowedExpression(p.license)) bad.push(`${name}: ${p.license}`);
  }
  if (bad.length > 0) {
    process.stderr.write(`license-check: ${bad.length} package(s) with a licence outside the allowlist:\n`);
    for (const line of bad) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }
  process.stdout.write(`license-check: ${packages.length} packages, all on the allowlist.\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`license-check error: ${err.message}\n`);
  process.exit(1);
}
