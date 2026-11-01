#!/usr/bin/env node
// Pre-renders the Log Hub static site (GitHub Pages) into tmp/site/ (impl-plan DD-18, DD-19):
//
//   index.html, features.html,    site/pages/{home,features,questions}.html wrapped by layout.mjs
//   questions.html
//   docs/<slug>.html              every user-docs/nav.json page (markdown → HTML, heading ids, TOC)
//   docs/images/                  the user-docs/images/ files those pages link to
//   deck/                         copy of site/deck/ with placeholders filled in every .html
//   assets/                       copy of site/assets/
//
// ESM exemption from the nodejs-script CJS rule: unified/remark/rehype are ESM-only packages
// (precedent: scripts/scenarios/*.mjs). Everything else follows the rule — sync file I/O,
// path.join, diagnostics on stderr, explicit exit codes.
//
// Validation (all errors are collected and printed, then exit 1, nothing is written):
//   - every relative link in every page resolves to a nav page (scripts/user-docs/links.js);
//   - site/data/example-dataset.json is consistent (dataset.mjs checkDataset);
//   - every {{ds:…}} / {{site:…}} placeholder in Home, Features and the deck is known.
// Docs pages get {{RETENTION_DAYS}} replaced by a generic phrase (DD-16).
//
// Output guard: --out must be inside the repo and not the repo root. An existing output folder is
// emptied only when it carries this script's marker file (or is empty) — never anything else.
//
// Usage: node scripts/site/build-site.mjs [--out <dir>]     (default tmp/site, relative to cwd)
// Exit codes: 0 site written, 1 validation or build failure, 2 bad arguments / refused --out.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { checkDataset, fillPlaceholders } from './dataset.mjs';
import { RELEASES_URL, REPO_URL, SITE_NAME, SITE_URL, page } from './layout.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadNav, resolveLink, findLinks } = require(path.join(ROOT, 'scripts', 'user-docs', 'links.js'));

const SITE_DIR = path.join(ROOT, 'site');
const MARKER = '.loghub-site-output';
const RETENTION_PHRASE = 'the retention period configured on your server (default 30 days)';
const SITE_VALUES = { url: SITE_URL, repo: REPO_URL, releases: RELEASES_URL };
const SITE_RE = /\{\{site:([^}]*)\}\}/g;
const LEFTOVER_RE = /\{\{(?:ds|site):[^}]*\}\}/;

function fail(code, lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(code);
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function parseArgs(argv) {
  let out = path.join('tmp', 'site');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && i + 1 < argv.length) {
      out = argv[++i];
    } else if (argv[i].startsWith('--out=')) {
      out = argv[i].slice('--out='.length);
    } else {
      fail(2, [`build-site: unknown argument: ${argv[i]}`, 'usage: node scripts/site/build-site.mjs [--out <dir>]']);
    }
  }
  if (!out) fail(2, ['build-site: --out needs a directory']);
  return { out: path.resolve(process.cwd(), out) };
}

function checkOutDir(out) {
  const r = path.relative(ROOT, out);
  if (r === '' || r.startsWith('..') || path.isAbsolute(r)) {
    fail(2, [`build-site: refusing --out ${out}: it must be a folder inside the repository, not the repository root`]);
  }
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) fail(2, [`build-site: refusing --out ${out}: not a directory`]);
    const entries = fs.readdirSync(out);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      fail(2, [`build-site: refusing --out ${out}: folder is not empty and was not created by this script`]);
    }
  }
}

function fillSite(text) {
  return text.replace(SITE_RE, (_m, key) => {
    const k = key.trim();
    if (!Object.prototype.hasOwnProperty.call(SITE_VALUES, k)) throw new Error(`unknown site key: ${k}`);
    return SITE_VALUES[k];
  });
}

/** Fills {{site:…}} and {{ds:…}}; throws on an unknown key/format or a malformed leftover. */
function fillAll(text, ds) {
  const filled = fillPlaceholders(fillSite(text), ds);
  const left = LEFTOVER_RE.exec(filled);
  if (left) throw new Error(`unfilled placeholder: ${left[0]}`);
  return filled;
}

function substituteRetention(md) {
  return md.split('{{RETENTION_DAYS}} days').join(RETENTION_PHRASE).split('{{RETENTION_DAYS}}').join(RETENTION_PHRASE);
}

function walk(node, fn) {
  fn(node);
  if (Array.isArray(node.children)) for (const child of node.children) walk(child, fn);
}

function hastText(node) {
  if (node.type === 'text') return node.value;
  return Array.isArray(node.children) ? node.children.map(hastText).join('') : '';
}

/** remark plugin: page links → `<slug>.html[#anchor]`; reports links links.js cannot resolve. */
function remarkSiteLinks({ fromFile, nav, errors }) {
  return (tree) => {
    walk(tree, (node) => {
      if ((node.type !== 'link' && node.type !== 'definition' && node.type !== 'image') || typeof node.url !== 'string') return;
      const res = resolveLink(node.url, fromFile, nav);
      if (res.kind === 'asset') {
        node.url = res.path; // copied to docs/images/, next to the page
      } else if (res.kind === 'page') {
        node.url = res.anchor === null ? `${res.slug}.html` : `${res.slug}.html#${res.anchor}`;
      } else if (res.kind === 'unresolved') {
        errors.push(`${rel(fromFile)}: ${node.url}`);
      }
    });
  };
}

/**
 * remark plugin: a fenced block whose info string carries `diagram=<name>` (e.g. ```text diagram=architecture)
 * becomes a Mermaid figure from site/diagrams/<name>.mmd, with the original block kept as its
 * "Text version". The in-app help and GitHub ignore the meta and show the text block as before.
 */
function remarkSiteDiagrams({ fromFile, errors }) {
  return (tree, file) => {
    walk(tree, (node) => {
      if (node.type !== 'code' || typeof node.meta !== 'string') return;
      const m = /(?:^|\s)diagram=([a-z0-9-]+)(?:\s|$)/.exec(node.meta);
      if (!m) return;
      const src = path.join(SITE_DIR, 'diagrams', `${m[1]}.mmd`);
      if (!fs.existsSync(src)) {
        errors.push(`${rel(fromFile)}: diagram ${m[1]} has no ${rel(src)}`);
        return;
      }
      const mmd = fs.readFileSync(src, 'utf8');
      const text = node.value;
      file.data.hasDiagram = true;
      node.type = 'siteDiagram';
      delete node.value;
      node.data = {
        hName: 'figure',
        hProperties: { className: ['diagram'] },
        hChildren: [
          { type: 'element', tagName: 'pre', properties: { className: ['mermaid'] }, children: [{ type: 'text', value: mmd }] },
          {
            type: 'element',
            tagName: 'details',
            properties: { open: true },
            children: [
              { type: 'element', tagName: 'summary', properties: {}, children: [{ type: 'text', value: 'Text version' }] },
              { type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: text }] }] },
            ],
          },
        ],
      };
    });
  };
}

/** rehype plugin (after rehype-slug): collects h2/h3 into file.data.toc. */
function rehypeToc() {
  return (tree, file) => {
    const toc = [];
    walk(tree, (node) => {
      if (node.type === 'element' && (node.tagName === 'h2' || node.tagName === 'h3') && node.properties && node.properties.id) {
        toc.push({ depth: node.tagName === 'h2' ? 2 : 3, id: String(node.properties.id), text: hastText(node).trim() });
      }
    });
    file.data.toc = toc;
  };
}

function renderMarkdown(md, fromFile, nav, errors) {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkSiteLinks, { fromFile, nav, errors })
    .use(remarkSiteDiagrams, { fromFile, errors })
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeToc)
    .use(rehypeStringify)
    .processSync(md);
  return { html: String(file), toc: file.data.toc || [], diagrams: file.data.hasDiagram === true };
}

function readUtf8(p, errors) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    errors.push(`${rel(p)}: cannot read (${err.code || err.message})`);
    return null;
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  checkOutDir(out);

  const errors = [];
  const nav = loadNav(ROOT);
  const files = new Map();

  // Link validation over the raw markdown (same scanner as the help generator).
  const sources = new Map();
  for (const p of nav.pages) {
    const md = readUtf8(p.file, errors);
    if (md === null) continue;
    sources.set(p.slug, md);
    for (const href of findLinks(md)) {
      const res = resolveLink(href, p.file, nav);
      if (res.kind === 'unresolved') errors.push(`${rel(p.file)}: ${href}`);
      if (res.kind !== 'asset') continue;
      const src = path.join(ROOT, 'user-docs', res.path);
      if (fs.existsSync(src)) files.set(path.join('docs', res.path), fs.readFileSync(src));
      else errors.push(`${rel(p.file)}: ${href} (missing user-docs/${res.path})`);
    }
  }

  // Dataset.
  let ds = null;
  const dsFile = path.join(SITE_DIR, 'data', 'example-dataset.json');
  const dsText = readUtf8(dsFile, errors);
  if (dsText !== null) {
    try {
      ds = JSON.parse(dsText);
    } catch (err) {
      errors.push(`${rel(dsFile)}: invalid JSON (${err.message})`);
    }
  }
  if (ds !== null) for (const e of checkDataset(ds)) errors.push(`${rel(dsFile)}: ${e}`);

  if (errors.length === 0) {
    // Docs pages.
    const linkErrors = [];
    nav.pages.forEach((p, i) => {
      const md = sources.get(p.slug);
      if (md === undefined) return;
      const { html, toc, diagrams } = renderMarkdown(substituteRetention(md), p.file, nav, linkErrors);
      const prev = i > 0 ? nav.pages[i - 1] : undefined;
      const next = i < nav.pages.length - 1 ? nav.pages[i + 1] : undefined;
      files.set(path.join('docs', `${p.slug}.html`), page({
        title: p.title,
        depth: 1,
        nav,
        activeSection: p.section,
        activeSlug: p.slug,
        body: html,
        toc,
        prevNext: { prev, next },
        diagrams,
      }));
    });
    for (const e of linkErrors) if (!errors.includes(e)) errors.push(e);

    // Home and Features.
    for (const [name, title, activeSection] of [['home', SITE_NAME, 'home'], ['features', 'Features', 'features'], ['questions', 'Questions', 'questions']]) {
      const src = path.join(SITE_DIR, 'pages', `${name}.html`);
      const text = readUtf8(src, errors);
      if (text === null) continue;
      try {
        const body = fillAll(text, ds);
        files.set(name === 'home' ? 'index.html' : `${name}.html`, page({ title, depth: 0, nav, activeSection, body }));
      } catch (err) {
        errors.push(`${rel(src)}: ${err.message}`);
      }
    }

    // Deck (standalone pages; placeholders filled in every .html) and assets (copied as is).
    for (const [dir, target, fill] of [[path.join(SITE_DIR, 'deck'), 'deck', true], [path.join(SITE_DIR, 'assets'), 'assets', false]]) {
      if (!fs.existsSync(dir)) {
        if (fill) errors.push(`${rel(dir)}: missing`);
        continue;
      }
      for (const f of listFiles(dir)) {
        const src = path.join(dir, f);
        if (fill && f.toLowerCase().endsWith('.html')) {
          try {
            files.set(path.join(target, f), fillAll(fs.readFileSync(src, 'utf8'), ds));
          } catch (err) {
            errors.push(`${rel(src)}: ${err.message}`);
          }
        } else {
          files.set(path.join(target, f), fs.readFileSync(src));
        }
      }
    }
  }

  if (errors.length > 0) {
    fail(1, ['build-site: failed —', ...errors.map((e) => `  ${e}`)]);
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), 'Generated by scripts/site/build-site.mjs — safe to delete.\n');
  for (const [relPath, content] of files) {
    const dest = path.join(out, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  process.stdout.write(`build-site: wrote ${files.size} files to ${rel(out)}\n`);
  process.exit(0);
}

main();
