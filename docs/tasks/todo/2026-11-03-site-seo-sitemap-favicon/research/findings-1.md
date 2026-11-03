**Requirements summary**
Add SEO basics to the GitHub Pages site built by `npm run build:site`. The work covers the layout pages (Home, Features, Questions), all 24 `user-docs/nav.json` docs pages and the hand-written reveal.js deck. Seven things are needed:
- `sitemap.xml` with the 0.9 namespace and escaped `<loc>`, no lastmod/changefreq/priority. It lists 28 URLs (24 docs + home + features + questions + deck) and never `404.html`.
- One canonical-URL helper shared by the sitemap, `<link rel="canonical">` and `og:url`. Root → `SITE_URL`, deck → `SITE_URL+'deck/'`, anything else → `SITE_URL+path`.
- A real favicon: a committed copy of `client/public/favicon.svg` at `site/assets/favicon.svg`. The build exits 1 if it is missing.
- A per-page `<meta name="description">` of 50–160 chars, unique per page. Sources: a new `description` field in `nav.json` for docs, a 4th tuple element in `build-site.mjs` for Home/Features/Questions, and the existing meta for the deck. A missing or duplicate one exits 1.
- `og:site_name/title/description/url/image` and `twitter:card=summary_large_image`. `og:image` is a 1200×630 PNG of the OTEL cost Sankey.
- `apple-touch-icon`: a 180×180 PNG rendered from the SVG.
- A `404.html` with absolute `SITE_URL` URLs, `noindex`, no canonical and no OG tags.

There is also a heading/alt-text pass. The deck's tags are hand-edited using `{{site:url}}`. Verification is new steps in `@S-SITE-01`. robots.txt and JSON-LD were rejected (reasons are in Notes).

**Wireframes**
- `wireframes/site-404-page.svg` shows:
  - the tab title "Page not found — Artisyn Log Hub";
  - `<link rel="icon" href="{abs}/assets/favicon.svg" type="image/svg+xml">`;
  - the same header and footer as `page()`, with no `aria-current` on any nav item;
  - an eyebrow "// 404 · PAGE NOT FOUND", the h1 "This page does not exist." and the copy "The link may be old, or the page moved when the docs were reorganised. Start from the home page or the documentation.";
  - three buttons HOME / GET STARTED / QUESTIONS that reuse the hero `button button-primary` / `button` styles;
  - no new scripts or fonts.
- `wireframes/site-link-preview-card.svg` maps tags to card fields: site name ← `og:site_name`=`SITE_NAME`, title ← `og:title`/`twitter:title` = page `<title>`, description ← meta description, link ← `og:url` = canonical. Its note "og:image optional / twitter:card=summary" is outdated: requirements now settle on `summary_large_image` and `og-image.png`.

**Knowledgebase**
- `docs/knowledgebase/user-docs-and-site.md` — the conventions to follow:
  - The site renderer is ESM `.mjs` with sync I/O. Exit codes: 0 written, 1 validation, 2 args.
  - All errors are collected and printed before anything is written.
  - Every layout URL is relative (`../` × depth). The 404 page is a deliberate exception.
  - `nav.json` shape is `{section, articles:[{slug,title,downloadable?,source?}]}`, mirrored by the client `HelpArticle` type and `links.d.ts NavArticle`.
  - No front matter in `user-docs/*.md`. Hook docs are edited only as hook.
  - Screenshot rule: real screens of the demo repository, content pane only, English UI, **no e-mail, user name or local path**.
  - The CI site check is `npm run build:site -- --out tmp/site-check`.
  - The KB's assets table and its Screenshots table need new rows (favicon, og-image, apple-touch-icon, 404, sitemap).
  - The KB nav-section table is stale. It omits `all-views`, `otel-admin-guide`, `otel-tab` and `otel-architecture`, but `nav.json` has 24 articles.
- `docs/knowledgebase/algorithms/user-docs-links.md` with `docs/algorithm-examples/user-docs-links.json`, table-tested by `scripts/__tests__/user-docs-links.algo.test.js`. It covers `resolveLink` only. `loadNav` is I/O, so adding `description` to it needs no new rows unless the plan makes it an algorithm.
- `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md:623-645` is the S-SITE-01 spec. Its step list must get the new steps.

**Existing patterns**
- `scripts/site/layout.mjs:8-12` exports `SITE_URL`, `REPO_URL`, `RELEASES_URL` and `SITE_NAME`. The new canonical helper belongs here.
- `layout.mjs:22` is `escapeHtml`. Reuse it for meta and attribute values, and for `<loc>`: it escapes `& < > " '`, which is valid XML too.
- `layout.mjs:32` is `prefixFor(depth)`. All nav, footer and asset URLs are `${prefix}…` (lines 47-57, 59, 101, 145-146). For the 404 page, letting `prefix` be `SITE_URL` makes every link absolute with no other change.
- `layout.mjs:128-156`, the `page({...})` head:
  - line 144 `<link rel="icon" href="data:,">` is the one to replace;
  - line 130 builds `fullTitle` as `title — SITE_NAME`, or just `SITE_NAME` for Home. `og:title` must equal this string;
  - line 148 sets the body class to `page-${activeSection}`. That gives the 404 page `page-404` (or similar).
- `scripts/site/build-site.mjs:264-281` is the docs page loop. It has `p.slug`, `p.title` and `p.section`; add the description and path here. Output key is `path.join('docs', …)`, which gives **backslashes on Windows**. Sitemap and canonical code must POSIX-ize paths, or pass the path explicitly.
- `build-site.mjs:285` is the `[name, title, activeSection]` tuple loop. Add the 4th element here.
- `build-site.mjs:298-315` copies the deck and assets. The deck HTML goes through `fillAll` (line 99), so `{{site:url}}` works in its head. The new favicon, og-image and apple-touch-icon in `site/assets/` are copied automatically. The missing-favicon check must be explicit, because line 300 only errors for the deck dir.
- `build-site.mjs:318-330` reports errors then writes. Add the missing/duplicate description errors to the same `errors` array. The sitemap goes in as `files.set('sitemap.xml', …)` after the pages exist.
- `scripts/user-docs/links.js:27-43`, `loadNav`, copies only `slug`, `title`, `downloadable`, `section` and `file` into `pages`. Either add `description` there or read `nav.sections[].articles[].description` directly.
- `scripts/user-docs/links.d.ts:4-27`, `NavArticle` and `NavPage`: add `description?: string`.
- `client/src/viewer/help/articles/index.ts:3-22`, `HelpArticle`: add the optional field. The JSON import is assigned to `HelpSection[]`, so the extra key alone would not fail tsc.
- `client/src/viewer/pages/map/nav-tree.ts:97-100`, `NavHelpSection`, is structural. No change is needed.
- `site/deck/index.html:6-7` has the title "Why Log Hub — Artisyn Log Hub deck" and a description of exactly 120 chars, so it is already within 50–160. Line 20 has `<link rel="icon" href="data:,">`. The new `og:title` must equal this `<title>`, not the `X — SITE_NAME` form.
- `client/public/favicon.svg` is 360 bytes, viewBox 32×32. Rendering it at 180×180 is a 5.625× scale.
- `og:image` aspect is 1200:630 = 40:21 (≈1.905).
- `site/pages/home.html`, heading hygiene finding: the h1 (line 4) is followed by `<h3>` steps inside the figure (lines 26/47/57/66) before the `<h2>` cards (81/87/93), so h1→h3 skips a level.
- `layout.mjs:72` renders the sidebar `h2.docs-group-title` before the article `h1` in DOM order. `features.html`, `questions.html` and the deck already have alt text on every `<img>`. Each docs `.md` has exactly one H1 and no front matter (checked over all 24).
- `tests/scenarios/platform/s-site-01.spec.ts`:
  - step 0 (180) builds into `tmp/scenarios/site`;
  - `startSiteServer` (60-91) serves only real files and answers plain text for a miss, so it does **not** serve `404.html`;
  - `crawl` (110-152) follows `href`/`src`, so it will fetch the relative favicon and apple-touch-icon and check for 200. Absolute canonical URLs land in `external` and must be https (line 209);
  - `CONTENT_TYPES` (35) already has `.svg` and `.png`. It lacks `.xml`, which needs adding to serve the sitemap;
  - step 13 (404-410) fails on any request that is not local, `data:` or versioned CDN. This step and the `data:` filter in `crawl` (127) stay compatible;
  - step 14 (412) greps only `TEXT_EXT` files, so PNGs are not checked for e-mails.
- `tests/scenarios/helpers/help-nav.ts` has `helpPages` and `REPO_ROOT`. Use them to build the expected sitemap set.
- `.github/workflows/pages.yml:16-25` already triggers on `site/**`, so the new assets need no workflow change. `client/**` is not an input, which is why the favicon is committed as a copy.
- `client/src/viewer/pages/repository/otel/OtelCostFlow.tsx` with `otel-cost-flow-layout.ts:43,51`: in a team context the columns are model → **user → branch**. The user node label is `row.userEmail`. It is rendered from `RepoOtelTab.tsx:322-330` and `TeamOtelTab.tsx`.
- Screenshot workflow precedent is in `docs/tasks/done/2026-11-02-ux-navigation-overhaul/impl-plan.md:767-771`:
  - start the dev server and client;
  - import the demo repository export from local prod into a neutral identity;
  - capture with Playwright via the `use-playwright` skill into `tmp/site-shots/`, at least 3 framings;
  - pick the winner with a `fable` judge.

**Open gaps**
1. **Privacy conflict in `og:image`.** The per-team Sankey labels its user column with e-mails, which breaks the KB screenshot rule. The plan must choose between a private-repo view (model → branch, no user column), masked or fictional identities in the demo import, or cropping. It also has to decide whether the demo export has any OTEL data at all; nothing confirms it does.
2. **Testing the 404 page.** Its absolute `https://dataart.github.io/...` URLs would be foreign requests that fail step 13 and need internet. The local server also does not serve `404.html` for misses. A design is needed, for example:
   - a fallback route in `startSiteServer` that serves `404.html` for misses under `BASE_PATH`;
   - `page.route` mapping `SITE_URL` to the local base;
   - excluding those URLs from step 13 or running the 404 step after it.
   Note that routed requests still fire the context `request` event.
3. **Checking sitemap XML well-formedness.** The repo has no XML parser dependency. Options are `DOMParser` via `page.evaluate` with a `parsererror` check, or a regex plus namespace check.
4. **Making `page()` emit absolute URLs for 404.** There is no existing override for `prefix`. One is needed so the nav, stylesheet, script and favicon all become `SITE_URL`-based.
5. **Rendering apple-touch-icon.** No script exists; `@playwright/test` is the only option at root. The plan must decide whether it is a one-off manual render (only the PNG committed) or a committed script.
6. **Favicon drift.** Nothing checks that `site/assets/favicon.svg` stays byte-equal to `client/public/favicon.svg`. Not required; the plan decides whether to add a check.
7. **Writing 27 new descriptions.** 24 docs pages plus Home, Features and Questions each need a unique 50–160 char description. The deck already has one.
8. **Where `og:image` is referenced.** It is an absolute `SITE_URL` URL, so the crawl will not fetch it. The scenario must check the file in the output folder directly.
