// Licence check for Work Hub's own dependencies (plan D20). Part of `npm run lint`.
// Reads every Rust package from `cargo metadata --format-version 1` and every installed npm
// package.json under web/node_modules and node_modules, and fails, naming each package, when a
// licence is not on the permissive allowlist. SPDX expressions are evaluated: `A OR B` passes when
// one side passes, `A AND B` when both do; `X WITH LLVM-exception` counts as X. The old cargo
// form `A/B` means `A OR B`.
// The file is .mjs because work-hub/package.json is "type": "module"; the code itself stays
// synchronous and uses only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// Reviewed packages whose licence is outside the allowlist. Each entry is pinned to the package
// name AND its exact licence, so another package with the same licence (or this package changing
// its licence) still fails. All of them are build or lint tools of the web UI: none is linked into
// the server binary or bundled into the shipped SPA.
// No MPL / weak-copyleft exception is allowed (owner, 2026-11-14): Tailwind, which pulled the
// MPL-2.0 lightningcss, was removed from the web UI instead.
const REVIEWED = [
  {
    name: /^caniuse-lite$/,
    license: 'CC-BY-4.0',
    reason: 'browser-support data read by browserslist at build time',
  },
  { name: /^argparse$/, license: 'Python-2.0', reason: 'permissive; js-yaml dependency of eslint' },
  { name: /^minimatch$/, license: 'BlueOak-1.0.0', reason: 'permissive; eslint dependency' },
  { name: /^graceful-fs$/, license: 'BlueOak-1.0.0', reason: 'permissive; build dependency' },
];

function isReviewed(pkgName, license) {
  return REVIEWED.some((r) => r.name.test(pkgName) && r.license === license);
}

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

function npmLicenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Walks one node_modules folder: scoped folders, nested node_modules and bun's `.bun` store.
function walkNodeModules(dir, out, seenDirs) {
  if (!fs.existsSync(dir)) return;
  const real = fs.realpathSync(dir);
  if (seenDirs.has(real)) return;
  seenDirs.add(real);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === '.bin' || entry.name === '.cache' || entry.name.startsWith('.vite')) continue;
    if (entry.name === '.bun') {
      for (const store of fs.readdirSync(full, { withFileTypes: true })) {
        walkNodeModules(path.join(full, store.name, 'node_modules'), out, seenDirs);
      }
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
        visitPackage(path.join(full, scoped.name), out, seenDirs);
      }
      continue;
    }
    visitPackage(full, out, seenDirs);
  }
}

function visitPackage(pkgDir, out, seenDirs) {
  const manifest = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifest)) return;
  const pkg = readJson(manifest);
  if (pkg.name && pkg.version) {
    out.set(`npm ${pkg.name}@${pkg.version}`, { pkgName: pkg.name, license: npmLicenseOf(pkg) });
  }
  walkNodeModules(path.join(pkgDir, 'node_modules'), out, seenDirs);
}

function collectCargo(out) {
  const raw = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300000,
  });
  const meta = JSON.parse(raw);
  for (const p of meta.packages) {
    out.set(`crate ${p.name}@${p.version}`, { pkgName: null, license: p.license || null });
  }
}

try {
  const found = new Map();
  collectCargo(found);
  const seenDirs = new Set();
  walkNodeModules(path.join(ROOT, 'web', 'node_modules'), found, seenDirs);
  walkNodeModules(path.join(ROOT, 'node_modules'), found, seenDirs);

  const bad = [];
  for (const [name, { pkgName, license }] of [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (license === null) bad.push(`${name}: no licence declared`);
    else if (isAllowedExpression(license)) continue;
    else if (pkgName !== null && isReviewed(pkgName, license)) continue;
    else bad.push(`${name}: ${license}`);
  }
  if (bad.length > 0) {
    process.stderr.write(`license-check: ${bad.length} package(s) with a licence outside the allowlist (plan D20):\n`);
    for (const line of bad) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }
  process.stdout.write(`license-check: ${found.size} packages, all on the allowlist.\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`license-check error: ${err.message}\n`);
  process.exit(1);
}
