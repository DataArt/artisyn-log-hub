// Page layout of the Log Hub static site (impl-plan DD-19a, DD-20).
// Used by scripts/site/build-site.mjs. Pure string building, no I/O.
//
// Every URL the layout emits is relative (prefix `../` × depth), so the site works under any base
// path (GitHub Pages serves it under /artisyn-log-hub/) and from a plain static server.
// The one exception is 404.html (`page({ notFound: true })`): GitHub Pages serves it for a miss at
// any depth, so a relative prefix cannot work there and every URL it emits is absolute (SITE_URL).
// ESM because its only caller is ESM (unified/remark are ESM-only).

export const SITE_URL = 'https://dataart.github.io/artisyn-log-hub/';
export const REPO_URL = 'https://github.com/DataArt/artisyn-log-hub';
export const RELEASES_URL = `${REPO_URL}/releases`;

export const SITE_NAME = 'Artisyn Log Hub';

/** Link-preview image (Open Graph); the deck and the S-SITE-01 scenario hand-copy these values. */
export const OG_IMAGE_URL = `${SITE_URL}assets/og-image.png`;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_ALT = 'Artisyn Log Hub: It ran alone for 10 minutes, cost $8 and shipped the feature. All good? Quality, cost, speed, autonomy, safety';

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

/**
 * Absolute canonical URL of an output file (path relative to the site root, `/` or `\`).
 * `index.html` → SITE_URL, `<dir>/index.html` → SITE_URL + `<dir>/`, anything else → SITE_URL + path.
 */
export function canonicalUrl(outPath) {
  const p = String(outPath).replace(/\\/g, '/');
  if (p === 'index.html') return SITE_URL;
  if (p.endsWith('/index.html')) return SITE_URL + p.slice(0, -'index.html'.length);
  return SITE_URL + p;
}

/** sitemap.xml (protocol 0.9) listing `urls`, sorted, with only `<loc>` per URL. */
export function sitemapXml(urls) {
  const locs = [...urls].sort().map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}</urlset>\n`;
}

/** Head tags after <title>: SEO + link-preview + icons for an indexable page, noindex + icons for 404. */
function headMeta(prefix, fullTitle, path, description, notFound) {
  const icons = `<link rel="icon" href="${escapeHtml(prefix)}assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${escapeHtml(prefix)}assets/apple-touch-icon.png">`;
  if (notFound) return `<meta name="robots" content="noindex">\n${icons}`;
  const t = escapeHtml(fullTitle);
  const d = escapeHtml(description);
  const c = escapeHtml(canonicalUrl(path));
  return `<meta name="description" content="${d}">
<link rel="canonical" href="${c}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${c}">
<meta property="og:image" content="${escapeHtml(OG_IMAGE_URL)}">
<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
${icons}`;
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
  items.push(navLink(`${prefix}questions.html`, 'FAQ', activeSection === 'questions'));
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
    return `<div class="docs-group"><p class="docs-group-title">${escapeHtml(sec.section)}</p><ul>${links}</ul></div>`;
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

/** Mermaid (pinned, SRI) for pages with a ```text diagram=<name> block; site-only, the app never loads it. */
export const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js';
const MERMAID_SRI = 'sha384-8xUhuLNMjW/cI2Dacg3DR4WliYznvIg0LVG1stctThKD/YVrJFI9TNCFxft5NYgp';

function diagramScripts(prefix) {
  return `<script src="${MERMAID_URL}" integrity="${MERMAID_SRI}" crossorigin="anonymous" defer></script>
<script src="${prefix}assets/diagrams.js" defer></script>
`;
}

/**
 * Full HTML document.
 * @param {object} o
 * @param {string} o.title        page title (without the site name)
 * @param {number} o.depth        directory depth of the output file below the site root
 * @param {{sections: {section: string, articles: {slug: string, title: string}[]}[]}} o.nav
 * @param {string} o.activeSection 'home' | 'features' | 'questions' | 'deck' | a nav.json section name
 * @param {string} o.body          trusted HTML of the main content
 * @param {string} [o.activeSlug]  docs page slug; when set the three-column docs layout is used
 * @param {{depth: number, id: string, text: string}[]} [o.toc]  h2/h3 entries (shown when ≥ 3)
 * @param {{prev?: {slug: string, title: string}, next?: {slug: string, title: string}}} [o.prevNext]
 * @param {boolean} [o.diagrams]   load Mermaid + diagrams.js
 * @param {string} [o.path]        POSIX output path below the site root (`docs/<slug>.html`); required
 *                                 unless `notFound` — gives the canonical / og:url
 * @param {string} [o.description] meta / og description (50–160 chars); required unless `notFound`
 * @param {boolean} [o.notFound]   the 404 page: noindex, no canonical/og tags, every URL absolute (SITE_URL)
 */
export function page({ title, depth, nav, activeSection, body, activeSlug, toc, prevNext, diagrams, path, description, notFound }) {
  const prefix = notFound ? SITE_URL : prefixFor(depth);
  // A title that already starts with the site name (Home) is used as is.
  const fullTitle = !title ? SITE_NAME : title.startsWith(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
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
${headMeta(prefix, fullTitle, path, description, notFound)}
<link rel="stylesheet" href="${prefix}assets/theme.css">
<script src="${prefix}assets/site.js" defer></script>
${diagrams ? diagramScripts(prefix) : ''}</head>
<body class="${activeSlug ? 'page-docs' : `page-${escapeHtml(activeSection)}`}">
<a class="skip-link" href="#main">Skip to content</a>
${topNav(prefix, nav, activeSection)}
${main}
${footer(prefix)}
</body>
</html>
`;
}
