'use strict';

// Link and slug resolution for the user-docs page set (user-docs/nav.json).
// Shared by the in-app help generator (generate-help.js), the site renderer
// (scripts/site/build-site.mjs) and the help scenarios.
// Algorithm doc: docs/knowledgebase/algorithms/user-docs-links.md (`user-docs-links`).
//
// Pure: no I/O except loadNav, which reads nav.json. CommonJS, Node built-ins only.

const fs = require('fs');
const path = require('path');

const EXTERNAL_RE = /^(?:https?:|mailto:)/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Inline link / image: `](href)` or `](<href>)`, with an optional title.
const INLINE_RE = /\]\(\s*(?:<([^>\n]*)>|([^\s)<]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/dg;
// Reference definition: `[label]: href` (footnotes `[^1]:` are not links).
const REF_DEF_RE = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/d;

function toPosix(p) {
  return p.split(path.sep).join('/').split('\\').join('/');
}

function loadNav(repoRoot) {
  const docsDir = path.join(repoRoot, 'user-docs');
  const sections = JSON.parse(fs.readFileSync(path.join(docsDir, 'nav.json'), 'utf8'));
  const pages = [];
  for (const section of sections) {
    for (const article of section.articles) {
      pages.push({
        slug: article.slug,
        title: article.title,
        downloadable: article.downloadable === true,
        section: section.section,
        file: path.resolve(docsDir, article.source || `${article.slug}.md`),
      });
    }
  }
  return { sections, pages };
}

function resolveLink(href, fromFile, nav) {
  const h = String(href).trim();
  if (EXTERNAL_RE.test(h)) return { kind: 'external' };
  if (h.startsWith('#')) return { kind: 'anchor', anchor: h.slice(1) };
  if (h === '' || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('/')) return { kind: 'unresolved' };
  const hashAt = h.indexOf('#');
  const pathPart = hashAt === -1 ? h : h.slice(0, hashAt);
  const anchor = hashAt === -1 ? null : h.slice(hashAt + 1);
  if (pathPart === '' || pathPart.includes('?')) return { kind: 'unresolved' };
  let decoded;
  try {
    decoded = decodeURI(pathPart);
  } catch {
    return { kind: 'unresolved' };
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(fromFile)), decoded));
  for (const page of nav.pages) {
    if (path.posix.normalize(toPosix(page.file)) === target) {
      return { kind: 'page', slug: page.slug, anchor };
    }
  }
  return { kind: 'unresolved' };
}

// Replaces inline code spans with spaces of the same length, so offsets stay valid.
function maskInlineCode(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    let run = 1;
    while (line[i + run] === '`') run++;
    const ticks = '`'.repeat(run);
    let close = -1;
    let search = i + run;
    while (search < line.length) {
      const at = line.indexOf(ticks, search);
      if (at === -1) break;
      let end = at + run;
      while (line[end] === '`') end++;
      if (end - at === run) {
        close = at;
        break;
      }
      search = end;
    }
    if (close === -1) {
      out += ticks;
      i += run;
      continue;
    }
    out += ' '.repeat(close + run - i);
    i = close + run;
  }
  return out;
}

// Every link href with its [start, end) offsets in `markdown`.
function scanLinks(markdown) {
  const result = [];
  const lineRe = /[^\n]*(?:\n|$)/g;
  let fence = null;
  let offset = 0;
  for (const m of markdown.matchAll(lineRe)) {
    const raw = m[0];
    if (raw === '') break;
    const line = raw.replace(/\r?\n$/, '');
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length &&
          line.trim() === fenceMatch[1]) {
        fence = null;
      }
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else {
      const masked = maskInlineCode(line);
      const def = REF_DEF_RE.exec(masked);
      if (def) {
        const g = def[1] !== undefined ? 1 : 2;
        result.push({ href: def[g], start: offset + def.indices[g][0], end: offset + def.indices[g][1] });
      }
      for (const link of masked.matchAll(INLINE_RE)) {
        const g = link[1] !== undefined ? 1 : 2;
        result.push({ href: link[g], start: offset + link.indices[g][0], end: offset + link.indices[g][1] });
      }
    }
    offset += raw.length;
  }
  return result.sort((a, b) => a.start - b.start);
}

function findLinks(markdown) {
  return scanLinks(markdown).map((l) => l.href);
}

function rewritePageLinks(markdown, fromFile, nav) {
  let out = markdown;
  const links = scanLinks(markdown);
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const res = resolveLink(link.href, fromFile, nav);
    if (res.kind !== 'page') continue;
    const wanted = res.anchor === null ? `${res.slug}.md` : `${res.slug}.md#${res.anchor}`;
    if (link.href === wanted) continue;
    out = out.slice(0, link.start) + wanted + out.slice(link.end);
  }
  return out;
}

module.exports = { loadNav, resolveLink, findLinks, rewritePageLinks };
