#!/usr/bin/env node
'use strict';

// Generates the in-app help pages (client/public/help/<slug>.md) from the user-docs page set.
//
//   node scripts/user-docs/generate-help.js [--out <dir>] [--check]
//
// For every page in user-docs/nav.json: every relative link must resolve to a page of the set
// (scripts/user-docs/links.js) — otherwise prints `<file>: <href>` to stderr and exits 1. Then
// writes <out>/<slug>.md with page links rewritten to `<slug>.md[#anchor]`; a page without such
// links is copied byte-for-byte. Stale *.md files in <out> that are not in the nav are deleted.
// Images a page links to (`kind: 'asset'`, user-docs/images/<name>) must exist; they are copied to
// <out>/images/, and stale *.svg/*.png there are deleted.
// --check validates only and writes nothing. Idempotent. Exit 0 = ok, 1 = error.

const fs = require('fs');
const path = require('path');
const { loadNav, resolveLink, findLinks, rewritePageLinks } = require('./links.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const opts = { out: path.join(REPO_ROOT, 'client', 'public', 'help'), check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out needs a directory');
      opts.out = path.resolve(value);
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The output dir is emptied of stale *.md files, so it must be a dedicated folder inside the repo.
function assertSafeOut(out) {
  const root = path.resolve(REPO_ROOT);
  const forbidden = [path.join(root, 'user-docs'), path.join(root, 'hook')];
  if (!isInside(out, root) || forbidden.some((dir) => out === dir || isInside(dir, out) || isInside(out, dir))) {
    throw new Error(`refusing --out ${out}: must be a dedicated folder inside the repository`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.check) assertSafeOut(opts.out);
  const nav = loadNav(REPO_ROOT);

  const problems = [];
  const outputs = [];
  const assets = new Set();
  for (const page of nav.pages) {
    const rel = path.relative(REPO_ROOT, page.file).split(path.sep).join('/');
    if (!fs.existsSync(page.file)) {
      problems.push(`${rel}: missing source file for page "${page.slug}"`);
      continue;
    }
    const bytes = fs.readFileSync(page.file);
    const text = bytes.toString('utf8');
    for (const href of findLinks(text)) {
      const res = resolveLink(href, page.file, nav);
      if (res.kind === 'unresolved') problems.push(`${rel}: ${href}`);
      if (res.kind !== 'asset') continue;
      if (fs.existsSync(path.join(REPO_ROOT, 'user-docs', res.path))) assets.add(res.path);
      else problems.push(`${rel}: ${href} (missing user-docs/${res.path})`);
    }
    const rewritten = rewritePageLinks(text, page.file, nav);
    outputs.push({ slug: page.slug, data: rewritten === text ? bytes : Buffer.from(rewritten, 'utf8') });
  }

  if (problems.length > 0) {
    process.stderr.write('generate-help: unresolved links in user docs:\n');
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  if (opts.check) {
    process.stderr.write(`generate-help: ${outputs.length} pages, all links resolve\n`);
    return 0;
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const wanted = new Set(outputs.map((o) => `${o.slug}.md`));
  for (const name of fs.readdirSync(opts.out)) {
    if (name.endsWith('.md') && !wanted.has(name)) fs.unlinkSync(path.join(opts.out, name));
  }
  for (const o of outputs) {
    const target = path.join(opts.out, `${o.slug}.md`);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(o.data)) continue;
    fs.writeFileSync(target, o.data);
  }
  const imagesOut = path.join(opts.out, 'images');
  if (assets.size > 0) fs.mkdirSync(imagesOut, { recursive: true });
  if (fs.existsSync(imagesOut)) {
    for (const name of fs.readdirSync(imagesOut)) {
      if (/\.(?:svg|png)$/.test(name) && !assets.has(`images/${name}`)) fs.unlinkSync(path.join(imagesOut, name));
    }
  }
  for (const asset of assets) {
    const data = fs.readFileSync(path.join(REPO_ROOT, 'user-docs', asset));
    const target = path.join(opts.out, asset);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(data)) continue;
    fs.writeFileSync(target, data);
  }
  process.stderr.write(`generate-help: wrote ${outputs.length} pages and ${assets.size} images to ${path.relative(REPO_ROOT, opts.out) || '.'}\n`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`generate-help error: ${err.message}\n`);
  process.exit(1);
}
