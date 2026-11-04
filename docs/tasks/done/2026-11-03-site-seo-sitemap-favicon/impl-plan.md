# Implementation plan — Site SEO: sitemap, favicon and missing basics

## TL;DR

- Static site only (`scripts/site/`, `site/`, `user-docs/nav.json`): no server, API, DB or hook change; the app and in-app help are untouched apart from an optional `description` field in nav types. The client imports `nav.json` directly, so the 24 descriptions ride along in the client bundle as unused data.
- `scripts/site/layout.mjs` gains `canonicalUrl(outPath)` and `sitemapXml(urls)`. `page()` gains `path`, `description` and `notFound` arguments and emits the description, canonical, Open Graph, Twitter card, favicon and apple-touch-icon tags.
- `scripts/site/build-site.mjs` now also writes `sitemap.xml` and `404.html`. It fails with exit 1 on a missing favicon, a missing, out-of-range or duplicate description, or an off-site URL.
- `user-docs/nav.json` has a new `description` per article. It is mirrored as `description?: string` in `scripts/user-docs/links.js` / `links.d.ts` and the client `HelpArticle` type.
- Three new committed binary/text assets: `site/assets/favicon.svg` (copy of `client/public/favicon.svg`), `site/assets/apple-touch-icon.png` (180×180) and `site/assets/og-image.png` (1200×630 OTEL Sankey with masked user labels, Design Decision 9).
- New page source `site/pages/404.html`. The deck `<head>` is hand-edited. Heading hygiene: Home insight steps h3→h2, docs sidebar group titles h2→p.
- Tests: four new steps (15–18) in the existing scenario `@S-SITE-01`. Its static server learns to serve `404.html` for misses the way GitHub Pages does. No new test files.

## Reference

Requirements: [requirements.md](requirements.md) (GH-95). Research archive: `research/findings-1.md`.

## Design Decisions

1. **Canonical helper.** `canonicalUrl(outPath)` in `layout.mjs` first converts `\` to `/`. Then `index.html` → `SITE_URL`, a path ending in `/index.html` → `SITE_URL + <dir>/` (so `deck/index.html` → `SITE_URL + 'deck/'`), and anything else → `SITE_URL + outPath`. The sitemap, `<link rel="canonical">` and `og:url` all use it.
2. **Output paths are POSIX.** The build passes `path` to `page()` as a POSIX string (`docs/<slug>.html`, `index.html`, `features.html`, `questions.html`). The `files` map keeps its `path.join` keys. Anything that reads those keys for the sitemap goes through `canonicalUrl`, which normalises them.
3. **`page()` arguments.** `path` (string) and `description` (string) are required for indexable pages. `notFound: true` marks the 404 page. With `notFound`, the prefix is `SITE_URL` instead of `prefixFor(depth)`, so the nav, footer, stylesheet, script, favicon and Changelog links all become absolute with no other code change.
4. **Head tags, indexable page**, in this order after `<title>` (all values go through `escapeHtml`; `T` = `fullTitle`, `D` = description, `C` = `canonicalUrl(path)`). `layout.mjs` exports the og-image constants once: `OG_IMAGE_URL = SITE_URL + 'assets/og-image.png'`, `OG_IMAGE_WIDTH = 1200`, `OG_IMAGE_HEIGHT = 630` and `OG_IMAGE_ALT = 'Log Hub cost flow: model to user to branch'`. The deck hand-copies the same values, and the scenario's own constants must match them.
   - `<meta name="description" content="D">`
   - `<link rel="canonical" href="C">`
   - `<meta property="og:type" content="website">`
   - `<meta property="og:site_name" content="${SITE_NAME}">`
   - `<meta property="og:title" content="T">`
   - `<meta property="og:description" content="D">`
   - `<meta property="og:url" content="C">`
   - `<meta property="og:image" content="${OG_IMAGE_URL}">`
   - `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`
   - `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`
   - `<meta property="og:image:alt" content="${OG_IMAGE_ALT}">`
   - `<meta name="twitter:card" content="summary_large_image">`
   - `<link rel="icon" href="{prefix}assets/favicon.svg" type="image/svg+xml">`
   - `<link rel="apple-touch-icon" href="{prefix}assets/apple-touch-icon.png">`
5. **Head tags, 404 page.** `<meta name="robots" content="noindex">`, then only the favicon and apple-touch-icon links with absolute `SITE_URL` hrefs. No description, canonical or `og:*`/`twitter:*`. The title is `Page not found — Artisyn Log Hub` (`title: 'Page not found'`). `activeSection: '404'`, so no nav item is `aria-current` and the body class is `page-404`.
6. **Description rules**, checked in `build-site.mjs` over every indexable page:
   - A description is a raw string (counted before escaping) of 50–160 characters (`.length`).
   - It must be unique across the site.
   - Authoring guideline, not checked by the build: say in English plain text (no Markdown, e-mail or path) what the page helps the reader do, written after reading the article. Scenario step 14 still greps the output for e-mails and paths.
   - Each violation is one line in the existing `errors` array, e.g. `user-docs/nav.json: install-hook: description missing`, `…: description is 42 chars (50–160)`, `…: description duplicates docs/x.html`. For the deck, `site/deck/index.html: <meta name="description"> missing`.
7. **Layout-page descriptions** go in the tuple's 4th element. Lengths were computed:
   - home (139): `Self-hosted analytics for Claude Code: see why a session cost what it did, whether your harness works, and what AI coding brings your team.`
   - features (149): `Eight questions Log Hub answers about Claude Code sessions: cost drivers, harness health, real impact, team trends, anomalies and knowledge-base use.`
   - questions (142): `Answers to the questions teams ask before adopting Log Hub: what data it collects, where it is stored, who can see it and how long it is kept.`
8. **Deck metadata.** The build reads the deck's `<title>` and `<meta name="description">` from each deck `.html` after `fillAll` (the filled output, the same text the scenario checks) with a regex (`/<title>([^<]*)<\/title>/`, `/<meta name="description" content="([^"]*)">/`) and uses them in the description validation. The deck's own tags (Design Decision 4 set, with prefix `../` for icons and `{{site:url}}` for canonical, og:url and og:image) are hand-written in `site/deck/index.html`. Its `og:title` is `Why Log Hub — Artisyn Log Hub deck` and must stay equal to its `<title>`. Its canonical is `{{site:url}}deck/`, and `og:description` is its existing description (120 chars, within 50–160).
9. **og-image capture.** This is a one-off manual capture following the screenshot precedent (`docs/tasks/done/2026-11-02-ux-navigation-overhaul/impl-plan.md:767-771`):
   - Setup: start the dev server and client (CLAUDE.md Environment). Export the demo repository from local prod and import it into the dev app via Settings › Import/Export under the local test identity (the same flow as the screenshot precedent). The repository must belong to a team, so that the OTEL tab opens in team context (the `teamId` query parameter is set). Capture with Playwright MCP (`use-playwright` skill).
   - Target: the repository OTEL tab's team-context Sankey (`OtelCostFlow.tsx`, columns model → user → branch). Viewport 1200×630, clipped to the Sankey card. At least 3 framings go into `tmp/site-shots/`; pick one.
   - The user column shows `row.userEmail` (`otel-cost-flow-layout.ts:52`), which the KB screenshot rule forbids. Before loading the tab, `page.route('**/api/v1/repositories/*/otel/facts?**')` fetches the real response, maps each distinct non-null `userEmail` in `flows[]` and `sessions[]` (`RepoOtelFactsResponse`, `client/src/models/repositories.ts:1178`) to `Developer A`, `Developer B`, … in order of first appearance, and fulfils the modified JSON. Only the labels change; costs and shape stay real.
   - Node labels come from `otelFlowValue` only (model, userEmail, branch), so no other identity field reaches the Sankey. Branch names must also contain no person's name; if one does, pick another period or framing.
   - If the imported demo data has no OTEL flows rows, stop and ask the user for a data source. Do not invent data.
10. **apple-touch-icon render.** A one-off Playwright MCP render: a 180×180 viewport whose page is `client/public/favicon.svg` inline at `width/height=180` on the SVG's own background, screenshotted to `site/assets/apple-touch-icon.png`. No render script is committed; the KB records how to regenerate it.
11. **Favicon source of truth.** `client/public/favicon.svg` is the source. The site keeps a byte-identical committed copy because Pages does not build `client/`. The build fails if the copy is missing, and scenario step 17 fails if it differs from the client file.
12. **Sitemap.** `sitemapXml(urls)` returns:
    - `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    - then one `  <url><loc>${escapeHtml(u)}</loc></url>\n` per URL, sorted;
    - then `</urlset>\n`.

    The URL set is every `.html` key of `files` except `404.html`, mapped through `canonicalUrl`. A URL not starting with `SITE_URL` adds the error `sitemap: <url> is not under SITE_URL`.
13. **404 body.** `site/pages/404.html` (placeholders filled by `fillAll`) is a `<section class="not-found" aria-labelledby="nf-title">` containing:
    - the eyebrow `404 · Page not found` (`.eyebrow::before` adds `// `);
    - the h1 `This page does not exist.`;
    - a `.lead` with `The link may be old, or the page moved when the docs were reorganised. Start from the home page or the documentation.`;
    - `.actions` with three buttons: Home `{{site:url}}index.html` (`button button-primary`), Get started `{{site:url}}docs/install-server.html` and Questions `{{site:url}}questions.html` (both `button`).
14. **Heading hygiene.**
    - The Home insight-step and insight-do headings (`home.html:26,47,57,66`) become `h2`. The selectors `.insight-step h3`, `.insight-do h3` and `.insight-step h3 .step-no` (`theme.css:449-461,541`) become `h2`. They already override margin, size and colour, so the look is unchanged.
    - The docs sidebar `h2.docs-group-title` (`layout.mjs:72`) becomes `<p class="docs-group-title">` so the article `h1` is the first heading. `.docs-group-title` gains `font-weight: 600; line-height: 1.25`, which it used to get from the generic `h2` rule.
    - The TOC `h2` comes after the article and stays.
15. **Scenario 404 testing.** `startSiteServer` answers a miss under `BASE_PATH` with `root/404.html` (status 404, `text/html`) when that file exists, like GitHub Pages does.
    - Steps 15–18 are appended after step 14, inside the existing `try` block, before `finally { server.close() }`.
    - The context `request` listener records every request, routed ones included. Because step 13 has already run, step 18's routed `SITE_URL` requests are never judged foreign.
    - Step 18 uses `page.route(SITE_URL + '**')` to fulfil from `SITE_DIR` files.
    - Step 17 reads favicon statuses from the step 1 crawl result (`site.status`).
16. **Alt text.** Every `<img>` in `site/pages/*.html` already has a non-empty `alt` (checked while planning: features.html shots). The layout emits no `<img>`. The deck's `<img>` tags are re-checked in Chunk 6; any missing `alt` is added there.
17. **Placement in `build-site.mjs`.** All new rendering lives inside the existing `if (errors.length === 0) { … }` block (lines 261–316): the 404 page, the meta collection and validation, and the sitemap (last). That way their errors reach the `if (errors.length > 0) fail(...)` at line 318 before anything is written. The favicon-missing check sits next to the dataset check, before that block. `canonicalUrl`, `sitemapXml` and the `OG_IMAGE_*` constants are added to the existing `layout.mjs` import (line 39).
18. **Rejection notes (AC4).** The requirements Notes must keep these two lines:
    - "Rejected: `robots.txt` — crawlers read it only at the host root `dataart.github.io` (RFC 9309), which a project site cannot serve; the sitemap is submitted manually instead."
    - "Rejected: JSON-LD `SoftwareApplication` — without ratings/reviews Google shows no rich result; revisit if the project gets reviews."

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `user-docs/nav.json` | `description` per article | 24 articles, per Design Decision 6 |
| `scripts/user-docs/links.js` | `loadNav` copies `description` | other callers ignore it |
| `scripts/user-docs/links.d.ts` | `description?: string` on `NavArticle`, `NavPage` | |
| `client/src/viewer/help/articles/index.ts` | `description?: string` on `HelpArticle` | type mirror only, no UI use |
| `site/assets/favicon.svg` | new, verbatim copy of `client/public/favicon.svg` | Design Decision 11 |
| `site/assets/apple-touch-icon.png` | new, 180×180 | Design Decision 10 |
| `site/assets/og-image.png` | new, 1200×630 | Design Decision 9 |
| `scripts/site/layout.mjs` | `canonicalUrl`, `sitemapXml`, `page()` head and args, sidebar `p` | Design Decisions 1, 3–5, 12, 14 |
| `scripts/site/build-site.mjs` | descriptions, meta validation, favicon check, 404, sitemap | Design Decisions 2, 6–8, 12 |
| `site/pages/404.html` | new 404 body | Design Decision 13 |
| `site/pages/home.html` | h3 → h2 in insight steps | Design Decision 14 |
| `site/assets/theme.css` | `.not-found`, insight h2 selectors, `.docs-group-title` weight | Visual/UX notes |
| `site/deck/index.html` | favicon, apple-touch, canonical, og/twitter tags | Design Decision 8 |
| `tests/scenarios/platform/s-site-01.spec.ts` | 404 fallback, `.xml`, steps 15–18 | Test coverage plan |
| `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` | S-SITE-01 steps 15–18 | spec of the scenario |
| `docs/knowledgebase/user-docs-and-site.md` | assets, head tags, sitemap, 404, nav `description`, refreshed nav table | |
| `docs/tasks/todo/2026-11-03-site-seo-sitemap-favicon/wireframes/site-link-preview-card.svg` | fix the outdated "og:image optional / twitter:card=summary" note | Wireframes |
| `docs/changelog/<YYYY-MM-DD-HHmm>-site-seo-sitemap-favicon.md` | new one-line changelog entry | `changelog` skill, before push |

## Test coverage plan

Under the CLAUDE.md test policy:

- **Algorithm.** None. `user-docs-links` covers `resolveLink` only, and `loadNav` is I/O. The new layout helpers have no algorithm doc, and none is warranted for one-liners covered by the scenario.
- **API contract.** None; no route changes.
- **Scenario.** Extend `@S-SITE-01` (`tests/scenarios/platform/s-site-01.spec.ts`) with steps 15–18. Existing steps 0–14 stay unchanged and must keep passing (AC6), including step 13.
  - Step 15, sitemap (AC1): fetch `sitemap.xml` (200, `application/xml`). Parse it with `DOMParser` in `page.evaluate` and expect no `parsererror` and root `urlset` in the 0.9 namespace. The `<loc>` set must equal the canonical URLs of every built `.html` under `SITE_DIR` except `404.html`. No `lastmod`, `changefreq` or `priority`.
  - Step 16, head tags (AC4): for every crawled HTML page, deck included:
    - exactly one description of 50–160 chars, all unique;
    - canonical equals `canonical(relPath)` of its path (Design Decision 1);
    - `og:title` equals `<title>`, `og:description` equals the description, `og:url` equals the canonical;
    - `og:image` equals `OG_IMAGE_URL`, `og:image:width`/`height` are `1200`/`630`, and `og:image:alt` equals `OG_IMAGE_ALT`;
    - `og:type` is `website` and `og:site_name` is `Artisyn Log Hub`;
    - `twitter:card` is `summary_large_image`.
  - Step 17, icons (AC2): no built HTML contains `href="data:,"`. In Home's and the deck's crawled HTML, the `<link rel="icon">` href resolves (`new URL(href, pageUrl)`) to `${server.base}assets/favicon.svg`, and `site.status` of that URL is 200. The output favicon is byte-equal to `client/public/favicon.svg`. PNG IHDR sizes are 1200×630 for `og-image.png` and 180×180 for `apple-touch-icon.png`.
  - Step 18, 404 (AC4): a nested missing URL answers 404 with the 404 page, which has:
    - the title `Page not found — Artisyn Log Hub` and the `noindex` meta;
    - no canonical and no `og:` meta;
    - no `aria-current`;
    - every local `href`/`src` starting with `SITE_URL`;
    - with `SITE_URL` routed locally, `theme.css` applied (a computed style differs from the browser default) and the favicon answering 200.
- **Build fail paths** (missing favicon, bad description) are not scenario-tested. They are guarded by the build itself and the CI site check (AC5), so there is no extra test kind.

## Visual/UX notes

- **404:** `.not-found` uses `max-width: 720px; margin: 64px auto; padding: 0 16px`. It reuses `.eyebrow`, `.lead`, `.actions`, `.button` and `.button-primary`, with no new fonts or scripts. It has the same header and footer as other pages.
- **Home hero insight steps:** must look pixel-identical after the h3→h2 swap.
- **Docs sidebar group titles:** must look identical after h2→p.
- **Visual check** (`use-playwright`) of 404, Home hero and a docs page in light and dark at 1280 and 375 px.

## Wireframes

- `wireframes/site-404-page.svg`: no change.
- `wireframes/site-link-preview-card.svg`: replace the note "og:image optional / twitter:card=summary" with "og:image = assets/og-image.png (1200×630) / twitter:card = summary_large_image".

## Implementation Chunks

> **Shared machine (2026-11-03):** another Claude session is working on a PoC in parallel. The dev
> server (port 3000) and client (port 5173) are already running and belong to that session: reuse
> them, never start a second instance, and never stop or kill them (chunk 2's "stop the dev
> processes" covers only processes this run started itself). Do not touch `docs/pocs/` or files
> outside this task's scope.

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Nav metadata | 4 | the build in chunk 4 needs the descriptions |
| 2 | Static assets | 4 | favicon must exist before chunk 4's check; og-image needs dev app |
| 3 | Layout helpers | 6 | `layout.mjs` only |
| 4 | Site build | 8 | uses chunk 1–3; includes the 404 source so the build runs |
| 5 | Site content and styles | 5 | hygiene, deck head; visual check |
| 6 | Docs and hygiene checks | 6 | KB, wireframe note, alt text, Notes, changelog |
| 7 | Scenario S-SITE-01 | 8 | last; covers AC1, AC2, AC4, AC6 |

### Chunk 1 — Nav metadata
- [ ] Add a `description` string to each of the 24 articles in `user-docs/nav.json` per Design Decision 6; check lengths and uniqueness with a node one-off.
- [ ] `scripts/user-docs/links.js` `loadNav`: add `description: typeof article.description === 'string' ? article.description : undefined` to each pushed page.
- [ ] `scripts/user-docs/links.d.ts`: add `description?: string` to `NavArticle` and `NavPage`.
- [ ] `client/src/viewer/help/articles/index.ts`: add `description?: string` to `HelpArticle`; no UI use.

### Chunk 2 — Static assets
- [ ] Copy `client/public/favicon.svg` byte-for-byte to `site/assets/favicon.svg` (Node `fs.copyFileSync`).
- [ ] Render `site/assets/apple-touch-icon.png` (180×180) per Design Decision 10.
- [ ] Start the dev server (`npm run start:dev` in `server/`) and client (`bun run dev` in `client/`) in the background. Import the demo export, then capture `site/assets/og-image.png` (1200×630) per Design Decision 9, keeping raw framings in `tmp/site-shots/`.
- [ ] Verify both PNGs: read the IHDR sizes with a node one-off, and view the og-image to confirm there is no e-mail, user name or local path. Stop the dev processes and confirm no orphans.

### Chunk 3 — Layout helpers
- [ ] `layout.mjs`: export `canonicalUrl(outPath)` per Design Decision 1 and the `OG_IMAGE_*` constants per Design Decision 4.
- [ ] `layout.mjs`: export `sitemapXml(urls)` per Design Decision 12 (sorted, `escapeHtml` on each `<loc>`).
- [ ] `layout.mjs` `page()`: accept `path`, `description`, `notFound`. The prefix is `SITE_URL` when `notFound`, else `prefixFor(depth)`. Update the JSDoc.
- [ ] `layout.mjs` `page()` head: replace `<link rel="icon" href="data:,">` with the Design Decision 4 tag block (indexable) or the Design Decision 5 block (`notFound`).
- [ ] `layout.mjs` `sidebar()`: render the group title as `<p class="docs-group-title">` instead of `h2` (Design Decision 14).
- [ ] `layout.mjs` header comment: add that `404.html` is the one page with absolute `SITE_URL` URLs (Design Decision 3).

### Chunk 4 — Site build
- [ ] Create `site/pages/404.html` with the body from Design Decision 13. In `build-site.mjs`, extend the `layout.mjs` import and place the new code per Design Decision 17.
- [ ] `build-site.mjs` tuple loop: add the 4th element (description) from Design Decision 7. Pass `path` (`index.html` / `<name>.html`) and `description` to `page()`.
- [ ] `build-site.mjs` docs loop: pass `path: \`docs/${p.slug}.html\`` and `description: p.description` to `page()`.
- [ ] Collect `meta` entries `{ path, source, description }` for docs and layout pages. For each deck `.html`, extract the title and description per Design Decision 8 and add an entry; a missing description goes to the `errors` line.
- [ ] Validate `meta` per Design Decision 6 (missing, length 50–160, duplicates) into `errors`.
- [ ] Before rendering, if `site/assets/favicon.svg` is missing, push `site/assets/favicon.svg: missing (copy of client/public/favicon.svg)` to `errors`.
- [ ] Render `site/pages/404.html` via `fillAll` into `files['404.html']` with `page({ title: 'Page not found', depth: 0, nav, activeSection: '404', body, notFound: true })`.
- [ ] Once all pages are in `files`, build `sitemap.xml` per Design Decision 12 with the off-site error. Update the header comment's output list and validation list (sitemap, 404, descriptions, favicon).

### Chunk 5 — Site content and styles
- [ ] `site/assets/theme.css`: add the `.not-found` block per Visual/UX notes. Rename the insight selectors (lines 449-461, 541) from `h3` to `h2`. Add `font-weight: 600; line-height: 1.25` to `.docs-group-title`.
- [ ] `site/pages/home.html`: change the four insight headings (lines 26, 47, 57, 66) from `h3` to `h2`.
- [ ] `site/deck/index.html`: replace `<link rel="icon" href="data:,">` with the Design Decision 4 tag set adapted per Design Decision 8 (icons `../assets/…`, absolute URLs via `{{site:url}}`), keeping the existing title and description.
- [ ] Run `npm run build:site` and `npm run build:site -- --out tmp/site-check`; both exit 0.
- [ ] Visual check per Visual/UX notes (`use-playwright`, served build): 404, Home hero, a docs sidebar and the deck in light and dark at 1280 and 375 px.

### Chunk 6 — Docs and hygiene checks
- [ ] Alt-text check per Design Decision 16: grep `<img` in `site/pages/*.html` and `site/deck/index.html`; add a descriptive `alt` to any image without one.
- [ ] Check that the requirements.md Notes still hold the two lines from Design Decision 18. Add a line for any other candidate rejected during implementation.
- [ ] Before the push, write `docs/changelog/<YYYY-MM-DD-HHmm>-site-seo-sitemap-favicon.md` per the `changelog` skill.
- [ ] `docs/knowledgebase/user-docs-and-site.md`:
  - add assets-table rows for `favicon.svg`, `apple-touch-icon.png`, `og-image.png`, and outputs `sitemap.xml` and `404.html`;
  - document the head tags, the `canonicalUrl` rule, the 404 absolute-URL exception and the regeneration steps for both PNGs (Design Decisions 9–11).
- [ ] Same KB file: document the nav.json `description` field (required by the site build, ignored by in-app help). Refresh the nav-section table to all 24 articles (add `all-views`, `otel-admin-guide`, `otel-tab`, `otel-architecture`).
- [ ] `wireframes/site-link-preview-card.svg`: update the outdated note per Wireframes.

### Chunk 7 — Scenario S-SITE-01
- [x] `s-site-01.spec.ts`:
  - add `'.xml': 'application/xml; charset=utf-8'` to `CONTENT_TYPES` and `.xml` to `TEXT_EXT`;
  - make `startSiteServer` answer misses under `BASE_PATH` with `root/404.html` (status 404) when it exists, per Design Decision 15.
- [x] `s-site-01.spec.ts` helpers (steps 15–18 go after step 14 inside the `try` block, per Design Decision 15):
  - `SITE_URL`, `OG_IMAGE_URL` and `OG_IMAGE_ALT` constants equal to the `layout.mjs` values;
  - `canonical(relPath)` mirroring Design Decision 1;
  - `metaContent(html, attr, key)` (all matches, decoded);
  - `pngSize(file)` reading IHDR width/height (bytes 16–23, big-endian).
- [x] Add step 15 "sitemap.xml lists every indexable page in canonical form" per Test coverage plan.
- [x] Add step 16 "every page has a unique description, canonical and matching og/twitter tags" per Test coverage plan.
- [x] Add step 17 "favicon and apple-touch-icon are real files, og-image is 1200×630" per Test coverage plan, taking favicon statuses from `site.status`.
- [x] Add step 18 "404.html: noindex, no canonical, absolute URLs, styled from a nested missing URL" per Test coverage plan and Design Decision 15.
- [x] `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` §S-SITE-01: add steps 15–18. Mention the 404 fallback in Data/environment and the untested build fail paths in "What we lose".
- [x] Run the fast set (`adlc-lh:check-health`, `finalRun: false`) and `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SITE-01"`; both pass.
