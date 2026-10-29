// Page layout of the Log Hub static site (impl-plan DD-19a, DD-20).
// Used by scripts/site/build-site.mjs. Pure string building, no I/O.
//
// Every URL the layout emits is relative (prefix `../` × depth), so the site works under any base
// path (GitHub Pages serves it under /artisyn-log-hub/) and from a plain static server.
// ESM because its only caller is ESM (unified/remark are ESM-only).

export const SITE_URL = 'https://dataart.github.io/artisyn-log-hub/';
export const REPO_URL = 'https://github.com/DataArt/artisyn-log-hub';
export const RELEASES_URL = `${REPO_URL}/releases`;

export const SITE_NAME = 'Artisyn Log Hub';

/** Top-nav labels for nav.json sections (sections not listed here stay out of the top nav). */
const SECTION_LABELS = [
  ['Get started', 'Get started'],
  ['Configuration', 'Configuration'],
  ['Using Log Hub', 'Using Log Hub'],
  ['Data and security', 'Data & security'],
];

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Relative prefix from a page at `depth` (0 = site root) back to the site root. */
export function prefixFor(depth) {
  return '../'.repeat(depth);
}

export function docHref(prefix, slug) {
  return `${prefix}docs/${slug}.html`;
}

function navLink(href, label, active, extra = '') {
  const current = active ? ' aria-current="page"' : '';
  return `<li><a href="${escapeHtml(href)}"${current}${extra}>${escapeHtml(label)}</a></li>`;
}

function topNav(prefix, nav, activeSection) {
  const items = [
    navLink(`${prefix}index.html`, 'Home', activeSection === 'home'),
    navLink(`${prefix}features.html`, 'Features', activeSection === 'features'),
  ];
  for (const [section, label] of SECTION_LABELS) {
    const sec = nav.sections.find((s) => s.section === section);
    if (!sec || sec.articles.length === 0) continue;
    items.push(navLink(docHref(prefix, sec.articles[0].slug), label, activeSection === section));
  }
  items.push(navLink(`${prefix}deck/index.html`, 'Deck', activeSection === 'deck'));
  items.push(navLink(REPO_URL, 'GitHub ↗', false, ' rel="noopener noreferrer"'));
  return `<header class="site-header">
  <a class="site-brand" href="${prefix}index.html">${escapeHtml(SITE_NAME)}</a>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-menu">Menu</button>
  <nav class="site-nav" id="site-menu" aria-label="Main">
    <ul>${items.join('')}</ul>
  </nav>
</header>`;
}

function sidebar(prefix, nav, activeSlug) {
  const groups = nav.sections.map((sec) => {
    const links = sec.articles
      .map((a) => navLink(docHref(prefix, a.slug), a.title, a.slug === activeSlug))
      .join('');
    return `<div class="docs-group"><h2 class="docs-group-title">${escapeHtml(sec.section)}</h2><ul>${links}</ul></div>`;
  });
  return `<aside class="docs-sidebar" aria-label="Documentation">${groups.join('')}</aside>`;
}

function tocBlock(toc) {
  if (!toc || toc.length < 3) return '';
  const items = toc
    .map((t) => `<li class="toc-h${t.depth}"><a href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a></li>`)
    .join('');
  return `<nav class="docs-toc" aria-label="On this page"><h2 class="docs-toc-title">On this page</h2><ul>${items}</ul></nav>`;
}

function prevNextBlock(prefix, prevNext) {
  if (!prevNext || (!prevNext.prev && !prevNext.next)) return '';
  const prev = prevNext.prev
    ? `<a class="prev" rel="prev" href="${docHref(prefix, prevNext.prev.slug)}">← ${escapeHtml(prevNext.prev.title)}</a>`
    : '<span></span>';
  const next = prevNext.next
    ? `<a class="next" rel="next" href="${docHref(prefix, prevNext.next.slug)}">${escapeHtml(prevNext.next.title)} →</a>`
    : '<span></span>';
  return `<nav class="docs-prevnext" aria-label="Previous and next page">${prev}${next}</nav>`;
}

function footer(prefix) {
  return `<footer class="site-footer">
  <span>MIT</span> ·
  <a href="${REPO_URL}" rel="noopener noreferrer">GitHub</a> ·
  <a href="${RELEASES_URL}" rel="noopener noreferrer">Releases</a> ·
  <a href="${docHref(prefix, 'changelog')}">Changelog</a> ·
  <span>not affiliated with Anthropic</span>
</footer>`;
}

/**
 * Full HTML document.
 * @param {object} o
 * @param {string} o.title        page title (without the site name)
 * @param {number} o.depth        directory depth of the output file below the site root
 * @param {{sections: {section: string, articles: {slug: string, title: string}[]}[]}} o.nav
 * @param {string} o.activeSection 'home' | 'features' | 'deck' | a nav.json section name
 * @param {string} o.body          trusted HTML of the main content
 * @param {string} [o.activeSlug]  docs page slug; when set the three-column docs layout is used
 * @param {{depth: number, id: string, text: string}[]} [o.toc]  h2/h3 entries (shown when ≥ 3)
 * @param {{prev?: {slug: string, title: string}, next?: {slug: string, title: string}}} [o.prevNext]
 */
export function page({ title, depth, nav, activeSection, body, activeSlug, toc, prevNext }) {
  const prefix = prefixFor(depth);
  const fullTitle = title && title !== SITE_NAME ? `${title} — ${SITE_NAME}` : SITE_NAME;
  const main = activeSlug
    ? `<div class="docs-layout">
${sidebar(prefix, nav, activeSlug)}
<main class="docs-content" id="main"><article class="doc">${body}</article>${prevNextBlock(prefix, prevNext)}</main>
${tocBlock(toc)}
</div>`
    : `<main class="page-content" id="main">${body}</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${prefix}assets/theme.css">
<script src="${prefix}assets/site.js" defer></script>
</head>
<body class="${activeSlug ? 'page-docs' : `page-${escapeHtml(activeSection)}`}">
<a class="skip-link" href="#main">Skip to content</a>
${topNav(prefix, nav, activeSection)}
${main}
${footer(prefix)}
</body>
</html>
`;
}
